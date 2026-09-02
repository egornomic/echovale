import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import {
  deploymentPolicy,
  PRIVATE_DEPLOYMENT_POLICY,
  PUBLIC_DEPLOYMENT_POLICY,
  registrationAccountCap,
} from "../../src/server/deployment-policy.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("deployment policy", () => {
  it("defaults to private and rejects unknown deployment modes", () => {
    expect(deploymentPolicy(undefined)).toBe(PRIVATE_DEPLOYMENT_POLICY);
    expect(deploymentPolicy("private")).toBe(PRIVATE_DEPLOYMENT_POLICY);
    expect(deploymentPolicy("public")).toBe(PUBLIC_DEPLOYMENT_POLICY);
    expect(() => deploymentPolicy("hosted")).toThrow(
      "FEEDFOLD_DEPLOYMENT_MODE must be private or public",
    );
  });

  it("uses the account cap as the only public registration switch", () => {
    expect(registrationAccountCap(PRIVATE_DEPLOYMENT_POLICY, undefined)).toBe(1);
    expect(registrationAccountCap(PRIVATE_DEPLOYMENT_POLICY, "20")).toBe(1);
    expect(registrationAccountCap(PUBLIC_DEPLOYMENT_POLICY, undefined)).toBe(0);
    expect(registrationAccountCap(PUBLIC_DEPLOYMENT_POLICY, "invalid")).toBe(0);
    expect(registrationAccountCap(PUBLIC_DEPLOYMENT_POLICY, "0")).toBe(0);
    expect(registrationAccountCap(PUBLIC_DEPLOYMENT_POLICY, "20")).toBe(20);
  });

  it("keeps inactive private subscriptions scheduled", () => {
    const database = new AppDatabase(":memory:");
    try {
      const feed = database.feeds.createFeed(1, {
        feedUrl: "https://publisher.example.test/private.xml",
      });
      database.connection
        .prepare("UPDATE users SET last_active_at = '2000-01-01T00:00:00.000Z' WHERE id = 1")
        .run();
      database.connection
        .prepare(
          `UPDATE feed_sources SET next_poll_at = '2000-01-01T00:00:00.000Z'
           WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
        )
        .run(feed.id);

      expect(database.feeds.getDueFeedIds("2026-09-01T00:00:00.000Z")).toEqual([feed.id]);
      expect(database.bootstrap.getBootstrap(1).capabilities.manualRefresh).toBe(true);
    } finally {
      database.close();
    }
  });

  it("disables the public manual refresh API and capability", async () => {
    const database = new AppDatabase(":memory:", 20, PUBLIC_DEPLOYMENT_POLICY);
    const auth = new AuthService(database.auth, 20, { maxAccounts: 100 });
    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    let requests = 0;
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000, undefined, async () => {
      requests += 1;
      return new Response(null, { status: 304 });
    });
    const app = await createApp({
      database,
      authService: auth,
      extractionQueue: extraction,
      refreshService: refresh,
    });
    cleanups.push(async () => {
      await app.close();
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "public-reader", password: "reader-password" },
    });
    const setCookie = registration.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    if (!cookie) throw new Error("Registration did not return a session cookie");

    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie },
    });
    expect(bootstrap.json().capabilities).toEqual({ manualRefresh: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Manual refresh is unavailable." });
    expect(requests).toBe(0);
  });

  it("limits public accounts to 300 feeds while private accounts remain unrestricted", () => {
    const publicDatabase = new AppDatabase(":memory:", 20, PUBLIC_DEPLOYMENT_POLICY);
    const privateDatabase = new AppDatabase(":memory:");
    try {
      for (let index = 0; index < 300; index += 1) {
        publicDatabase.feeds.createFeed(1, {
          feedUrl: `https://publisher.example.test/public-${index}.xml`,
        });
        privateDatabase.feeds.createFeed(1, {
          feedUrl: `https://publisher.example.test/private-${index}.xml`,
        });
      }
      expect(() =>
        publicDatabase.feeds.createFeed(1, {
          feedUrl: "https://publisher.example.test/public-over-limit.xml",
        }),
      ).toThrow("This account can subscribe to up to 300 feeds.");
      expect(() =>
        publicDatabase.feeds.createWebFeed(1, {
          title: "Web over limit",
          pageUrl: "https://publisher.example.test/releases",
          folderId: null,
          config: {
            pageUrl: "https://publisher.example.test/releases",
            selectors: {
              item: "article",
              title: "h2",
              link: "a",
              date: null,
              author: null,
              summary: null,
              image: null,
            },
          },
          parsed: {
            title: "Releases",
            siteUrl: null,
            articles: [
              {
                externalId: "one",
                title: "One",
                url: "https://publisher.example.test/releases/one",
                author: null,
                publishedAt: null,
                summary: "",
                imageUrl: null,
                feedContentHtml: null,
              },
            ],
          },
        }),
      ).toThrow("This account can subscribe to up to 300 feeds.");

      expect(
        privateDatabase.feeds.createFeed(1, {
          feedUrl: "https://publisher.example.test/private-300.xml",
        }).id,
      ).toBeGreaterThan(0);
    } finally {
      publicDatabase.close();
      privateDatabase.close();
    }
  });

  it("bounds the public refresh queue", async () => {
    const database = new AppDatabase(":memory:", 20, {
      ...PUBLIC_DEPLOYMENT_POLICY,
      maxFeedsPerAccount: null,
      maxPendingRefreshes: 2,
    });
    let requests = 0;
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000, undefined, async () => {
      requests += 1;
      return new Response(null, { status: 304 });
    });
    try {
      const feedIds = Array.from(
        { length: 3 },
        (_, index) =>
          database.feeds.createFeed(1, {
            feedUrl: `https://publisher.example.test/queue-${index}.xml`,
          }).id,
      );
      expect(refresh.requestScheduled(feedIds)).toMatchObject({ requested: 2 });
      await refresh.waitForIdle();
      expect(requests).toBe(2);
      expect(
        database.connection
          .prepare("SELECT COUNT(*) FROM feed_sources WHERE refreshing = 1")
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      refresh.stop();
      database.close();
    }
  });
});
