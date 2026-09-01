import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase, type ParsedFeed } from "../../src/server/database.js";
import type { WebFeedConfig } from "../../src/shared/types.js";

const directories: string[] = [];
const TEST_USER_ID = 1;

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDatabase(): Promise<AppDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "feedfold-web-feed-test-"));
  directories.push(directory);
  return new AppDatabase(join(directory, "feedfold.db"));
}

function config(pageUrl: string, item = ".card"): WebFeedConfig {
  return {
    pageUrl,
    selectors: {
      item,
      title: "h2",
      link: "a",
      date: "time",
      author: ".author",
      summary: "p",
      image: "img",
    },
  };
}

function article(externalId: string, title: string, url: string) {
  return {
    externalId,
    title,
    url,
    author: null,
    publishedAt: null,
    summary: `${title} summary`,
    imageUrl: null,
    feedContentHtml: `<p>${title} body</p>`,
  };
}

describe("web feed persistence", () => {
  it("limits a new page subscription without importing the skipped backlog later", async () => {
    const database = await temporaryDatabase();
    const pageUrl = "https://example.test/updates";
    try {
      const initialArticles = Array.from({ length: 12 }, (_, index) => {
        const number = index + 1;
        return article(`web:${number}`, `Update ${number}`, `${pageUrl}/${number}`);
      });
      const feed = database.feeds.createWebFeed(TEST_USER_ID, {
        title: "Updates",
        pageUrl,
        folderId: null,
        config: config(pageUrl),
        parsed: { title: "Updates", siteUrl: pageUrl, articles: initialArticles },
      });

      expect(database.feeds.getFeed(TEST_USER_ID, feed.id)?.totalCount).toBe(10);
      expect(
        database.articles
          .listArticles(TEST_USER_ID, { state: "all", feedId: feed.id })
          .map(({ title }) => title)
          .sort(),
      ).toEqual(Array.from({ length: 10 }, (_, index) => `Update ${index + 1}`).sort());

      database.feeds.completeRefresh(feed.id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        parsed: {
          title: "Updates",
          siteUrl: pageUrl,
          articles: [article("web:new", "New update", `${pageUrl}/new`), ...initialArticles],
        },
      });

      const refreshedTitles = database.articles
        .listArticles(TEST_USER_ID, { state: "all", feedId: feed.id })
        .map(({ title }) => title);
      expect(refreshedTitles).toHaveLength(11);
      expect(refreshedTitles).toContain("New update");
      expect(refreshedTitles).not.toContain("Update 11");
      expect(refreshedTitles).not.toContain("Update 12");
    } finally {
      database.close();
    }
  });

  it("atomically saves selections and refreshes stable items without losing history or state", async () => {
    const database = await temporaryDatabase();
    const pageUrl = "https://example.test/releases";
    try {
      const folder = database.folders.createFolder(TEST_USER_ID, { name: "Releases" });
      const initial: ParsedFeed = {
        title: "Example releases",
        siteUrl: pageUrl,
        articles: [
          article("web:first", "Shared title", "https://example.test/releases/one"),
          article("web:second", "Shared title", "https://example.test/releases/two"),
          article("web:duplicate-link", "Repeated card", "https://example.test/releases/one"),
        ],
      };
      const feed = database.feeds.createWebFeed(TEST_USER_ID, {
        title: "Tracked releases",
        pageUrl,
        folderId: folder.id,
        config: config(pageUrl),
        parsed: initial,
      });

      expect(feed).toMatchObject({
        title: "Tracked releases",
        folderId: folder.id,
        sourceKind: "web",
        pollIntervalMinutes: 60,
        healthStatus: "healthy",
        lastErrorKind: null,
        lastMatchCount: 3,
        totalCount: 2,
      });
      const record = database.feeds.getFeedRecord(feed.id);
      expect(record).toMatchObject({
        sourceKind: "web",
        pollIntervalMinutes: 60,
        webConfig: config(pageUrl),
        selectionRevision: 1,
        lastMatchCount: 3,
      });
      if (record?.sourceKind !== "web") throw new Error("Expected a stored web feed config");
      expect(database.feeds.getWebFeedConfig(TEST_USER_ID, feed.id)).toEqual(config(pageUrl));
      expect(database.feeds.getWebFeedConfig(999, feed.id)).toBeNull();

      const initialArticles = database.articles.listArticles(TEST_USER_ID, {
        state: "all",
        includeContent: true,
      });
      expect(initialArticles).toHaveLength(2);
      expect(initialArticles.map(({ url }) => url)).toEqual([
        "https://example.test/releases/two",
        "https://example.test/releases/one",
      ]);
      for (const stored of initialArticles) {
        expect(stored.publishedAt).toBe(stored.discoveredAt);
      }

      const first = initialArticles.find(({ url }) => url === "https://example.test/releases/one");
      if (!first) throw new Error("Expected the first web article");
      database.articles.updateArticleState(TEST_USER_ID, first.id, {
        isRead: true,
        isStarred: true,
      });
      expect(database.feeds.getFeed(TEST_USER_ID, feed.id)?.lastPostAt).toBe(
        initialArticles[0]?.publishedAt,
      );

      const revised: ParsedFeed = {
        title: "Example releases",
        siteUrl: pageUrl,
        articles: [
          {
            ...article("web:first", "Corrected title", "https://example.test/releases/one"),
            summary: "Corrected summary",
          },
          article("web:third", "Corrected title", "https://example.test/releases/three"),
        ],
      };
      database.connection
        .prepare(
          `UPDATE feed_sources
           SET poll_interval_minutes = 5, activity_rate_per_hour = 12,
               last_scheduled_observation_at = '2026-08-12T10:00:00.000Z'
           WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
        )
        .run(feed.id);
      expect(
        database.feeds.updateWebFeedSelection(
          TEST_USER_ID,
          feed.id,
          config(pageUrl, "article.release"),
          revised,
        ),
      ).toMatchObject({ lastMatchCount: 2, totalCount: 3, pollIntervalMinutes: 60 });

      expect(database.feeds.getFeedRecord(feed.id)).toMatchObject({
        sourceKind: "web",
        webConfig: config(pageUrl, "article.release"),
        selectionRevision: 2,
        lastMatchCount: 2,
        pollIntervalMinutes: 60,
      });
      const corrected = database.articles
        .listArticles(TEST_USER_ID, { state: "all" })
        .find(({ url }) => url === first.url);
      expect(corrected).toMatchObject({
        title: "Corrected title",
        summary: "Corrected summary",
        isRead: true,
        isStarred: true,
      });
      expect(
        database.articles
          .listArticles(TEST_USER_ID, { state: "all" })
          .map(({ url }) => url)
          .sort(),
      ).toEqual([
        "https://example.test/releases/one",
        "https://example.test/releases/three",
        "https://example.test/releases/two",
      ]);

      database.feeds.failRefresh(feed.id, {
        httpStatus: 200,
        error: "Stale selection failed",
        errorKind: "selection_broken",
        healthStatus: "needs_attention",
        retryMinutes: 20,
        expectedSelectionRevision: 1,
      });
      database.feeds.completeRefresh(feed.id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        parsed: {
          title: "Stale result",
          siteUrl: pageUrl,
          articles: [article("web:stale", "Stale article", "https://example.test/releases/stale")],
        },
        webMatchCount: 1,
        expectedSelectionRevision: 1,
      });
      expect(database.feeds.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        healthStatus: "healthy",
        lastErrorKind: null,
        lastMatchCount: 2,
        totalCount: 3,
      });
      expect(
        database.articles
          .listArticles(TEST_USER_ID, { state: "all" })
          .some(({ url }) => url === "https://example.test/releases/stale"),
      ).toBe(false);

      database.feeds.markRefreshing(feed.id);
      database.feeds.failRefresh(feed.id, {
        httpStatus: null,
        error: "The page could not be reached",
        errorKind: "network",
        healthStatus: "failing",
        retryMinutes: 20,
      });
      expect(database.feeds.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        healthStatus: "failing",
        lastErrorKind: "network",
        lastMatchCount: 2,
        totalCount: 3,
      });
      database.feeds.markRefreshing(feed.id);
      expect(database.feeds.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        refreshing: true,
        healthStatus: "failing",
        lastErrorKind: "network",
      });
      database.feeds.failRefresh(feed.id, {
        httpStatus: 200,
        error: "The saved page selection no longer matches meaningful items",
        errorKind: "selection_broken",
        healthStatus: "needs_attention",
        retryMinutes: 20,
      });
      expect(database.feeds.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        healthStatus: "needs_attention",
        lastErrorKind: "selection_broken",
        lastMatchCount: 0,
        totalCount: 3,
      });

      database.feeds.completeRefresh(feed.id, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        parsed: revised,
        webMatchCount: 2,
      });
      expect(database.feeds.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
        healthStatus: "healthy",
        lastErrorKind: null,
        lastError: null,
        lastMatchCount: 2,
        totalCount: 3,
      });

      expect(() =>
        database.feeds.updateFeed(TEST_USER_ID, feed.id, {
          feedUrl: "https://example.test/other-page",
        }),
      ).toThrow("To change a web feed URL, edit its page selection.");
      expect(
        database.feeds.updateFeed(TEST_USER_ID, feed.id, { title: "Renamed web feed" }),
      ).toMatchObject({ title: "Renamed web feed", feedUrl: pageUrl });
      expect(database.feeds.listOpmlFeeds(TEST_USER_ID)).toEqual([]);

      expect(database.feeds.deleteFeed(TEST_USER_ID, feed.id)).toBe(true);
      expect(
        database.connection
          .prepare(
            `SELECT 1 FROM source_web_feed_configs
             WHERE source_id = (SELECT source_id FROM feeds WHERE id = ?)`,
          )
          .get(feed.id),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("uses settings only as the starting interval for new feeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedfold-web-feed-schedule-test-"));
    directories.push(directory);
    const path = join(directory, "feedfold.db");
    const pageUrl = "https://example.test/publications";
    const database = new AppDatabase(path);
    const webFeed = database.feeds.createWebFeed(TEST_USER_ID, {
      title: "Publications",
      pageUrl,
      folderId: null,
      config: config(pageUrl),
      parsed: {
        title: "Publications",
        siteUrl: pageUrl,
        articles: [article("web:first", "First paper", `${pageUrl}/first`)],
      },
    });
    const publishedFeed = database.feeds.createFeed(TEST_USER_ID, {
      title: "Published feed",
      feedUrl: "https://example.test/feed.xml",
    });

    expect(webFeed.pollIntervalMinutes).toBe(60);
    expect(publishedFeed.pollIntervalMinutes).toBe(20);

    database.settings.updateSettings(TEST_USER_ID, { pollIntervalMinutes: 60 });
    const laterFeed = database.feeds.createFeed(TEST_USER_ID, {
      title: "Later published feed",
      feedUrl: "https://example.test/later.xml",
    });
    expect(database.feeds.getFeed(TEST_USER_ID, webFeed.id)?.pollIntervalMinutes).toBe(60);
    expect(database.feeds.getFeed(TEST_USER_ID, publishedFeed.id)?.pollIntervalMinutes).toBe(20);
    expect(laterFeed.pollIntervalMinutes).toBe(60);

    database.connection
      .prepare(
        `UPDATE feed_sources SET last_attempt_at = ?, next_poll_at = ?
         WHERE id = (SELECT source_id FROM feeds WHERE id = ?)`,
      )
      .run("2026-07-27T12:00:00.000Z", "2026-07-27T12:20:00.000Z", webFeed.id);
    database.close();

    const migrated = new AppDatabase(path);
    try {
      expect(migrated.feeds.getFeed(TEST_USER_ID, webFeed.id)).toMatchObject({
        pollIntervalMinutes: 60,
        nextPollAt: "2026-07-27T12:20:00.000Z",
      });
    } finally {
      migrated.close();
    }
  });

  it("does not create a web feed without a usable initial selection", async () => {
    const database = await temporaryDatabase();
    const pageUrl = "https://example.test/jobs";
    try {
      expect(() =>
        database.feeds.createWebFeed(TEST_USER_ID, {
          title: "Jobs",
          pageUrl,
          folderId: null,
          config: config(pageUrl),
          parsed: { title: "Jobs", siteUrl: pageUrl, articles: [] },
        }),
      ).toThrow("This selection does not match any entries. Choose another entry group.");
      expect(database.feeds.listFeeds(TEST_USER_ID)).toEqual([]);

      const published = database.feeds.createFeed(TEST_USER_ID, {
        title: "Published feed",
        feedUrl: "https://example.test/feed.xml",
      });
      expect(published).toMatchObject({
        sourceKind: "published",
        healthStatus: "healthy",
        lastErrorKind: null,
        lastMatchCount: null,
      });
      expect(database.feeds.getFeedRecord(published.id)).toMatchObject({
        sourceKind: "published",
        webConfig: null,
      });
      expect(() =>
        database.feeds.updateWebFeedSelection(
          TEST_USER_ID,
          published.id,
          config("https://example.test/feed.xml"),
          {
            title: "Not web",
            siteUrl: null,
            articles: [article("one", "One", "https://example.test/one")],
          },
        ),
      ).toThrow("Choose a web feed before editing a page selection.");
      expect(database.feeds.listOpmlFeeds(TEST_USER_ID)).toMatchObject([
        { title: "Published feed", feedUrl: "https://example.test/feed.xml" },
      ]);
    } finally {
      database.close();
    }
  });
});
