import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationApi } from "../../src/server/application-api.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AiService } from "../../src/server/features/ai/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import { TelegramMediaService } from "../../src/server/telegram-media.js";
import { WebFeedService } from "../../src/server/web-feed.js";
import { XMediaService } from "../../src/server/x-media.js";
import type { ArticlePage, BootstrapData, Folder, Rule } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("local application API", () => {
  it("runs the reading workflow for one local user without an account session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedfold-application-api-test-"));
    const database = new AppDatabase(join(directory, "feedfold.db"));
    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const webFeeds = new WebFeedService();
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000, webFeeds);
    const application = new ApplicationApi({
      database,
      extractionQueue: extraction,
      refreshService: refresh,
      webFeedService: webFeeds,
      aiService: new AiService(database, { credentialCipher: null }),
      telegramMediaService: new TelegramMediaService(1_000),
      xMediaService: new XMediaService(1_000),
    });
    cleanups.push(
      () => rm(directory, { recursive: true, force: true }),
      () => database.close(),
      () => webFeeds.close(),
      () => Promise.all([refresh.stop(), extraction.stop()]).then(() => undefined),
    );

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
});
