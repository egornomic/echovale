import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../../src/server/database.js";
import { discoverFeed } from "../../src/server/feed-discovery.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import { fetchXFeed, nitterBaseUrls } from "../../src/server/x-feed.js";
import { xFeedUrl, xVideoPostId } from "../../src/shared/x.js";

const cleanups: Array<() => void | Promise<void>> = [];
const POST_ID = "2095678312773554533";
const FEED_URL = "https://x.com/banteg/rss";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rss(origin: string, ids = [POST_ID]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>banteg / @banteg</title><link>${origin}/banteg</link>
    ${ids
      .map(
        (id) => `<item><guid isPermaLink="false">${id}</guid>
      <title>A post with a video.</title><link>${origin}/banteg/status/${id}#m</link>
      <description><![CDATA[<p>A post with a video.</p>
        <a href="${origin}/banteg/status/${id}#m"><br>Video<br>
        <img src="${origin}/pic/media%2Fposter.jpg"></a>]]></description>
    </item>`,
      )
      .join("")}
  </channel></rss>`;
}

describe("X RSS instances", () => {
  it("uses the configured order and accepts new instance hosts without frontend configuration", () => {
    const bases = nitterBaseUrls(
      " https://first.example/ ,https://second.example,https://first.example ",
    );
    expect(bases).toEqual(["https://first.example", "https://second.example"]);
    expect(xFeedUrl("https://second.example/banteg/media?filter=videos", bases)).toBe(
      "https://x.com/banteg/media/rss?filter=videos",
    );
    expect(xFeedUrl("https://unrelated.example/banteg", bases)).toBeNull();
    expect(() => nitterBaseUrls("https://first.example,not-a-url")).toThrow("NITTER_BASE_URLS");
    expect(() => nitterBaseUrls("https://first.example/private/path")).toThrow("NITTER_BASE_URLS");
  });

  it("discovers posts through the third instance after a rate limit and an HTML challenge", async () => {
    const requests: string[] = [];
    const limited = await serve((request, response) => {
      requests.push(`limited:${request.url}`);
      response.writeHead(429).end("Instance has been rate limited.");
    });
    const challenge = await serve((request, response) => {
      requests.push(`challenge:${request.url}`);
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<html><title>Prove You're Human</title></html>");
    });
    let working = "";
    working = await serve((request, response) => {
      requests.push(`working:${request.url}`);
      response.writeHead(200, { "Content-Type": "application/rss+xml" }).end(rss(working));
    });
    vi.stubEnv("NITTER_BASE_URLS", [limited, challenge, working].join(","));

    await expect(
      discoverFeed(`${limited}/banteg/media?filter=videos`, 500, fetch),
    ).resolves.toMatchObject({
      kind: "published",
      preview: {
        feedUrl: "https://x.com/banteg/media/rss?filter=videos",
        siteUrl: "https://x.com/banteg",
        totalArticles: 1,
        articles: [
          {
            title: "",
            url: `https://x.com/banteg/status/${POST_ID}#m`,
            imageUrl: "https://pbs.twimg.com/media/poster.jpg",
          },
        ],
      },
    });
    expect(requests).toEqual([
      "limited:/banteg/media/rss?filter=videos",
      "challenge:/banteg/media/rss?filter=videos",
      "working:/banteg/media/rss?filter=videos",
    ]);
  });

  it("gives the fallback its own deadline when the first instance stops responding", async () => {
    const stalled = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/rss+xml" });
      response.write('<?xml version="1.0"?>');
    });
    let working = "";
    working = await serve((_request, response) => response.end(rss(working)));
    const parsed = await fetchXFeed(FEED_URL, 100, fetch, undefined, [stalled, working]);
    expect(parsed.articles).toHaveLength(1);
    expect(xVideoPostId(parsed.articles[0]?.url, parsed.articles[0]?.feedContentHtml)).toBe(
      POST_ID,
    );
  });

  it("reports failure without importing an RSS whitelist notice when all instances fail", async () => {
    const notice = await serve((_request, response) =>
      response.end(`
      <rss version="2.0"><channel><title>RSS reader not yet whitelisted!</title>
      <link>https://rss.xcancel.com/banteg/rss</link><item><guid>notice</guid>
      <title>RSS reader not yet whitelisted!</title><link>https://rss.xcancel.com/banteg/rss</link>
      </item></channel></rss>`),
    );
    const disabled = await serve((_request, response) =>
      response.writeHead(403).end("RSS feed is disabled"),
    );
    vi.stubEnv("NITTER_BASE_URLS", [notice, disabled].join(","));
    const database = new AppDatabase(":memory:");
    const refresh = new FeedRefreshService(database.feeds, 1, 500, undefined, fetch);
    cleanups.push(
      () => database.close(),
      () => refresh.stop(),
    );
    const feed = database.feeds.createFeed(1, { feedUrl: FEED_URL });
    refresh.request([feed.id]);
    await refresh.waitForIdle();

    expect(database.feeds.getFeed(1, feed.id)).toMatchObject({
      healthStatus: "failing",
      lastHttpStatus: 403,
      lastErrorKind: "access_blocked",
      totalCount: 0,
    });
    expect(database.feeds.getFeed(1, feed.id)?.lastError).toContain(
      "RSS contains a notice instead of X posts",
    );
  });

  it("keeps article identities and read/starred state through fallback and instance-list changes", async () => {
    let primaryAvailable = true;
    const requests: string[] = [];
    let primary = "";
    primary = await serve((request, response) => {
      requests.push("primary");
      expect(request.headers["if-none-match"]).toBeUndefined();
      if (!primaryAvailable) response.writeHead(503).end();
      else response.end(rss(primary));
    });
    let fallback = "";
    fallback = await serve((_request, response) => {
      requests.push("fallback");
      response.end(rss(fallback, [POST_ID, "2095678312773554534"]));
    });
    let replacement = "";
    replacement = await serve((_request, response) => {
      requests.push("replacement");
      response.end(rss(replacement, [POST_ID, "2095678312773554534", "2095678312773554535"]));
    });
    vi.stubEnv("NITTER_BASE_URLS", [primary, fallback].join(","));
    const database = new AppDatabase(":memory:");
    const refresh = new FeedRefreshService(database.feeds, 1, 500, undefined, fetch);
    cleanups.push(
      () => database.close(),
      () => refresh.stop(),
    );
    const feed = database.feeds.createFeed(1, { feedUrl: `${primary}/banteg/rss` });
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    expect(requests).toEqual(["primary"]);
    const article = database.articles.listArticles(1, { state: "all" })[0];
    if (!article) throw new Error("Expected the initial X post");
    database.articles.updateArticleState(1, article.id, { isRead: true, isStarred: true });

    primaryAvailable = false;
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    expect(requests).toEqual(["primary", "primary", "fallback"]);
    expect(database.feeds.getFeed(1, feed.id)).toMatchObject({
      feedUrl: FEED_URL,
      totalCount: 2,
      healthStatus: "healthy",
    });
    expect(database.articles.getArticle(1, article.id)).toMatchObject({
      isRead: true,
      isStarred: true,
    });

    vi.stubEnv("NITTER_BASE_URLS", replacement);
    refresh.request([feed.id]);
    await refresh.waitForIdle();
    expect(requests.at(-1)).toBe("replacement");
    expect(database.feeds.getFeed(1, feed.id)).toMatchObject({
      feedUrl: FEED_URL,
      totalCount: 3,
      healthStatus: "healthy",
    });
    expect(database.articles.getArticle(1, article.id)).toMatchObject({
      isRead: true,
      isStarred: true,
    });
    const exported = database.opml.export(1);
    expect(exported).toContain(`${replacement}/banteg/rss`);
    expect(database.opml.import(1, exported)).toMatchObject({ imported: 0, duplicates: 1 });
  });
});
