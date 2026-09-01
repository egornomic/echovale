import { describe, expect, it } from "vitest";
import {
  appendUnseenArticles,
  articleQueryForReaderRoute,
  articleSettingsInvalidation,
  articlesWithLocalState,
  filterRuleName,
  firstUnseenArticlePage,
  fullContentIdsAfterReload,
  invalidateArticleSummaries,
  readerRouteForSelection,
  readerScopeLabel,
  readerScopeUnreadCount,
  refreshFeedIds,
  shouldAutoMarkRoutedArticleRead,
  updateBootstrapCounts,
} from "../../src/client/reader-state.js";
import { AppDatabase, type ParsedFeed } from "../../src/server/database.js";
import type { Article, BootstrapData, Feed, Folder } from "../../src/shared/types.js";

function folder(id: number, parentId: number | null, name: string): Folder {
  return {
    id,
    parentId,
    name,
    position: id,
    sortDirection: "newest",
    unreadCount: 1,
  };
}

function feed(id: number, folderId: number | null, title: string): Feed {
  return {
    id,
    folderId,
    title,
    feedUrl: `https://example.test/${id}.xml`,
    siteUrl: null,
    sourceKind: "published",
    healthStatus: "healthy",
    lastErrorKind: null,
    lastMatchCount: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    pollIntervalMinutes: 20,
    unreadCount: 1,
    totalCount: 1,
    paused: false,
    refreshing: false,
    lastPostAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastHttpStatus: null,
    lastError: null,
    nextPollAt: null,
  };
}

function bootstrap(): BootstrapData {
  return {
    folders: [folder(1, null, "Engineering"), folder(2, 1, "Frontend"), folder(3, null, "Cooking")],
    feeds: [
      feed(10, 1, "Platform"),
      feed(11, 2, "Interfaces"),
      feed(12, 3, "Recipes"),
      feed(13, null, "Loose notes"),
    ],
    settings: {
      pollIntervalMinutes: 20,
      duplicateArticleWindowDays: 7,
      singleKeyShortcuts: true,
      markReadOnScroll: true,
      showYouTubeDescriptions: false,
      translationLanguage: "English",
      summaryPrompt: "Summarize",
      translationPrompt: "Translate",
      customPrompts: [],
    },
    aiSettings: {
      credentialStorageAvailable: false,
      providers: [],
      features: { articleSummary: null },
    },
    counts: { unread: 1, starred: 0, all: 4 },
    capabilities: { manualRefresh: true },
  };
}

const article: Article = {
  id: 100,
  feedId: 11,
  feedTitle: "Interfaces",
  feedSourceKind: "published",
  folderId: 2,
  title: "A useful article",
  url: "https://example.test/article",
  author: null,
  publishedAt: null,
  discoveredAt: "2026-07-28T12:00:00.000Z",
  summary: "",
  imageUrl: null,
  media: null,
  feedContentHtml: null,
  contentHtml: null,
  contentSource: null,
  extractionStatus: "feed",
  extractionError: null,
  aiSummary: null,
  isRead: false,
  isStarred: false,
};

function summarizedArticle(id: number, promptId: string | null): Article {
  return {
    ...article,
    id,
    aiSummary: {
      text: "Summary",
      promptId,
      provider: "openai",
      model: "example-model",
      sourceKind: "feed",
      generatedAt: "2026-07-28T12:00:00.000Z",
      usage: { inputTokens: null, outputTokens: null },
      grounding: null,
    },
  };
}

describe("reader state", () => {
  it("builds one canonical route and API query for each reader scope", () => {
    const route = readerRouteForSelection("starred", null, 2, "design systems");
    expect(route).toEqual({
      kind: "reader",
      scope: "folder",
      scopeId: 2,
      state: "starred",
      search: "design systems",
    });
    expect(
      articleQueryForReaderRoute(route, {
        limit: 20,
        includeContent: true,
        cursor: "next-page",
      }),
    ).toEqual({
      state: "starred",
      folderId: 2,
      search: "design systems",
      limit: 20,
      includeContent: true,
      cursor: "next-page",
    });

    expect(readerRouteForSelection("unread", 10, 2, "").scope).toBe("feed");
    expect(readerRouteForSelection("all", null, null, "").scope).toBe("all");
  });

  it("targets explicit feeds, nested folder feeds, or every feed for refresh", () => {
    const data = bootstrap();
    expect(refreshFeedIds(data, 12, 1)).toEqual([12]);
    expect(refreshFeedIds(data, null, 1)).toEqual([10, 11]);
    expect(refreshFeedIds(data, null, null)).toBeUndefined();
  });

  it("tracks which replacement records still have full article content", () => {
    const articles = [
      { ...article, id: 1 },
      { ...article, id: 2 },
    ];

    expect(fullContentIdsAfterReload("magazine", articles, null)).toEqual(new Set());
    expect(fullContentIdsAfterReload("magazine", articles, 2)).toEqual(new Set([2]));
    expect(fullContentIdsAfterReload("expanded", articles, null)).toEqual(new Set([1, 2]));
  });

  it("adds newly delivered articles after the current reading sequence", () => {
    const current = [
      { ...article, id: 1, isRead: true },
      { ...article, id: 2, isRead: true, isStarred: true },
      { ...article, id: 3 },
    ];
    const delivered = { ...article, id: 4 };

    const result = appendUnseenArticles(current, [delivered, { ...article, id: 3 }, delivered]);

    expect(result.articles.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    expect(result.appended.map(({ id }) => id)).toEqual([4]);
    expect(result.articles.findIndex(({ id }) => id === 2)).toBe(1);
    expect(result.articles.slice(2).map(({ id }) => id)).toEqual([3, 4]);
    expect(result.articles[1]).toMatchObject({ id: 2, isRead: true, isStarred: true });
  });

  it("keeps local read and saved state while applying delivered article data", () => {
    const current = [
      { ...article, id: 1, isRead: true },
      { ...article, id: 2, isStarred: true },
    ];
    const refreshed = [
      { ...article, id: 1, title: "Refreshed one" },
      { ...article, id: 2, title: "Refreshed two" },
      { ...article, id: 3, title: "Delivered three" },
    ];

    expect(
      articlesWithLocalState(current, refreshed).map(({ id, title, isRead, isStarred }) => ({
        id,
        title,
        isRead,
        isStarred,
      })),
    ).toEqual([
      { id: 1, title: "Refreshed one", isRead: true, isStarred: false },
      { id: 2, title: "Refreshed two", isRead: false, isStarred: true },
      { id: 3, title: "Delivered three", isRead: false, isStarred: false },
    ]);
  });

  it("continues through refreshed cursor pages until another unread article is reachable", async () => {
    const database = new AppDatabase(":memory:");
    const feed = database.feeds.createFeed(1, {
      title: "Busy feed",
      feedUrl: "https://example.test/busy.xml",
      folderId: null,
    });
    const feedArticle = (index: number): ParsedFeed["articles"][number] => ({
      externalId: `article-${index}`,
      title: `Article ${index}`,
      url: null,
      author: null,
      publishedAt: new Date(Date.UTC(2026, 6, index)).toISOString(),
      summary: "",
      imageUrl: null,
      feedContentHtml: null,
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: feed.title,
        siteUrl: null,
        articles: Array.from({ length: 8 }, (_, index) => feedArticle(index + 1)),
      },
    });

    try {
      const loaded = database.articles.listArticlePage(1, { state: "unread", limit: 6 }).articles;
      const freshHead = database.articles.listArticlePage(1, { state: "unread", limit: 2 });
      if (!freshHead.nextCursor) throw new Error("The live queue did not create a cursor");
      const loadedCursors: string[] = [];

      const page = await firstUnseenArticlePage(loaded, freshHead.nextCursor, async (cursor) => {
        loadedCursors.push(cursor);
        const next = database.articles.listArticlePage(1, {
          state: "unread",
          limit: 2,
          cursor,
        });
        return { candidates: next.articles, nextCursor: next.nextCursor };
      });

      expect(loadedCursors).toHaveLength(3);
      expect(page.appended.map(({ title }) => title)).toEqual(["Article 2", "Article 1"]);
      expect(page.nextCursor).toBeNull();
    } finally {
      database.close();
    }
  });

  it("keeps an open article unread after the reader explicitly marks it unread", () => {
    expect(shouldAutoMarkRoutedArticleRead(article, article.id, new Set())).toBe(true);
    expect(shouldAutoMarkRoutedArticleRead(article, article.id, new Set([article.id]))).toBe(false);
    expect(
      shouldAutoMarkRoutedArticleRead({ ...article, isRead: true }, article.id, new Set()),
    ).toBe(false);
  });

  it("updates only the affected counters and never makes a count negative", () => {
    const updated = updateBootstrapCounts(bootstrap(), article, -2, 1);
    expect(updated.counts).toEqual({ unread: 0, starred: 1, all: 4 });
    expect(updated.feeds.map(({ id, unreadCount }) => [id, unreadCount])).toEqual([
      [10, 1],
      [11, 0],
      [12, 1],
      [13, 1],
    ]);
    expect(updated.folders.map(({ id, unreadCount }) => [id, unreadCount])).toEqual([
      [1, 1],
      [2, 0],
      [3, 1],
    ]);
  });

  it("invalidates only AI output affected by changed reader settings", () => {
    const previous = {
      ...bootstrap().settings,
      customPrompts: [
        { id: "changed", name: "Changed", prompt: "Old instructions" },
        { id: "kept", name: "Kept", prompt: "Stable instructions" },
      ],
    };
    const next = {
      ...previous,
      summaryPrompt: "A new default summary prompt",
      translationLanguage: "Polish",
      customPrompts: [
        { id: "changed", name: "Changed", prompt: "New instructions" },
        { id: "kept", name: "Renamed only", prompt: "Stable instructions" },
      ],
    };

    const invalidation = articleSettingsInvalidation(previous, next);
    expect(invalidation.resetTranslationState).toBe(true);
    expect([...invalidation.invalidatedSummaryPromptIds]).toEqual([null, "changed"]);

    const articles = [
      summarizedArticle(1, null),
      summarizedArticle(2, "changed"),
      summarizedArticle(3, "kept"),
    ];
    expect(
      invalidateArticleSummaries(articles, invalidation.invalidatedSummaryPromptIds).map((item) =>
        item.aiSummary ? (item.aiSummary.promptId ?? "default") : "removed",
      ),
    ).toEqual(["removed", "removed", "kept"]);

    const unchanged = articleSettingsInvalidation(previous, previous);
    expect(unchanged.resetTranslationState).toBe(false);
    expect(invalidateArticleSummaries(articles, unchanged.invalidatedSummaryPromptIds)).toBe(
      articles,
    );
  });

  it("derives stable labels for reader scopes and generated filter rules", () => {
    const data = bootstrap();
    expect(readerScopeLabel(data, 11, null, "unread")).toBe("Interfaces");
    expect(readerScopeLabel(data, null, 1, "starred")).toBe("Engineering");
    expect(readerScopeLabel(data, null, null, "unread")).toBe("Feed");
    expect(readerScopeLabel(data, null, null, "all")).toBe("Feed");
    expect(readerScopeLabel(data, null, null, "read")).toBe("Read");
    expect(readerScopeLabel(data, null, null, "starred")).toBe("Saved");
    expect(readerScopeLabel(data, 999, null, "all")).toBe("Feed");
    expect(filterRuleName("x".repeat(100))).toBe(`Filter: ${"x".repeat(71)}…`);
  });

  it("reports unread counts for the active reader scope", () => {
    const data = bootstrap();
    data.counts.unread = 9;
    data.feeds[1] = { ...data.feeds[1], unreadCount: 4 };
    data.folders[0] = { ...data.folders[0], unreadCount: 7 };

    expect(readerScopeUnreadCount(data, null, null)).toBe(9);
    expect(readerScopeUnreadCount(data, 11, null)).toBe(4);
    expect(readerScopeUnreadCount(data, null, 1)).toBe(7);
  });
});
