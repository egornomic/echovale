import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { youtubeMediaFromUrl } from "../../src/server/article-media.js";
import { AppDatabase, type ParsedFeed } from "../../src/server/database.js";
import { ExtractionQueue, extractArticle } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";

const cleanups: Array<() => Promise<void> | void> = [];
const TEST_USER_ID = 1;
const TEST_ACCOUNT = { username: "reader", password: "test-password" };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function temporaryDatabase(): Promise<AppDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "feedfold-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return new AppDatabase(join(directory, "feedfold.db"));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("feed refresh and full-text extraction", () => {
  it("starts new subscriptions with the 10 latest articles without backfilling older entries", async () => {
    let latestArticle = 12;
    const server = createServer((_request, response) => {
      const items = Array.from({ length: latestArticle }, (_, index) => index + 1)
        .map(
          (article) => `<item>
            <guid>article-${article}</guid>
            <title>Article ${article}</title>
            <link>https://example.test/articles/${article}</link>
            <pubDate>${new Date(Date.UTC(2026, 6, article)).toUTCString()}</pubDate>
          </item>`,
        )
        .join("");
      response.writeHead(200, { "Content-Type": "application/rss+xml" });
      response.end(`<?xml version="1.0"?><rss version="2.0"><channel>
        <title>Busy feed</title><link>https://example.test/</link><description>Updates</description>
        ${items}
      </channel></rss>`);
    });
    const feedUrl = await listen(server);
    const database = await temporaryDatabase();
    const refresh = new FeedRefreshService(database.feeds, 1, 2_000, undefined, fetch);
    cleanups.push(async () => {
      await refresh.stop();
      database.close();
    });

    const feed = database.feeds.createFeed(TEST_USER_ID, { feedUrl });
    refresh.request([feed.id]);
    await refresh.waitForIdle();

    const initialArticles = database.articles.listArticles(TEST_USER_ID, {
      state: "all",
      feedId: feed.id,
    });
    expect(initialArticles.map(({ title }) => title)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Article ${12 - index}`),
    );

    latestArticle = 13;
    refresh.request([feed.id]);
    await refresh.waitForIdle();

    const refreshedArticles = database.articles.listArticles(TEST_USER_ID, {
      state: "all",
      feedId: feed.id,
    });
    expect(refreshedArticles.map(({ title }) => title)).toEqual(
      Array.from({ length: 11 }, (_, index) => `Article ${13 - index}`),
    );
  });

  it("shows sanitized feed content until publisher extraction is explicitly requested", async () => {
    let baseUrl = "";
    let feedRequests = 0;
    let articleRequests = 0;
    let missingRequests = 0;
    let conditionalHeader: string | undefined;
    let forceFullResponse = false;
    let revised = false;
    const articleText = Array.from(
      { length: 40 },
      () => "A substantial article paragraph keeps the readability result representative.",
    ).join(" ");
    const server = createServer((request, response) => {
      if (request.url === "/feed") {
        feedRequests += 1;
        conditionalHeader = request.headers["if-none-match"];
        if (conditionalHeader === '"v1"' && !forceFullResponse) {
          response.writeHead(304, { ETag: '"v1"' });
          response.end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/rss+xml",
          ETag: '"v1"',
          "Last-Modified": "Mon, 13 Jul 2026 12:00:00 GMT",
        });
        response.end(`<?xml version="1.0"?>
          <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
            <channel>
              <title>Remote title</title><link>${baseUrl}</link><description>Test feed</description>
              <item><guid>article-1</guid><title>${revised ? "Extract me (corrected)" : "Extract me"}</title><link>${baseUrl}/article</link>
                <description>${revised ? "Corrected feed summary" : "Short feed summary"}</description></item>
              <item><guid>article-2</guid><title>Use fallback</title><link>${baseUrl}/missing</link>
                <content:encoded><![CDATA[<div><p>Complete text supplied by the feed.</p><script>bad()</script></div>]]></content:encoded>
              </item>
            </channel>
          </rss>`);
        return;
      }
      if (request.url === "/article") {
        articleRequests += 1;
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(`<!doctype html><html><head><title>Extract me</title></head><body>
          <article><h1>${revised ? "Corrected article" : "Extract me"}</h1><p>${articleText}</p>
          <a href="/more">Related</a><img src="/image.jpg" alt="Example"><script>bad()</script></article>
        </body></html>`);
        return;
      }
      if (request.url === "/missing") {
        missingRequests += 1;
        response.writeHead(503).end("offline");
        return;
      }
      if (request.url === "/broken") {
        response.writeHead(503).end("offline");
        return;
      }
      if (request.url === "/video") {
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": "847456566",
        });
        response.end("not article HTML");
        return;
      }
      if (request.url === "/oversized") {
        response.writeHead(200, {
          "Content-Type": "text/html",
          "Content-Length": String(5 * 1024 * 1024 + 1),
        });
        response.end("<p>declared too large</p>");
        return;
      }
      response.writeHead(404).end();
    });
    baseUrl = await listen(server);

    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database.extractions, 2, 2_000, fetch);
    const refresh = new FeedRefreshService(database.feeds, 2, 2_000, undefined, fetch);
    const authService = new AuthService(database.auth);
    expect(await authService.register(TEST_ACCOUNT.username, TEST_ACCOUNT.password)).not.toBeNull();
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
    });
    cleanups.push(async () => {
      await app.close();
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: TEST_ACCOUNT,
    });
    const setCookie = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];

    const media = await extractArticle(
      {
        id: 100,
        url: `${baseUrl}/video`,
      },
      20_000,
      fetch,
    );
    expect(media).toMatchObject({
      status: "failed",
      contentSource: null,
      error: "The source returned video/mp4 instead of an HTML page.",
    });
    const oversized = await extractArticle(
      {
        id: 101,
        url: `${baseUrl}/oversized`,
      },
      20_000,
      fetch,
    );
    expect(oversized).toMatchObject({
      status: "failed",
      contentSource: null,
      error: "The source page is larger than the 5 MiB full-article limit.",
    });

    const feed = database.feeds.createFeed(TEST_USER_ID, { feedUrl: `${baseUrl}/feed` });
    expect(refresh.request([feed.id])).toEqual({ requested: 1, refreshingFeedIds: [feed.id] });
    await refresh.waitForIdle();
    await extraction.waitForIdle();
    expect(articleRequests).toBe(0);
    expect(missingRequests).toBe(0);
    expect(database.extractions.getPendingExtractions()).toEqual([]);

    const articles = database.articles.listArticles(TEST_USER_ID, {
      state: "all",
      includeContent: true,
    });
    expect(articles).toHaveLength(2);
    const extracted = articles.find((article) => article.title === "Extract me");
    expect(extracted).toMatchObject({
      extractionStatus: "feed",
      contentSource: null,
      contentHtml: null,
    });
    expect(extracted?.feedContentHtml).toContain("Short feed summary");
    if (!extracted) throw new Error("Feed article was not stored");

    const fallback = articles.find((article) => article.title === "Use fallback");
    expect(fallback).toMatchObject({
      extractionStatus: "feed",
      contentSource: null,
      contentHtml: null,
    });
    expect(fallback?.feedContentHtml).toContain("Complete text supplied by the feed");
    expect(fallback?.feedContentHtml).not.toContain("<script");
    if (!fallback) throw new Error("Fallback article was not stored");

    const extractResponse = await app.inject({
      method: "POST",
      url: `/api/articles/${extracted.id}/extract`,
      headers: { cookie: cookie ?? "" },
    });
    expect(extractResponse.statusCode).toBe(200);
    expect(["pending", "processing"]).toContain(extractResponse.json().extractionStatus);
    await extraction.waitForIdle();
    expect(articleRequests).toBe(1);
    expect(database.articles.getArticle(TEST_USER_ID, extracted.id)).toMatchObject({
      extractionStatus: "complete",
      contentSource: "article",
    });
    const fullContent = database.articles.getArticle(TEST_USER_ID, extracted.id)?.contentHtml;
    expect(fullContent).toContain(`href="${baseUrl}/more"`);
    expect(fullContent).toContain('target="_blank"');
    expect(fullContent).toContain(`src="${baseUrl}/image.jpg"`);
    expect(fullContent).not.toContain("<script");

    const magazineArticle = database.articles
      .listArticles(TEST_USER_ID, { state: "all" })
      .find((article) => article.id === extracted.id);
    expect(magazineArticle).toMatchObject({
      extractionStatus: "complete",
      contentHtml: null,
    });
    const cachedResponse = await app.inject({
      method: "POST",
      url: `/api/articles/${extracted.id}/extract`,
      headers: { cookie: cookie ?? "" },
    });
    expect(cachedResponse.statusCode).toBe(200);
    expect(cachedResponse.json()).toMatchObject({
      extractionStatus: "complete",
      contentHtml: expect.stringContaining("A substantial article paragraph"),
    });
    await extraction.waitForIdle();
    expect(articleRequests).toBe(1);

    const failedResponse = await app.inject({
      method: "POST",
      url: `/api/articles/${fallback.id}/extract`,
      headers: { cookie: cookie ?? "" },
    });
    expect(failedResponse.statusCode).toBe(200);
    await extraction.waitForIdle();
    expect(missingRequests).toBe(1);
    expect(database.articles.getArticle(TEST_USER_ID, fallback.id)).toMatchObject({
      extractionStatus: "failed",
      contentHtml: null,
      feedContentHtml: expect.stringContaining("Complete text supplied by the feed"),
      extractionError: "The source page returned HTTP 503.",
    });

    expect(database.feeds.getFeed(TEST_USER_ID, feed.id)?.title).toBe("Remote title");
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    expect(feedRequests).toBe(2);
    expect(conditionalHeader).toBe('"v1"');
    expect(database.feeds.getFeed(TEST_USER_ID, feed.id)?.lastHttpStatus).toBe(304);
    expect(database.articles.listArticles(TEST_USER_ID, { state: "all" })).toHaveLength(2);

    database.articles.updateArticleState(TEST_USER_ID, extracted.id, {
      isRead: true,
      isStarred: true,
    });
    forceFullResponse = true;
    revised = true;
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    expect(feedRequests).toBe(3);
    expect(articleRequests).toBe(1);
    expect(database.articles.getArticle(TEST_USER_ID, extracted.id)).toMatchObject({
      title: "Extract me (corrected)",
      summary: "Corrected feed summary",
      isRead: true,
      isStarred: true,
      extractionStatus: "feed",
      contentHtml: null,
    });
    expect(database.articles.getArticle(TEST_USER_ID, extracted.id)?.feedContentHtml).toContain(
      "Corrected feed summary",
    );
    expect(database.articles.listArticles(TEST_USER_ID, { state: "all" })).toHaveLength(2);

    const broken = database.feeds.createFeed(TEST_USER_ID, {
      feedUrl: `${baseUrl}/broken`,
      title: "Broken",
    });
    refresh.request([broken.id]);
    await refresh.waitForIdle();
    expect(database.feeds.getFeed(TEST_USER_ID, broken.id)).toMatchObject({
      lastHttpStatus: 503,
      lastSuccessAt: null,
      refreshing: false,
    });
    expect(database.feeds.getFeed(TEST_USER_ID, broken.id)?.lastError).toContain("HTTP 503");
  });

  it("uses the publisher's WordPress API when bot protection replaces its feed", async () => {
    let wordpressRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/feed") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            message:
              "Access denied by Imunify360 bot-protection. IPs used for automation should be whitelisted",
          }),
        );
        return;
      }
      if (request.url?.startsWith("/wp-json/wp/v2/posts?")) {
        wordpressRequests += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify([
            {
              id: 1292,
              guid: { rendered: `http://${request.headers.host}/?p=1292` },
              date_gmt: "2026-01-12T10:56:53",
              link: `http://${request.headers.host}/story`,
              title: { rendered: "Publisher &amp; post" },
              excerpt: { rendered: "<p>Fallback summary.</p>" },
              content: { rendered: "<p>Complete first-party post content.</p>" },
            },
          ]),
        );
        return;
      }
      if (request.url === "/story") {
        response.writeHead(503).end("offline");
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database.extractions, 1, 2_000, fetch);
    const refresh = new FeedRefreshService(database.feeds, 1, 2_000, undefined, fetch);
    cleanups.push(async () => {
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    const feed = database.feeds.createFeed(TEST_USER_ID, {
      feedUrl: `${baseUrl}/feed`,
      title: "Publisher",
    });
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    await extraction.waitForIdle();

    expect(wordpressRequests).toBe(1);
    expect(database.feeds.getFeed(TEST_USER_ID, feed.id)).toMatchObject({
      title: "Publisher",
      siteUrl: baseUrl,
      lastHttpStatus: 200,
      lastError: null,
      totalCount: 1,
    });
    expect(
      database.articles.listArticles(TEST_USER_ID, { state: "all", includeContent: true })[0],
    ).toMatchObject({
      title: "Publisher & post",
      summary: "Fallback summary.",
      feedContentHtml: "<p>Complete first-party post content.</p>",
      contentHtml: null,
      contentSource: null,
      extractionStatus: "feed",
    });
  });

  it("identifies browser-verification responses instead of reporting parser errors", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/imunify") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"message":"Access denied by Imunify360 bot-protection"}');
        return;
      }
      if (request.url === "/cloudflare") {
        response.writeHead(403, { "cf-mitigated": "challenge" }).end("challenge");
        return;
      }
      if (request.url === "/vercel") {
        response.writeHead(429, { "x-vercel-mitigated": "challenge" }).end("challenge");
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database.extractions, 1, 2_000, fetch);
    const refresh = new FeedRefreshService(database.feeds, 3, 2_000, undefined, fetch);
    cleanups.push(async () => {
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    const feeds = ["imunify", "cloudflare", "vercel"].map((provider) =>
      database.feeds.createFeed(TEST_USER_ID, {
        feedUrl: `${baseUrl}/${provider}`,
        title: provider,
      }),
    );
    refresh.request(feeds.map((feed) => feed.id));
    await refresh.waitForIdle();

    expect(feeds.map((feed) => database.feeds.getFeed(TEST_USER_ID, feed.id)?.lastError)).toEqual([
      "This feed requires browser verification from Imunify360, so feedfold cannot refresh it automatically.",
      "This feed requires browser verification from Cloudflare, so feedfold cannot refresh it automatically.",
      "This feed requires browser verification from Vercel, so feedfold cannot refresh it automatically.",
    ]);
  });

  it("stores large feed batches without scheduling publisher extraction", async () => {
    const database = await temporaryDatabase();
    cleanups.push(() => database.close());
    const feed = database.feeds.createFeed(TEST_USER_ID, {
      feedUrl: "https://example.test/feed",
      title: "Batch",
    });
    const parsed: ParsedFeed = {
      title: "Batch",
      siteUrl: "https://example.test",
      articles: Array.from({ length: 125 }, (_, index) => ({
        externalId: `article-${index}`,
        title: `Article ${index}`,
        url: null,
        author: null,
        publishedAt: null,
        summary: "",
        imageUrl: null,
        feedContentHtml: `<p>Readable feed content ${index}</p>`,
      })),
    };
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed,
    });

    const count = database.connection
      .prepare("SELECT COUNT(*) AS count FROM articles WHERE extraction_status = 'feed'")
      .get() as { count: number };
    expect(count.count).toBe(125);
    expect(database.extractions.getPendingExtractions()).toHaveLength(0);

    const firstPage = database.articles.listArticlePage(TEST_USER_ID, { state: "all", limit: 100 });
    expect(firstPage.articles).toHaveLength(100);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = database.articles.listArticlePage(TEST_USER_ID, {
      state: "all",
      limit: 100,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.articles).toHaveLength(25);
    expect(secondPage.nextCursor).toBeNull();
    const fullQueue = [...firstPage.articles, ...secondPage.articles];
    expect(new Set(fullQueue.map((article) => article.id)).size).toBe(125);

    const targetIndex = 112;
    const target = fullQueue[targetIndex];
    if (!target) throw new Error("Deep queue target was not stored");
    expect(firstPage.articles.some((article) => article.id === target.id)).toBe(false);

    const anchoredPage = database.articles.listArticlePage(TEST_USER_ID, {
      state: "all",
      limit: 20,
      anchorId: target.id,
    });
    expect(anchoredPage.anchorIndex).toBe(10);
    expect(anchoredPage.articles.map((article) => article.id)).toEqual(
      fullQueue.slice(targetIndex - 10, targetIndex + 10).map((article) => article.id),
    );
    expect(anchoredPage.nextCursor).not.toBeNull();

    database.articles.updateArticleState(TEST_USER_ID, target.id, { isRead: true });
    const unreadAnchoredPage = database.articles.listArticlePage(TEST_USER_ID, {
      state: "unread",
      limit: 20,
      anchorId: target.id,
    });
    expect(unreadAnchoredPage.anchorIndex).toBe(10);
    expect(unreadAnchoredPage.articles[9]?.id).toBe(fullQueue[targetIndex - 1]?.id);
    expect(unreadAnchoredPage.articles[10]?.id).toBe(target.id);
    expect(unreadAnchoredPage.articles[11]?.id).toBe(fullQueue[targetIndex + 1]?.id);
    const unreadOlderPage = database.articles.listArticlePage(TEST_USER_ID, {
      state: "unread",
      limit: 20,
      cursor: unreadAnchoredPage.nextCursor ?? undefined,
    });
    expect(unreadOlderPage.articles.map((article) => article.id)).toEqual(
      fullQueue.slice(targetIndex + 10).map((article) => article.id),
    );
  });

  it("skips exact URL or title duplicates across feeds within the configured window", async () => {
    const database = await temporaryDatabase();
    cleanups.push(() => database.close());
    const authService = new AuthService(database.auth, 20, { allowPublicRegistration: true });
    const reader = (await authService.register("reader", "reader-password"))?.user;
    const partner = (await authService.register("partner", "partner-password"))?.user;
    if (!reader || !partner) throw new Error("Expected test accounts");

    const article = (externalId: string, title: string, url: string) => ({
      externalId,
      title,
      url,
      author: null,
      publishedAt: null,
      summary: "",
      imageUrl: null,
      feedContentHtml: null,
    });
    const refreshFeed = (feedId: number, articles: ParsedFeed["articles"]) =>
      database.feeds.completeRefresh(feedId, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        parsed: { title: "Feed", siteUrl: "https://example.test", articles },
      });
    const sourceFeed = database.feeds.createFeed(reader.id, {
      feedUrl: "https://example.test/source-feed",
    });
    refreshFeed(sourceFeed.id, [
      article("recent-url", "URL source", "https://example.test/shared-url"),
      article("recent-title", "Exact shared title", "https://example.test/title-source"),
      article("two-day-one", "Two-day one-day window", "https://example.test/two-day-one"),
      article("two-day-seven", "Two-day seven-day window", "https://example.test/two-day-seven"),
      article("eight-day-thirty", "Eight-day title", "https://example.test/eight-day"),
      article("empty-source", "", "https://example.test/empty-source"),
    ]);

    const setDiscoveredAge = (externalId: string, days: number) => {
      database.connection
        .prepare(
          `UPDATE feed_articles
           SET delivered_at = ?
           WHERE article_id = (SELECT id FROM articles WHERE external_id = ?)`,
        )
        .run(new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString(), externalId);
    };
    setDiscoveredAge("two-day-one", 2);
    setDiscoveredAge("two-day-seven", 2);
    setDiscoveredAge("eight-day-thirty", 8);

    database.settings.updateSettings(reader.id, { duplicateArticleWindowDays: 1 });
    const oneDayFeed = database.feeds.createFeed(reader.id, {
      feedUrl: "https://example.test/one-day-feed",
    });
    refreshFeed(oneDayFeed.id, [
      article("url-copy", "Different URL-copy title", "https://example.test/shared-url"),
      article("title-copy", "Exact shared title", "https://example.test/title-copy"),
      article("case-copy", "exact shared title", "https://example.test/case-copy"),
      article("two-day-copy", "Two-day one-day window", "https://example.test/two-day-one"),
      article("empty-copy-one", "", "https://example.test/empty-copy-one"),
      article("empty-copy-two", "", "https://example.test/empty-copy-two"),
      article("batch-original", "Same-batch title", "https://example.test/batch-original"),
      article("batch-copy", "Same-batch title", "https://example.test/batch-copy"),
    ]);

    database.settings.updateSettings(reader.id, { duplicateArticleWindowDays: 7 });
    const sevenDayFeed = database.feeds.createFeed(reader.id, {
      feedUrl: "https://example.test/seven-day-feed",
    });
    refreshFeed(sevenDayFeed.id, [
      article("seven-day-copy", "Two-day seven-day window", "https://example.test/two-day-seven"),
      article("seven-day-unique", "Seven-day unique", "https://example.test/seven-day-unique"),
    ]);

    database.settings.updateSettings(reader.id, { duplicateArticleWindowDays: 30 });
    const thirtyDayFeed = database.feeds.createFeed(reader.id, {
      feedUrl: "https://example.test/thirty-day-feed",
    });
    refreshFeed(thirtyDayFeed.id, [
      article("thirty-day-copy", "Eight-day title", "https://example.test/eight-day"),
      article("thirty-day-unique", "Thirty-day unique", "https://example.test/thirty-day-unique"),
    ]);

    const readerArticleIds = database.connection
      .prepare(
        `SELECT articles.external_id
         FROM feed_articles
         JOIN articles ON articles.id = feed_articles.article_id
         JOIN feeds ON feeds.id = feed_articles.feed_id
         WHERE feeds.user_id = ?`,
      )
      .pluck()
      .all(reader.id) as string[];
    expect(readerArticleIds).not.toContain("url-copy");
    expect(readerArticleIds).not.toContain("title-copy");
    expect(readerArticleIds).not.toContain("batch-copy");
    expect(readerArticleIds).not.toContain("seven-day-copy");
    expect(readerArticleIds).not.toContain("thirty-day-copy");
    expect(readerArticleIds).toEqual(
      expect.arrayContaining([
        "case-copy",
        "two-day-copy",
        "empty-copy-one",
        "empty-copy-two",
        "batch-original",
        "seven-day-unique",
        "thirty-day-unique",
      ]),
    );

    const partnerFeed = database.feeds.createFeed(partner.id, {
      feedUrl: "https://example.test/partner-feed",
    });
    refreshFeed(partnerFeed.id, [
      article("partner-copy", "Exact shared title", "https://example.test/shared-url"),
    ]);
    expect(database.articles.listArticles(partner.id, { state: "all" })).toMatchObject([
      { title: "Exact shared title", url: "https://example.test/shared-url" },
    ]);
  });

  it("preserves an extracted thumbnail when feed metadata changes", async () => {
    const database = await temporaryDatabase();
    cleanups.push(() => database.close());
    const feed = database.feeds.createFeed(TEST_USER_ID, {
      feedUrl: "https://example.test/feed",
      title: "Feed",
    });
    const parsedArticle = {
      externalId: "story",
      title: "Original title",
      url: "https://example.test/story",
      author: null,
      publishedAt: null,
      summary: "Summary",
      imageUrl: null,
      feedContentHtml: "<p>Feed summary without an image.</p>",
    };
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: { title: "Feed", siteUrl: "https://example.test", articles: [parsedArticle] },
    });
    const articleId = database.articles.listArticles(TEST_USER_ID, { state: "all" })[0]?.id;
    if (!articleId) throw new Error("Article was not stored");
    expect(database.extractions.requestExtraction(TEST_USER_ID, articleId)).toBe(true);
    expect(database.extractions.markExtractionProcessing(articleId)).toBe(true);
    database.extractions.completeExtraction(articleId, {
      contentHtml: '<p>Full article.</p><img src="https://cdn.example.test/hero.jpg">',
      imageUrl: "https://cdn.example.test/hero.jpg",
      contentSource: "article",
      status: "complete",
      error: null,
    });

    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: "Feed",
        siteUrl: "https://example.test",
        articles: [{ ...parsedArticle, title: "Updated title" }],
      },
    });

    expect(database.articles.getArticle(TEST_USER_ID, articleId)).toMatchObject({
      title: "Updated title",
      imageUrl: "https://cdn.example.test/hero.jpg",
      extractionStatus: "complete",
    });
  });

  it("does not let an obsolete extraction overwrite a changed feed item", async () => {
    const database = await temporaryDatabase();
    cleanups.push(() => database.close());
    const feed = database.feeds.createFeed(TEST_USER_ID, {
      feedUrl: "https://example.test/feed",
      title: "Feed",
    });
    const article = {
      externalId: "story",
      title: "Story",
      url: "https://example.test/old-story",
      author: null,
      publishedAt: null,
      summary: "Old summary",
      imageUrl: null,
      feedContentHtml: "<p>Old feed article.</p>",
    };
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: { title: "Feed", siteUrl: "https://example.test", articles: [article] },
    });
    const articleId = database.articles.listArticles(TEST_USER_ID, { state: "all" })[0]?.id;
    if (!articleId) throw new Error("Article was not stored");
    expect(database.extractions.requestExtraction(TEST_USER_ID, articleId)).toBe(true);
    expect(database.extractions.markExtractionProcessing(articleId)).toBe(true);

    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: "Feed",
        siteUrl: "https://example.test",
        articles: [
          {
            ...article,
            url: "https://example.test/new-story",
            summary: "New summary",
            feedContentHtml: "<p>New feed article.</p>",
          },
        ],
      },
    });
    database.extractions.completeExtraction(articleId, {
      contentHtml: "<p>Obsolete extracted article.</p>",
      imageUrl: null,
      contentSource: "article",
      status: "complete",
      error: null,
    });

    expect(database.articles.getArticle(TEST_USER_ID, articleId)).toMatchObject({
      url: "https://example.test/new-story",
      summary: "New summary",
      feedContentHtml: "<p>New feed article.</p>",
      contentHtml: null,
      extractionStatus: "feed",
    });
  });

  it("stores playable media without text extraction and filters Shorts by media type", async () => {
    const database = await temporaryDatabase();
    cleanups.push(() => database.close());
    const feed = database.feeds.createFeed(TEST_USER_ID, {
      feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCexample",
      title: "Video feed",
    });
    const video = youtubeMediaFromUrl("https://www.youtube.com/watch?v=regular123");
    const short = youtubeMediaFromUrl("https://www.youtube.com/shorts/short123");
    if (!video || !short) throw new Error("Expected YouTube media metadata");

    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: "Video feed",
        siteUrl: "https://www.youtube.com/channel/UCexample",
        articles: [
          {
            externalId: "regular123",
            title: "Regular upload",
            url: "https://www.youtube.com/watch?v=regular123",
            author: "Example channel",
            publishedAt: "2026-07-16T13:00:20.000Z",
            summary: "Regular description",
            imageUrl: video.thumbnailUrl,
            media: video,
            feedContentHtml: null,
          },
          {
            externalId: "short123",
            title: "Short upload",
            url: "https://www.youtube.com/shorts/short123",
            author: "Example channel",
            publishedAt: "2026-07-15T14:09:22.000Z",
            summary: "",
            imageUrl: short.thumbnailUrl,
            media: short,
            feedContentHtml: null,
          },
        ],
      },
    });

    expect(database.articles.listArticles(TEST_USER_ID, { state: "all" })).toMatchObject([
      { title: "Regular upload", extractionStatus: "feed", media: { type: "video" } },
      { title: "Short upload", extractionStatus: "feed", media: { type: "short" } },
    ]);

    const rule = database.rules.createRule(TEST_USER_ID, {
      name: "Hide Shorts",
      conditions: [{ field: "media", pattern: "short" }],
      conditionOperator: "and",
      action: "hide",
    });
    expect(rule.matchedCount).toBe(1);
    expect(
      database.articles
        .listArticles(TEST_USER_ID, { state: "all" })
        .map((article) => article.title),
    ).toEqual(["Regular upload"]);
  });

  it("prioritizes an explicitly loaded article ahead of queued requests", async () => {
    let releaseFirst: (() => void) | undefined;
    let reportFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requestOrder: string[] = [];
    const articleBody = `<article><h1>Readable</h1><p>${"Article text. ".repeat(80)}</p></article>`;
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      requestOrder.push(path);
      if (path === "/first") {
        reportFirstStarted?.();
        void firstReleased.then(() => {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end(articleBody);
        });
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(articleBody);
    });
    const baseUrl = await listen(server);
    const database = await temporaryDatabase();
    const extraction = new ExtractionQueue(database.extractions, 1, 2_000, fetch);
    const refresh = new FeedRefreshService(database.feeds, 1, 2_000, undefined, fetch);
    const authService = new AuthService(database.auth);
    expect(await authService.register(TEST_ACCOUNT.username, TEST_ACCOUNT.password)).not.toBeNull();
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
    });
    cleanups.push(async () => {
      releaseFirst?.();
      await app.close();
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    const feed = database.feeds.createFeed(TEST_USER_ID, {
      feedUrl: `${baseUrl}/feed`,
      title: "Priority",
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: "Priority",
        siteUrl: baseUrl,
        articles: ["first", "second", "opened"].map((name) => ({
          externalId: name,
          title: name,
          url: `${baseUrl}/${name}`,
          author: null,
          publishedAt: null,
          summary: "",
          imageUrl: null,
          feedContentHtml: null,
        })),
      },
    });
    const articleIds = new Map(
      database.articles
        .listArticles(TEST_USER_ID, { state: "all" })
        .map((article) => [article.title, article.id]),
    );
    const firstId = articleIds.get("first");
    const secondId = articleIds.get("second");
    const openedId = articleIds.get("opened");
    if (!firstId || !secondId || !openedId) throw new Error("Expected queued articles");

    expect(database.extractions.requestExtraction(TEST_USER_ID, firstId)).toBe(true);
    extraction.prioritize(firstId);
    await firstStarted;
    expect(database.extractions.requestExtraction(TEST_USER_ID, secondId)).toBe(true);
    extraction.prioritize(secondId);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: TEST_ACCOUNT,
    });
    const setCookie = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    const response = await app.inject({
      method: "POST",
      url: `/api/articles/${openedId}/extract`,
      headers: { cookie: cookie ?? "" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: openedId, extractionStatus: "pending" });
    releaseFirst?.();
    await extraction.waitForIdle();

    expect(requestOrder).toEqual(["/first", "/opened", "/second"]);
  });

  it("rejects private full-article targets before sending a request", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><article><h1>Private article</h1></article>");
    });
    const baseUrl = await listen(server);

    const outcome = await extractArticle({ id: 1, url: baseUrl });

    expect(outcome).toMatchObject({
      status: "failed",
      error: "This page is not public. Use a page that is available on the public internet.",
    });
    expect(hits).toBe(0);
  });
});
