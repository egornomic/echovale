import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { InjectOptions } from "fastify";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import { WebFeedService } from "../../src/server/web-feed.js";
import type {
  Article,
  ArticlePage,
  Feed,
  RefreshResult,
  WebFeedAnalysis,
} from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type FixtureMode = "initial" | "updated" | "http_error" | "changed";

async function listen(server: Server): Promise<string> {
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

function updateCard(
  slug: string,
  title: string,
  author: string,
  summary: string,
  date: string,
): string {
  return `<article class="update-card">
    <h2><a href="/updates/${slug}">${title}</a></h2>
    <time datetime="${date}">${date}</time>
    <span class="byline">${author}</span>
    <p class="summary">${summary}</p>
    <img src="/images/${slug}.jpg" alt="">
  </article>`;
}

function fixtureItems(mode: Exclude<FixtureMode, "http_error">): string {
  if (mode === "changed") {
    return `<section aria-label="Replacement updates">
      <article class="replacement-card">
        <h2><a href="/updates/epsilon">Epsilon release</a></h2>
        <p>Replacement layout one.</p>
      </article>
      <article class="replacement-card">
        <h2><a href="/updates/zeta">Zeta release</a></h2>
        <p>Replacement layout two.</p>
      </article>
      <article class="replacement-card">
        <h2><a href="/updates/eta">Eta release</a></h2>
        <p>Replacement layout three.</p>
      </article>
    </section>`;
  }
  if (mode === "updated") {
    return `<section aria-label="Latest updates">
      ${updateCard("gamma", "Gamma release", "Lin", "Gamma remains available.", "2026-07-22T12:00:00Z")}
      ${updateCard("alpha", "Alpha release revised", "Ada", "Alpha metadata was updated.", "2026-07-20T10:00:00Z")}
      ${updateCard("delta", "Delta release", "Margaret", "Delta is newly available.", "2026-07-23T13:00:00Z")}
      <article class="update-card duplicate">
        <h2><a href="/updates/alpha#details">Alpha release details</a></h2>
        <p class="summary">The same release is linked twice.</p>
      </article>
    </section>`;
  }
  return `<section aria-label="Latest updates">
    ${updateCard("alpha", "Alpha release", "Ada", "Alpha is available.", "2026-07-20T10:00:00Z")}
    ${updateCard("beta", "Beta release", "Grace", "Beta is available.", "2026-07-21T11:00:00Z")}
    ${updateCard("gamma", "Gamma release", "Lin", "Gamma is available.", "2026-07-22T12:00:00Z")}
  </section>`;
}

function fixturePage(mode: Exclude<FixtureMode, "http_error">): string {
  return `<!doctype html>
    <html>
      <head><title>JavaScript updates</title></head>
      <body>
        <main><h1>Updates</h1><div id="app"></div></main>
        <script>
          setTimeout(() => {
            document.querySelector("#app").innerHTML = ${JSON.stringify(fixtureItems(mode))};
          }, 80);
        </script>
      </body>
    </html>`;
}

function cookieFrom(response: { headers: { "set-cookie"?: string | string[] | number } }): string {
  const header = response.headers["set-cookie"];
  const setCookie = typeof header === "number" ? undefined : header;
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  if (!cookie) throw new Error("Registration did not return a session cookie");
  return cookie;
}

describe("authenticated web-feed API", () => {
  it("creates, refreshes, diagnoses, and repairs a JavaScript-rendered web feed", async () => {
    let mode: FixtureMode = "initial";
    const fixtureServer = createServer((request, response) => {
      if (mode === "changed" && request.url === "/") {
        response.writeHead(302, { Location: "/changelog" }).end();
        return;
      }
      if (mode === "http_error") {
        response.writeHead(503, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end("<!doctype html><title>Temporarily unavailable</title>");
        return;
      }
      if (request.url?.startsWith("/images/")) {
        response.writeHead(204, { "Cache-Control": "no-store" }).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(fixturePage(mode));
    });
    const pageUrl = await listen(fixtureServer);

    const database = new AppDatabase(":memory:");
    cleanups.push(() => database.close());
    const authService = new AuthService(database.auth, 20, { maxAccounts: 100 });
    const extractionQueue = new ExtractionQueue(database.extractions, 1, 4_000);
    cleanups.push(() => extractionQueue.stop());
    const webFeedService = new WebFeedService({
      allowPrivateNetworks: true,
      timeoutMs: 4_000,
      settleQuietMs: 150,
      settleTimeoutMs: 3_000,
    });
    cleanups.push(() => webFeedService.close());
    const refreshService = new FeedRefreshService(database.feeds, 1, 4_000, webFeedService);
    cleanups.push(() => refreshService.stop());
    const app = await createApp({
      database,
      authService,
      extractionQueue,
      refreshService,
      webFeedService,
    });
    cleanups.push(() => app.close());

    const register = async (username: string): Promise<string> => {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { username, password: `${username}-password` },
      });
      expect(response.statusCode).toBe(201);
      return cookieFrom(response);
    };
    const readerCookie = await register("reader");
    const otherCookie = await register("other-reader");
    const directDeliveryCounts: number[] = [];
    cleanups.push(
      refreshService.subscribe(1, () => {
        directDeliveryCounts.push(database.bootstrap.getBootstrap(1).counts.unread);
      }),
    );
    const request = (cookie: string, options: InjectOptions) =>
      app.inject({ ...options, headers: { ...options.headers, cookie } });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/web-feeds/analyze",
          payload: { url: pageUrl },
        })
      ).statusCode,
    ).toBe(401);

    const analysisResponse = await request(readerCookie, {
      method: "POST",
      url: "/api/web-feeds/analyze",
      payload: { url: pageUrl },
    });
    expect(analysisResponse.statusCode, analysisResponse.body).toBe(200);
    const analysis = analysisResponse.json<WebFeedAnalysis>();
    expect(analysis).toMatchObject({
      pageUrl: `${pageUrl}/`,
      title: "JavaScript updates",
      savedSelectionMatched: false,
    });
    const candidate = analysis.candidates.find(({ label }) => label === "Latest updates");
    if (!candidate) throw new Error("Expected the JavaScript-rendered update suggestion");
    expect(candidate.articles.map(({ title }) => title)).toEqual([
      "Alpha release",
      "Beta release",
      "Gamma release",
    ]);

    const ownerSnapshot = await request(readerCookie, {
      method: "GET",
      url: `/api/web-feed-snapshots/${analysis.snapshotId}`,
    });
    expect(ownerSnapshot.statusCode).toBe(200);
    expect(ownerSnapshot.headers["content-type"]).toContain("text/html");
    expect(ownerSnapshot.body).toContain("Alpha release");

    const applicationUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch();
    cleanups.push(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: "feedfold_session",
        value: readerCookie.slice("feedfold_session=".length),
        url: applicationUrl,
      },
    ]);
    const page = await context.newPage();
    await page.goto(`${applicationUrl}/health`);
    await page.evaluate(({ snapshotId, messageToken }) => {
      window.addEventListener("message", ({ data }) => {
        if (data?.type === "feedfold:web-feed-select" && data.messageToken === messageToken) {
          document.body.dataset.selectedGroup = data.candidateId;
        }
      });
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = `/api/web-feed-snapshots/${snapshotId}`;
      document.body.append(frame);
    }, analysis);
    await page
      .frameLocator("iframe")
      .locator(`[data-feedfold-candidates~="${candidate.id}"]`)
      .first()
      .click();
    await page.waitForFunction(() => Boolean(document.body.dataset.selectedGroup));
    expect(analysis.candidates.map(({ id }) => id)).toContain(
      await page.evaluate(() => document.body.dataset.selectedGroup),
    );
    await browser.close();

    const otherSnapshot = await request(otherCookie, {
      method: "GET",
      url: `/api/web-feed-snapshots/${analysis.snapshotId}`,
    });
    expect(otherSnapshot.statusCode).toBe(404);
    expect(otherSnapshot.json()).toMatchObject({ code: "inaccessible" });

    const createResponse = await request(readerCookie, {
      method: "POST",
      url: "/api/feeds",
      payload: {
        sourceKind: "web",
        title: "Tracked updates",
        feedUrl: analysis.pageUrl,
        folderId: null,
        webConfig: candidate.config,
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json<Feed>();
    expect(created).toMatchObject({
      title: "Tracked updates",
      sourceKind: "web",
      healthStatus: "healthy",
      lastErrorKind: null,
      lastMatchCount: 3,
      totalCount: 3,
    });
    expect(directDeliveryCounts).toEqual([3]);

    const listArticles = async (): Promise<Article[]> => {
      const response = await request(readerCookie, {
        method: "GET",
        url: `/api/articles?state=all&feedId=${created.id}&limit=100`,
      });
      expect(response.statusCode).toBe(200);
      return response.json<ArticlePage>().articles;
    };
    const initialArticles = await listArticles();
    expect(initialArticles.map(({ title }) => title).sort()).toEqual([
      "Alpha release",
      "Beta release",
      "Gamma release",
    ]);
    const initialAlpha = initialArticles.find(({ url }) => url === `${pageUrl}/updates/alpha`);
    if (!initialAlpha) throw new Error("Expected the initial Alpha article");
    const stateResponse = await request(readerCookie, {
      method: "PATCH",
      url: `/api/articles/${initialAlpha.id}/state`,
      payload: { isRead: true, isStarred: true },
    });
    expect(stateResponse.statusCode).toBe(200);

    const refresh = async (): Promise<void> => {
      const response = await request(readerCookie, {
        method: "POST",
        url: `/api/feeds/${created.id}/refresh`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<RefreshResult>()).toMatchObject({ requested: 1 });
      await refreshService.waitForIdle();
    };

    mode = "updated";
    await refresh();
    const refreshedArticles = await listArticles();
    expect(refreshedArticles).toHaveLength(4);
    expect(refreshedArticles.map(({ url }) => url).sort()).toEqual([
      `${pageUrl}/updates/alpha`,
      `${pageUrl}/updates/beta`,
      `${pageUrl}/updates/delta`,
      `${pageUrl}/updates/gamma`,
    ]);
    expect(refreshedArticles.find(({ url }) => url === `${pageUrl}/updates/alpha`)).toMatchObject({
      id: initialAlpha.id,
      title: "Alpha release revised",
      summary: "Alpha metadata was updated.",
      isRead: true,
      isStarred: true,
    });
    expect(refreshedArticles.some(({ url }) => url === `${pageUrl}/updates/beta`)).toBe(true);
    expect(database.feeds.getFeed(1, created.id)).toMatchObject({
      healthStatus: "healthy",
      lastMatchCount: 3,
      totalCount: 4,
    });

    mode = "http_error";
    await refresh();
    expect(database.feeds.getFeed(1, created.id)).toMatchObject({
      healthStatus: "failing",
      lastErrorKind: "http",
      lastHttpStatus: 503,
      lastMatchCount: 3,
      totalCount: 4,
    });
    expect(database.feeds.getFeed(1, created.id)?.lastErrorKind).not.toBe("selection_broken");

    mode = "changed";
    await refresh();
    expect(database.feeds.getFeed(1, created.id)).toMatchObject({
      healthStatus: "needs_attention",
      lastErrorKind: "selection_broken",
      lastHttpStatus: 200,
      lastMatchCount: 0,
      totalCount: 4,
    });

    const repairAnalysisResponse = await request(readerCookie, {
      method: "POST",
      url: `/api/feeds/${created.id}/web-feed/analyze`,
    });
    expect(repairAnalysisResponse.statusCode).toBe(200);
    const repairAnalysis = repairAnalysisResponse.json<WebFeedAnalysis>();
    expect(repairAnalysis.savedSelectionMatched).toBe(false);
    const replacement = repairAnalysis.candidates.find(
      ({ label }) => label === "Replacement updates",
    );
    if (!replacement) throw new Error("Expected the replacement-layout suggestion");
    expect(replacement.config.pageUrl).toBe(`${pageUrl}/changelog`);

    const notificationsBeforeRepair = directDeliveryCounts.length;
    const repairResponse = await request(readerCookie, {
      method: "PATCH",
      url: `/api/feeds/${created.id}/web-feed`,
      payload: { config: replacement.config },
    });
    expect(repairResponse.statusCode).toBe(200);
    expect(repairResponse.json<Feed>()).toMatchObject({
      feedUrl: `${pageUrl}/changelog`,
      healthStatus: "healthy",
      lastErrorKind: null,
      lastError: null,
      lastMatchCount: 3,
      totalCount: 7,
    });
    expect(directDeliveryCounts).toHaveLength(notificationsBeforeRepair + 1);
    const repairedArticles = await listArticles();
    expect(repairedArticles).toHaveLength(7);
    expect(repairedArticles.find(({ url }) => url === `${pageUrl}/updates/alpha`)).toMatchObject({
      id: initialAlpha.id,
      isRead: true,
      isStarred: true,
    });
  }, 30_000);
});
