import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/server/database.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("shared feed sources", () => {
  it("fetches and stores a public feed once while keeping delivery state account-specific", async () => {
    const database = new AppDatabase(":memory:");
    const auth = new AuthService(database.auth, 20, { maxAccounts: 100 });
    const firstUser = (await auth.register("first-reader", "reader-password"))?.user;
    const secondUser = (await auth.register("second-reader", "reader-password"))?.user;
    if (!firstUser || !secondUser) throw new Error("Test accounts were not created");

    const feedUrl = "https://publisher.example.test/feed.xml";
    const firstFeed = database.feeds.createFeed(firstUser.id, { feedUrl, paused: true });
    const secondFeed = database.feeds.createFeed(secondUser.id, { feedUrl, paused: true });
    let requests = 0;
    const refresh = new FeedRefreshService(database.feeds, 2, 1_000, undefined, async () => {
      requests += 1;
      return new Response(
        `<?xml version="1.0"?><rss version="2.0"><channel>
           <title>Shared publisher</title><link>https://publisher.example.test/</link>
           <item><guid>one</guid><title>One article</title>
             <link>https://publisher.example.test/one</link></item>
         </channel></rss>`,
        { status: 200, headers: { "content-type": "application/rss+xml" } },
      );
    });
    cleanups.push(
      () => database.close(),
      () => refresh.stop(),
    );

    expect(database.connection.prepare("SELECT COUNT(*) FROM feed_sources").pluck().get()).toBe(1);
    expect(refresh.request([firstFeed.id, secondFeed.id])).toEqual({
      requested: 1,
      refreshingFeedIds: [firstFeed.id, secondFeed.id],
    });
    expect(refresh.request([secondFeed.id])).toEqual({ requested: 0, refreshingFeedIds: [] });
    await refresh.waitForIdle();

    expect(requests).toBe(1);
    expect(database.connection.prepare("SELECT COUNT(*) FROM articles").pluck().get()).toBe(1);
    expect(database.connection.prepare("SELECT COUNT(*) FROM feed_articles").pluck().get()).toBe(2);

    const firstArticle = database.articles.listArticles(firstUser.id, { state: "all" })[0];
    const secondArticle = database.articles.listArticles(secondUser.id, { state: "all" })[0];
    expect(firstArticle).toMatchObject({ id: secondArticle?.id, isRead: false, isStarred: false });

    if (!firstArticle) throw new Error("Shared article was not delivered");
    database.articles.updateArticleState(firstUser.id, firstArticle.id, {
      isRead: true,
      isStarred: true,
    });
    expect(database.articles.getArticle(firstUser.id, firstArticle.id)).toMatchObject({
      isRead: true,
      isStarred: true,
    });
    expect(database.articles.getArticle(secondUser.id, firstArticle.id)).toMatchObject({
      isRead: false,
      isStarred: false,
    });

    const firstAiArticle = database.ai.getArticleForAi(firstUser.id, firstArticle.id);
    const secondAiArticle = database.ai.getArticleForAi(secondUser.id, firstArticle.id);
    if (!firstAiArticle || !secondAiArticle) throw new Error("Shared AI source was unavailable");
    database.ai.saveArticleAiSummary(firstUser.id, firstArticle.id, firstAiArticle.revision, {
      promptVersion: 1,
      promptId: null,
      sourceKind: "excerpt",
      provider: "openai",
      model: "test-model",
      text: "First account summary",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    database.ai.saveArticleAiSummary(secondUser.id, firstArticle.id, secondAiArticle.revision, {
      promptVersion: 1,
      promptId: null,
      sourceKind: "excerpt",
      provider: "openai",
      model: "test-model",
      text: "Second account summary",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(database.ai.getArticleAiSummary(firstUser.id, firstArticle.id)?.text).toBe(
      "First account summary",
    );
    expect(database.ai.getArticleAiSummary(secondUser.id, firstArticle.id)?.text).toBe(
      "Second account summary",
    );
  });

  it("initializes a later subscription from the shared cache without backfilling old entries", async () => {
    const database = new AppDatabase(":memory:");
    const auth = new AuthService(database.auth, 20, { maxAccounts: 100 });
    const firstUser = (await auth.register("cache-owner", "reader-password"))?.user;
    const secondUser = (await auth.register("cache-reader", "reader-password"))?.user;
    if (!firstUser || !secondUser) throw new Error("Test accounts were not created");
    cleanups.push(() => database.close());

    const feedUrl = "https://publisher.example.test/archive.xml";
    const firstFeed = database.feeds.createFeed(firstUser.id, { feedUrl });
    const parsed = {
      title: "Shared archive",
      siteUrl: "https://publisher.example.test/",
      articles: Array.from({ length: 12 }, (_, index) => ({
        externalId: `article-${index + 1}`,
        title: `Article ${index + 1}`,
        url: `https://publisher.example.test/${index + 1}`,
        author: null,
        publishedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
        summary: "",
        imageUrl: null,
        feedContentHtml: null,
      })),
    };
    database.feeds.completeRefresh(firstFeed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed,
    });

    const secondFeed = database.feeds.createFeed(secondUser.id, { feedUrl });
    expect(secondFeed.totalCount).toBe(10);
    expect(database.feeds.subscriptionNeedsRefresh(secondFeed.id)).toBe(false);

    database.feeds.completeRefresh(firstFeed.id, {
      httpStatus: 304,
      etag: null,
      lastModified: null,
    });
    expect(database.feeds.getFeed(secondUser.id, secondFeed.id)?.totalCount).toBe(10);
    expect(database.connection.prepare("SELECT COUNT(*) FROM articles").pluck().get()).toBe(12);
  });

  it("shares web feeds only when their complete page selections match", async () => {
    const database = new AppDatabase(":memory:");
    const auth = new AuthService(database.auth, 20, { maxAccounts: 100 });
    const firstUser = (await auth.register("web-owner", "reader-password"))?.user;
    const secondUser = (await auth.register("web-reader", "reader-password"))?.user;
    if (!firstUser || !secondUser) throw new Error("Test accounts were not created");
    cleanups.push(() => database.close());

    const pageUrl = "https://publisher.example.test/releases";
    const config = {
      pageUrl,
      selectors: {
        item: "article",
        title: "h2",
        link: "a",
        date: null,
        author: null,
        summary: "p",
        image: null,
      },
    };
    const parsed = {
      title: "Releases",
      siteUrl: pageUrl,
      articles: [
        {
          externalId: "release-one",
          title: "Release one",
          url: `${pageUrl}/one`,
          author: null,
          publishedAt: null,
          summary: "First release",
          imageUrl: null,
          feedContentHtml: null,
        },
      ],
    };
    database.feeds.createWebFeed(firstUser.id, {
      title: "First selection",
      pageUrl,
      folderId: null,
      config,
      parsed,
    });
    database.feeds.createWebFeed(secondUser.id, {
      title: "Second selection",
      pageUrl,
      folderId: null,
      config,
      parsed,
    });
    expect(database.connection.prepare("SELECT COUNT(*) FROM feed_sources").pluck().get()).toBe(1);
    expect(database.connection.prepare("SELECT COUNT(*) FROM articles").pluck().get()).toBe(1);
    expect(database.connection.prepare("SELECT COUNT(*) FROM feed_articles").pluck().get()).toBe(2);

    database.feeds.createWebFeed(firstUser.id, {
      title: "Different selection",
      pageUrl,
      folderId: null,
      config: { ...config, selectors: { ...config.selectors, item: "li.release" } },
      parsed,
    });
    expect(database.connection.prepare("SELECT COUNT(*) FROM feed_sources").pluck().get()).toBe(2);
  });
});
