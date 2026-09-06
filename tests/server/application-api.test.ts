import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ApiRuntime, createApiClient } from "../../src/client/api-client.js";
import { ApiError } from "../../src/client/api-contract.js";
import { createApp } from "../../src/server/app.js";
import { ApplicationApi, type ApplicationApiServices } from "../../src/server/application-api.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AiService } from "../../src/server/features/ai/service.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import { TelegramMediaService } from "../../src/server/telegram-media.js";
import { WebFeedService } from "../../src/server/web-feed.js";
import { XMediaService } from "../../src/server/x-media.js";
import type { DesktopOperation } from "../../src/shared/desktop.js";
import type { ArticlePage, BootstrapData, Folder, Rule } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function applicationServices(database: AppDatabase): ApplicationApiServices {
  const extractionQueue = new ExtractionQueue(database.extractions, 1, 1_000);
  const webFeedService = new WebFeedService();
  const refreshService = new FeedRefreshService(database.feeds, 1, 1_000, webFeedService);
  cleanups.push(
    () => database.close(),
    () => webFeedService.close(),
    () => Promise.all([refreshService.stop(), extractionQueue.stop()]).then(() => undefined),
  );
  return {
    database,
    extractionQueue,
    refreshService,
    webFeedService,
    aiService: new AiService(database, { credentialCipher: null }),
    telegramMediaService: new TelegramMediaService(1_000),
    xMediaService: new XMediaService(1_000),
  };
}

describe("local application API", () => {
  it("runs the reading workflow for one local user without an account session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedfold-application-api-test-"));
    const database = new AppDatabase(join(directory, "feedfold.db"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const application = new ApplicationApi(applicationServices(database));

    database.connection
      .prepare("UPDATE users SET last_active_at = '2000-01-01T00:00:00.000Z' WHERE id = 1")
      .run();
    await expect(application.invoke({ operation: "session" })).resolves.toEqual({
      user: { id: "local", username: "On this Mac", hasPassword: false },
    });
    expect(
      database.connection.prepare("SELECT last_active_at FROM users WHERE id = 1").pluck().get(),
    ).not.toBe("2000-01-01T00:00:00.000Z");

    const folder = (await application.invoke({
      operation: "createFolder",
      payload: { name: "Local reading", parentId: null, sortDirection: "newest" },
    })) as Folder;
    const feed = database.feeds.createFeed(1, {
      title: "Desktop feed",
      feedUrl: "https://example.test/feed.xml",
      folderId: folder.id,
      paused: true,
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: feed.title,
        siteUrl: "https://example.test/",
        articles: [
          {
            externalId: "local-story",
            title: "Local story",
            url: "https://example.test/story",
            author: "Writer",
            publishedAt: "2026-08-03T10:00:00.000Z",
            summary: "Saved on this Mac.",
            feedContentHtml: null,
            imageUrl: null,
            media: null,
          },
        ],
      },
    });

    const rule = (await application.invoke({
      operation: "createRule",
      payload: {
        name: "Read local stories",
        feedId: feed.id,
        folderId: null,
        conditions: [{ field: "title", pattern: "Local" }],
        conditionOperator: "and",
        action: "mark_read",
        enabled: true,
      },
    })) as Rule;
    expect(rule.matchedCount).toBe(1);

    const page = (await application.invoke({
      operation: "articles",
      payload: { state: "read", feedId: feed.id },
    })) as ArticlePage;
    expect(page.articles).toHaveLength(1);
    expect(page.articles[0]).toMatchObject({ title: "Local story", isRead: true });

    const bootstrap = (await application.invoke({ operation: "bootstrap" })) as BootstrapData;
    expect(bootstrap.folders).toContainEqual(folder);
    expect(bootstrap.feeds).toHaveLength(1);
    expect(bootstrap.counts.all).toBe(1);

    const opml = await application.invoke({ operation: "exportOpml" });
    expect(opml).toEqual(expect.stringContaining("https://example.test/feed.xml"));
  });

  it.each([
    "web",
    "desktop",
  ] as const)("accepts the shared reading and management inputs through %s", async (transport) => {
    const database = new AppDatabase(":memory:");
    const services = applicationServices(database);
    const application = new ApplicationApi(services);
    const app = await createApp({ ...services, authService: new AuthService(database.auth) });
    cleanups.push(() => app.close());
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "contract-reader", password: "reader-password" },
    });
    expect(registration.statusCode).toBe(201);
    const setCookie = registration.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    const request: ApiRuntime["request"] = async <T>(
      operation: DesktopOperation,
      payload: unknown,
      path: string,
      init?: RequestInit,
    ) => {
      if (transport === "desktop") return (await application.invoke({ operation, payload })) as T;
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
        url: path,
        headers: { cookie, "content-type": "application/json" },
        ...(init?.body ? { payload: String(init.body) } : {}),
      });
      if (response.statusCode >= 400) {
        throw new ApiError(response.json<{ error: string }>().error, response.statusCode);
      }
      return response.statusCode === 204 ? (undefined as T) : response.json<T>();
    };
    const client = createApiClient({
      request,
      subscribeReaderDataInvalidations: () => () => {},
      exportOpml: async () => {},
    });

    const parent = await client.createFolder({ name: "Reading" });
    expect(parent).toMatchObject({ parentId: null, sortDirection: "newest" });
    const folder = await client.createFolder({
      name: "Updates",
      parentId: parent.id,
      position: 7,
      sortDirection: "oldest",
    });
    expect(folder).toMatchObject({ parentId: parent.id, position: 7, sortDirection: "oldest" });
    expect(await client.updateFolder(folder.id, { position: 42 })).toMatchObject({ position: 42 });
    await expect(client.updateFolder(folder.id, { position: -1 })).rejects.toThrow();
    expect((await client.bootstrap()).folders.find(({ id }) => id === folder.id)?.position).toBe(
      42,
    );

    const feed = await client.createFeed({
      sourceKind: "published",
      title: "Contract feed",
      feedUrl: "https://example.test/contracts.xml",
      paused: true,
      folderId: folder.id,
    });
    expect(feed).toMatchObject({ paused: true, folderId: folder.id });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: feed.title,
        siteUrl: null,
        articles: [
          {
            externalId: "contract-story",
            title: "Contract story",
            url: null,
            author: null,
            publishedAt: null,
            summary: "Available in both apps.",
            feedContentHtml: null,
            imageUrl: null,
          },
        ],
      },
    });
    const article = (
      await client.articles({ state: "all", feedId: feed.id, limit: 1, includeContent: true })
    ).articles[0];
    expect(article).toMatchObject({ title: "Contract story", isRead: false, isStarred: false });
    expect(await client.updateArticleState(article.id, { isStarred: true })).toMatchObject({
      isStarred: true,
    });
    await expect(client.updateArticleState(article.id, {})).rejects.toThrow();
    expect((await client.article(article.id)).isStarred).toBe(true);

    const rule = await client.createRule({
      name: "Read updates",
      feedId: feed.id,
      conditions: [{ field: "title", pattern: "Contract" }],
      conditionOperator: "and",
      action: "mark_read",
    });
    expect(rule).toMatchObject({ enabled: true, folderId: null, matchedCount: 1 });
    expect((await client.article(article.id)).isRead).toBe(true);
    await expect(client.updateRule(rule.id, { folderId: folder.id })).rejects.toThrow(
      "Choose either one feed or one folder for this rule.",
    );
    expect(await client.updateSettings({ pollIntervalMinutes: 10 })).toMatchObject({
      pollIntervalMinutes: 10,
    });
  });
});
