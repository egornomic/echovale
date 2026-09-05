import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFeed } from "../../src/server/feed-discovery.js";
import { githubFeedUrl } from "../../src/server/feed-http.js";
import { xFeedUrl } from "../../src/shared/x.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rss(baseUrl: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>The Example Pond</title><link>${baseUrl}/</link><description>Example feed</description>
    <item><guid>one</guid><title>First entry</title><link>${baseUrl}/first</link>
      <author>Ada</author><pubDate>Wed, 15 Jul 2026 12:00:00 GMT</pubDate>
      <description><![CDATA[<p>A useful first summary.</p>]]></description></item>
    <item><guid>two</guid><title>Second entry</title><link>${baseUrl}/second</link></item>
    <item><guid>three</guid><title>Third entry</title><link>${baseUrl}/third</link></item>
    <item><guid>four</guid><title>Fourth entry</title><link>${baseUrl}/fourth</link></item>
  </channel></rss>`;
}

describe("feed discovery", () => {
  it("turns GitHub activity pages into their published Atom endpoints", () => {
    expect(githubFeedUrl("https://github.com/egornomic/feedfold/releases")).toBe(
      "https://github.com/egornomic/feedfold/releases.atom",
    );
    expect(githubFeedUrl("https://github.com/egornomic/feedfold/tags/")).toBe(
      "https://github.com/egornomic/feedfold/tags.atom",
    );
    expect(githubFeedUrl("https://github.com/egornomic/feedfold/commits/master/")).toBe(
      "https://github.com/egornomic/feedfold/commits/master.atom",
    );
    expect(
      githubFeedUrl(
        "https://github.com/egornomic/feedfold/commits/master/src/server/feed-discovery.ts",
      ),
    ).toBe(
      "https://github.com/egornomic/feedfold/commits/master/src/server/feed-discovery.ts.atom",
    );
    expect(githubFeedUrl("https://github.com/egornomic")).toBe("https://github.com/egornomic.atom");
    expect(githubFeedUrl("https://gist.github.com/egornomic#recent")).toBe(
      "https://gist.github.com/egornomic.atom",
    );
    expect(githubFeedUrl("https://github.com/egornomic/feedfold")).toBeNull();
    expect(githubFeedUrl("https://github.com/egornomic/feedfold/issues")).toBeNull();
  });

  it("gives X timelines a stable feed address", () => {
    expect(xFeedUrl("https://x.com/banteg")).toBe("https://x.com/banteg/rss");
    expect(xFeedUrl("https://x.com/banteg/rss#latest")).toBe("https://x.com/banteg/rss");
    expect(xFeedUrl("https://x.com/banteg/media?filter=videos")).toBe(
      "https://x.com/banteg/media/rss?filter=videos",
    );
    expect(xFeedUrl("https://x.com/banteg/status/123")).toBeNull();
    expect(xFeedUrl("https://x.com/rss")).toBe("https://x.com/rss/rss");
    expect(xFeedUrl("https://example.com/banteg")).toBeNull();
  });

  it("previews direct feeds and detects feeds from both linked pages and site roots", async () => {
    let baseUrl = "";
    const requestedPaths: string[] = [];
    const server = createServer((request, response) => {
      requestedPaths.push(request.url ?? "");
      if (request.url === "/rss.xml" || request.url === "/direct.xml") {
        response.writeHead(200, { "Content-Type": "application/rss+xml" });
        response.end(rss(baseUrl));
        return;
      }
      if (request.url === "/posts") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          '<!doctype html><title>Posts</title><a href="/output-feedback">Feedback</a><a href="/rss.xml">rss</a>',
        );
        return;
      }
      if (request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<!doctype html><title>Home</title><p>No feed link in this page.</p>");
        return;
      }
      response.writeHead(404).end();
    });
    baseUrl = await listen(server);

    const linkedResult = await discoverFeed(`${baseUrl}/posts`, 2_000, fetch);
    expect(linkedResult.kind).toBe("published");
    if (linkedResult.kind !== "published") throw new Error("Expected a published feed");
    const linked = linkedResult.preview;
    expect(linked).toMatchObject({
      feedUrl: `${baseUrl}/rss.xml`,
      title: "The Example Pond",
      siteUrl: `${baseUrl}/`,
      totalArticles: 4,
    });
    expect(linked.articles[0]).toMatchObject({
      title: "First entry",
      url: `${baseUrl}/first`,
      author: "Ada",
      publishedAt: "2026-07-15T12:00:00.000Z",
      summary: "A useful first summary.",
    });
    expect(linked.articles).toHaveLength(3);
    expect(requestedPaths).not.toContain("/output-feedback");

    const fromRoot = await discoverFeed(baseUrl, 2_000, fetch);
    expect(fromRoot.kind === "published" ? fromRoot.preview.feedUrl : null).toBe(
      `${baseUrl}/rss.xml`,
    );
    expect(requestedPaths).toContain("/feed");

    const direct = await discoverFeed(`${baseUrl}/direct.xml`, 2_000, fetch);
    expect(direct).toMatchObject({
      kind: "published",
      preview: { feedUrl: `${baseUrl}/direct.xml`, title: "The Example Pond" },
    });
  });

  it("offers a web feed when a reachable HTML page has no published feed", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>No feed here</title><p>Regular page content.</p>");
    });
    const baseUrl = await listen(server);

    await expect(discoverFeed(baseUrl, 2_000, fetch)).resolves.toEqual({
      kind: "web_page",
      pageUrl: `${baseUrl}/`,
      title: "No feed here",
    });
  });

  it("rejects private discovery targets before sending a request", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Private page</title>");
    });
    const baseUrl = await listen(server);

    await expect(discoverFeed(baseUrl, 2_000)).rejects.toMatchObject({ kind: "inaccessible" });
    expect(hits).toBe(0);
  });
});
