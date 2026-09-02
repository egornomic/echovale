import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { WebFeedService } from "../../src/server/web-feed.js";

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
    const registeredUser = database.auth.findEnabledUser("public-reader");
    if (!registeredUser) throw new Error("Registration did not create an account");
    const feed = database.feeds.createFeed(registeredUser.id, {
      feedUrl: "https://publisher.example.test/paused.xml",
      paused: true,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Manual refresh is unavailable." });
    const perFeedResponse = await app.inject({
      method: "POST",
      url: `/api/feeds/${feed.id}/refresh`,
      headers: { cookie },
      payload: {},
    });
    expect(perFeedResponse.statusCode).toBe(403);
    expect(perFeedResponse.json()).toEqual({ error: "Manual refresh is unavailable." });
    expect(requests).toBe(0);
  });

  it("returns clear API errors when discovery and web analysis daily quotas are exhausted", async () => {
    const database = new AppDatabase(
      ":memory:",
      20,
      deploymentPolicy("public", { feedDiscoveriesPerDay: 1, webAnalysesPerDay: 1 }),
    );
    const auth = new AuthService(database.auth);
    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000);
    const webFeeds = new WebFeedService({ quotas: database.quotas });
    const app = await createApp({
      database,
      authService: auth,
      extractionQueue: extraction,
      refreshService: refresh,
      webFeedService: webFeeds,
    });
    cleanups.push(async () => {
      await app.close();
      await Promise.all([refresh.stop(), extraction.stop(), webFeeds.close()]);
      database.close();
    });
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "quota-reader", password: "reader-password" },
    });
    const cookie = String(registration.headers["set-cookie"]).split(";", 1)[0];

    const requestTwice = async (url: string) => {
      const first = await app.inject({
        method: "POST",
        url,
        headers: { cookie },
        payload: { url: "http://127.0.0.1/private" },
      });
      expect(first.statusCode).toBe(422);
      return app.inject({
        method: "POST",
        url,
        headers: { cookie },
        payload: { url: "http://127.0.0.1/private" },
      });
    };
    const discovery = await requestTwice("/api/feeds/discover");
    expect(discovery.statusCode).toBe(429);
    expect(discovery.json()).toEqual({
      error: "This account has reached today's feed discovery limit. Try again tomorrow.",
      code: "quota_exceeded",
    });
    const analysis = await requestTwice("/api/web-feeds/analyze");
    expect(analysis.statusCode).toBe(429);
    expect(analysis.json()).toEqual({
      error: "This account has reached today's web-page analysis limit. Try again tomorrow.",
      code: "quota_exceeded",
    });
  });

  it("never queues a paused feed from a private user-facing refresh API", async () => {
    const database = new AppDatabase(":memory:");
    const auth = new AuthService(database.auth);
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
      payload: { username: "private-reader", password: "reader-password" },
    });
    const cookie = String(registration.headers["set-cookie"]).split(";", 1)[0];
    const registeredUser = database.auth.findEnabledUser("private-reader");
    if (!registeredUser) throw new Error("Registration did not create an account");
    const feed = database.feeds.createFeed(registeredUser.id, {
      feedUrl: "https://publisher.example.test/paused-private.xml",
      paused: true,
    });

    const explicit = await app.inject({
      method: "POST",
      url: `/api/feeds/${feed.id}/refresh`,
      headers: { cookie },
      payload: {},
    });
    expect(explicit.statusCode).toBe(400);
    expect(explicit.json()).toEqual({ error: "Resume paused feeds before refreshing them." });
    const all = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { cookie },
      payload: {},
    });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ requested: 0, refreshingFeedIds: [] });
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

  it("shares durable daily and concurrency quotas across server instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "feedfold-quotas-"));
    const path = join(directory, "feedfold.db");
    const policy = deploymentPolicy("public", {
      feedDiscoveriesPerDay: 1,
      chromiumConcurrent: 1,
      outboundRequestsPerDay: 1,
    });
    const first = new AppDatabase(path, 20, policy);
    const second = new AppDatabase(path, 20, policy);
    cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
    cleanups.push(() => first.close());
    cleanups.push(() => second.close());

    first.quotas.consume("feed_discovery", 1);
    expect(() => second.quotas.consume("feed_discovery", 1)).toThrow(
      "This account has reached today's feed discovery limit",
    );
    await expect(first.quotas.runOutbound(async () => "sent")).resolves.toBe("sent");
    await expect(second.quotas.runOutbound(async () => "blocked")).rejects.toThrow(
      "today's outbound request limit",
    );

    let finishFirst: (() => void) | undefined;
    const held = first.quotas.runChromium(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await expect(second.quotas.runChromium(async () => undefined)).rejects.toThrow(
      "already analyzing other web pages",
    );
    finishFirst?.();
    await held;
    await expect(second.quotas.runChromium(async () => "available")).resolves.toBe("available");
  });

  it("rejects oversized OPML and too many imported feeds before storing anything", () => {
    const database = new AppDatabase(
      ":memory:",
      20,
      deploymentPolicy("public", { opmlUploadBytes: 1_000, opmlFeedsPerImport: 1 }),
    );
    try {
      const twoFeeds = `<?xml version="1.0"?><opml version="2.0"><body>
        <outline text="One" xmlUrl="https://example.test/one.xml"/>
        <outline text="Two" xmlUrl="https://example.test/two.xml"/>
      </body></opml>`;
      expect(() => database.opml.import(1, twoFeeds)).toThrow(
        "An OPML file can import up to 1 feed.",
      );
      expect(database.feeds.listFeeds(1)).toHaveLength(0);

      const oversized = `<?xml version="1.0"?><opml version="2.0"><body>
        <outline text="${"x".repeat(1_000)}" xmlUrl="https://example.test/one.xml"/>
      </body></opml>`;
      expect(() => database.opml.import(1, oversized)).toThrow(
        "larger than the 1,000 bytes upload limit",
      );
      expect(database.feeds.listFeeds(1)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rolls back article ingestion when an account storage quota would be exceeded", () => {
    const database = new AppDatabase(
      ":memory:",
      20,
      deploymentPolicy("public", { articlesPerAccount: 1 }),
    );
    try {
      const feed = database.feeds.createFeed(1, {
        feedUrl: "https://publisher.example.test/quota.xml",
        paused: true,
      });
      expect(() =>
        database.feeds.completeRefresh(feed.id, {
          httpStatus: 200,
          etag: null,
          lastModified: null,
          parsed: {
            title: "Quota feed",
            siteUrl: "https://publisher.example.test/",
            articles: ["one", "two"].map((externalId) => ({
              externalId,
              title: externalId,
              url: `https://publisher.example.test/${externalId}`,
              author: null,
              publishedAt: null,
              summary: "",
              imageUrl: null,
              feedContentHtml: null,
            })),
          },
        }),
      ).toThrow("This account has reached its 1 article limit.");
      expect(database.connection.prepare("SELECT COUNT(*) FROM articles").pluck().get()).toBe(0);
      expect(database.connection.prepare("SELECT COUNT(*) FROM feed_articles").pluck().get()).toBe(
        0,
      );
    } finally {
      database.close();
    }
  });

  it("enforces account bytes, registered accounts, and global storage limits", async () => {
    const storageDatabase = new AppDatabase(
      ":memory:",
      20,
      deploymentPolicy("public", { storedBytesPerAccount: 20 }),
    );
    try {
      const feed = storageDatabase.feeds.createFeed(1, {
        feedUrl: "https://publisher.example.test/bytes.xml",
        paused: true,
      });
      expect(() =>
        storageDatabase.feeds.completeRefresh(feed.id, {
          httpStatus: 200,
          etag: null,
          lastModified: null,
          parsed: {
            title: "Large",
            siteUrl: null,
            articles: [
              {
                externalId: "large",
                title: "A stored article",
                url: "https://publisher.example.test/large",
                author: null,
                publishedAt: null,
                summary: "content that exceeds the configured account storage quota",
                imageUrl: null,
                feedContentHtml: null,
              },
            ],
          },
        }),
      ).toThrow("This account has reached its stored-data limit.");
      expect(
        storageDatabase.connection.prepare("SELECT COUNT(*) FROM articles").pluck().get(),
      ).toBe(0);
    } finally {
      storageDatabase.close();
    }

    const accountDatabase = new AppDatabase(
      ":memory:",
      20,
      deploymentPolicy("public", { registeredAccounts: 1 }),
    );
    try {
      const auth = new AuthService(accountDatabase.auth, 20, { maxAccounts: 2 });
      await expect(auth.register("first-account", "reader-password")).resolves.toBeTruthy();
      await expect(auth.register("second-account", "reader-password")).rejects.toThrow(
        "not accepting more accounts",
      );
    } finally {
      accountDatabase.close();
    }

    const fullDatabase = new AppDatabase(
      ":memory:",
      20,
      deploymentPolicy("public", { globalStoredBytes: 1 }),
    );
    try {
      expect(() => fullDatabase.quotas.assertGlobalStorage()).toThrow(
        "server has reached its storage limit",
      );
    } finally {
      fullDatabase.close();
    }
  });
});
