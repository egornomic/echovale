import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import {
  DEFAULT_ARTICLE_SUMMARY_PROMPT,
  DEFAULT_ARTICLE_TRANSLATION_PROMPT,
  DEFAULT_CUSTOM_PROMPTS,
} from "../../src/shared/ai-prompts.js";
import type { Article, BootstrapData, ImportResult, Rule } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];
const TEST_ACCOUNTS = [
  { username: "reader", password: "reader-password" },
  { username: "partner", password: "partner-password" },
];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

describe("live API, OPML, and filtering rules", () => {
  it("requires a session and keeps each account's data isolated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedfold-auth-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const database = new AppDatabase(join(directory, "feedfold.db"));
    const authService = new AuthService(database.auth, 20, { maxAccounts: 100 });
    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000);
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

    expect((await app.inject({ method: "GET", url: "/api/bootstrap" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: TEST_ACCOUNTS[0],
        })
      ).statusCode,
    ).toBe(401);

    const register = async (account: (typeof TEST_ACCOUNTS)[number]): Promise<string> => {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: account,
      });
      expect(response.statusCode).toBe(201);
      const setCookie = response.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
      if (!cookie) throw new Error("Registration did not return a session cookie");
      return cookie;
    };
    const registrationCookie = await register(TEST_ACCOUNTS[0]);
    expect(registrationCookie).toMatch(/^feedfold_session=/);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/session",
          headers: { cookie: registrationCookie },
        })
      ).json(),
    ).toEqual({
      user: {
        id: expect.stringMatching(/^[a-f0-9]{32}$/),
        username: "reader",
        hasPassword: true,
      },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "READER", password: "another-password" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({
      error: "The account could not be created. Choose another name or try again.",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "reader", password: "wrong-password" },
        })
      ).statusCode,
    ).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: TEST_ACCOUNTS[0],
    });
    expect(login.statusCode).toBe(200);
    const loginSetCookie = login.headers["set-cookie"];
    const readerCookie = (
      Array.isArray(loginSetCookie) ? loginSetCookie[0] : loginSetCookie
    )?.split(";", 1)[0];
    if (!readerCookie) throw new Error("Login did not return a session cookie");
    const partnerCookie = await register(TEST_ACCOUNTS[1]);

    const folderResponse = await app.inject({
      method: "POST",
      url: "/api/folders",
      headers: { cookie: readerCookie },
      payload: { name: "Reader folder", parentId: null },
    });
    expect(folderResponse.statusCode).toBe(200);
    const folder = folderResponse.json() as { id: number };

    const feedUrl = "https://shared.example.test/feed";
    const readerFeedResponse = await app.inject({
      method: "POST",
      url: "/api/feeds",
      headers: { cookie: readerCookie },
      payload: {
        sourceKind: "published",
        title: "Reader copy",
        feedUrl,
        folderId: folder.id,
        paused: true,
      },
    });
    const partnerFeedResponse = await app.inject({
      method: "POST",
      url: "/api/feeds",
      headers: { cookie: partnerCookie },
      payload: {
        sourceKind: "published",
        title: "Partner copy",
        feedUrl,
        folderId: null,
        paused: true,
      },
    });
    expect(readerFeedResponse.statusCode).toBe(200);
    expect(partnerFeedResponse.statusCode).toBe(200);
    const readerFeed = readerFeedResponse.json() as { id: number };
    const partnerFeed = partnerFeedResponse.json() as { id: number };

    database.feeds.completeRefresh(readerFeed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: "Reader copy",
        siteUrl: null,
        articles: [
          {
            externalId: "private-story",
            title: "Reader-only story",
            url: null,
            author: null,
            publishedAt: null,
            summary: "Private reading state",
            imageUrl: null,
            feedContentHtml: null,
          },
        ],
      },
    });
    const articleId = database.connection
      .prepare(
        `SELECT articles.id
         FROM feed_articles
         JOIN articles ON articles.id = feed_articles.article_id
         WHERE feed_articles.feed_id = ? AND articles.external_id = ?`,
      )
      .pluck()
      .get(readerFeed.id, "private-story") as number;

    const readerBootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie: readerCookie },
    });
    const partnerBootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { cookie: partnerCookie },
    });
    expect(readerBootstrap.json()).toMatchObject({
      counts: { all: 1 },
      feeds: [{ id: readerFeed.id, title: "Reader copy" }],
    });
    expect(partnerBootstrap.json()).toMatchObject({
      counts: { all: 1 },
      feeds: [{ id: partnerFeed.id, title: "Partner copy" }],
      folders: [],
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/articles/${articleId}`,
          headers: { cookie: partnerCookie },
        })
      ).statusCode,
    ).toBe(200);
    const translationWithoutAi = await app.inject({
      method: "POST",
      url: `/api/articles/${articleId}/translation`,
      headers: { cookie: readerCookie },
      payload: { sourceKind: "excerpt" },
    });
    expect(translationWithoutAi.statusCode).toBe(422);
    expect(translationWithoutAi.json()).toMatchObject({ code: "AI_NOT_CONFIGURED" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/articles/${articleId}/translation`,
          headers: { cookie: partnerCookie },
          payload: { sourceKind: "excerpt" },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/feeds/${partnerFeed.id}`,
          headers: { cookie: readerCookie },
          payload: { title: "Stolen" },
        })
      ).statusCode,
    ).toBe(404);
    const crossAccountRefresh = await app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { cookie: readerCookie },
      payload: { feedIds: [partnerFeed.id] },
    });
    expect(crossAccountRefresh.json()).toEqual({ requested: 0, refreshingFeedIds: [] });

    database.feeds.completeRefresh(readerFeed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: "Reader copy",
        siteUrl: null,
        articles: [
          {
            externalId: "stale-update",
            title: "Stale update",
            url: null,
            author: null,
            publishedAt: "2000-01-01T00:00:00.000Z",
            summary: "Old enough to clear",
            imageUrl: null,
            feedContentHtml: null,
          },
          {
            externalId: "fresh-update",
            title: "Fresh update",
            url: null,
            author: null,
            publishedAt: "2999-01-01T00:00:00.000Z",
            summary: "Too new to clear",
            imageUrl: null,
            feedContentHtml: null,
          },
        ],
      },
    });
    const markOlder = await app.inject({
      method: "POST",
      url: "/api/articles/mark-read",
      headers: { cookie: readerCookie },
      payload: { folderId: folder.id, olderThanDays: 1 },
    });
    expect(markOlder.statusCode).toBe(200);
    expect(markOlder.json()).toEqual({ updated: 1 });
    const readerUnread = await app.inject({
      method: "GET",
      url: "/api/articles?state=unread",
      headers: { cookie: readerCookie },
    });
    expect(
      (readerUnread.json() as { articles: Article[] }).articles.map((article) => article.title),
    ).toEqual(["Fresh update", "Reader-only story"]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/articles/mark-read",
          headers: { cookie: readerCookie },
          payload: { articleIds: [articleId] },
        })
      ).json(),
    ).toEqual({ updated: 1 });
    expect(database.articles.getArticle(1, articleId)).toMatchObject({ isRead: true });
    database.articles.updateArticleState(1, articleId, { isRead: false });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/articles/mark-read",
          headers: { cookie: readerCookie },
          payload: { folderId: folder.id, olderThanDays: 1 },
        })
      ).json(),
    ).toEqual({ updated: 0 });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/articles/mark-read",
          headers: { cookie: partnerCookie },
          payload: { folderId: folder.id, olderThanDays: 1 },
        })
      ).json(),
    ).toEqual({ updated: 0 });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/articles/mark-read",
          headers: { cookie: readerCookie },
          payload: { olderThanDays: 4 },
        })
      ).statusCode,
    ).toBe(400);

    const savedSettings = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { cookie: readerCookie },
      payload: {
        pollIntervalMinutes: 30,
        markReadOnScroll: false,
        showYouTubeDescriptions: true,
        duplicateArticleWindowDays: 30,
        translationLanguage: "Polish",
        summaryPrompt: "Summarize with one concise paragraph.",
        translationPrompt: "Translate every marked fragment and return the required JSON object.",
        customPrompts: [
          {
            id: "5caa245e-f441-4d33-95cc-287f50f07b91",
            name: "Find decisions",
            prompt: "List the decisions and who made each one.",
          },
        ],
      },
    });
    expect(savedSettings.json()).toMatchObject({
      pollIntervalMinutes: 30,
      markReadOnScroll: false,
      showYouTubeDescriptions: true,
      duplicateArticleWindowDays: 30,
      translationLanguage: "Polish",
      summaryPrompt: "Summarize with one concise paragraph.",
      translationPrompt: "Translate every marked fragment and return the required JSON object.",
      customPrompts: [
        {
          id: "5caa245e-f441-4d33-95cc-287f50f07b91",
          name: "Find decisions",
          prompt: "List the decisions and who made each one.",
        },
      ],
    });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: { cookie: readerCookie },
          payload: { translationLanguage: "   " },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: { cookie: readerCookie },
          payload: { pollIntervalMinutes: 15 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: { cookie: readerCookie },
          payload: { duplicateArticleWindowDays: 14 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/settings",
          headers: { cookie: readerCookie },
          payload: { summaryPrompt: "   " },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/settings",
          headers: { cookie: partnerCookie },
        })
      ).json(),
    ).toMatchObject({
      markReadOnScroll: true,
      showYouTubeDescriptions: false,
      duplicateArticleWindowDays: 7,
      translationLanguage: "English",
      summaryPrompt: DEFAULT_ARTICLE_SUMMARY_PROMPT,
      translationPrompt: DEFAULT_ARTICLE_TRANSLATION_PROMPT,
      customPrompts: DEFAULT_CUSTOM_PROMPTS,
    });

    const rejectedLegacyRule = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { cookie: readerCookie },
      payload: {
        name: "Legacy keep rule",
        feedId: readerFeed.id,
        folderId: null,
        field: "title",
        pattern: "reader",
        action: "keep",
        enabled: false,
      },
    });
    expect(rejectedLegacyRule.statusCode).toBe(400);

    const keepRuleResponse = await app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { cookie: readerCookie },
      payload: {
        name: "Keep reader stories",
        feedId: readerFeed.id,
        folderId: null,
        conditions: [
          { field: "title", pattern: "reader" },
          { field: "summary", pattern: "private" },
        ],
        conditionOperator: "or",
        action: "keep",
        enabled: false,
      },
    });
    expect(keepRuleResponse.statusCode).toBe(200);
    expect(keepRuleResponse.json()).toMatchObject({
      name: "Keep reader stories",
      conditions: [
        { field: "title", pattern: "reader" },
        { field: "summary", pattern: "private" },
      ],
      conditionOperator: "or",
      action: "keep",
      enabled: false,
      matchedCount: 1,
    });

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/feeds/${partnerFeed.id}`,
          headers: { cookie: readerCookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/feeds/${readerFeed.id}`,
          headers: { cookie: readerCookie },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/articles/${articleId}`,
          headers: { cookie: readerCookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/bootstrap",
          headers: { cookie: readerCookie },
        })
      ).json(),
    ).toMatchObject({ counts: { all: 0 }, feeds: [] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/bootstrap",
          headers: { cookie: partnerCookie },
        })
      ).json(),
    ).toMatchObject({ feeds: [{ id: partnerFeed.id, title: "Partner copy" }] });

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers: { cookie: readerCookie },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/bootstrap",
          headers: { cookie: readerCookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("imports nested folders, refreshes subscriptions, applies parent-folder rules, and exports OPML", async () => {
    let feedBase = "";
    const feedServer = createServer((request, response) => {
      if (request.url === "/feed") {
        response.writeHead(200, { "Content-Type": "application/rss+xml" });
        response.end(`<?xml version="1.0"?><rss version="2.0"><channel>
          <title>Remote feed title</title><link>${feedBase}</link><description>Example</description>
          <item><guid>noise</guid><title>Noisy weekly roundup</title><link>${feedBase}/missing-noise</link>
            <description><![CDATA[<p>Feed fallback for noise.</p>]]></description></item>
          <item><guid>keep</guid><title>Keep this story</title><link>${feedBase}/missing-keep</link>
            <description><![CDATA[<p>Feed fallback worth reading.</p><img src="/keep.jpg" alt="Keep">]]></description></item>
        </channel></rss>`);
        return;
      }
      response.writeHead(503).end("article unavailable");
    });
    feedBase = await listen(feedServer);

    const directory = await mkdtemp(join(tmpdir(), "feedfold-api-test-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const database = new AppDatabase(join(directory, "feedfold.db"));
    const authService = new AuthService(database.auth);
    expect(
      await authService.register(TEST_ACCOUNTS[0].username, TEST_ACCOUNTS[0].password),
    ).not.toBeNull();
    const extraction = new ExtractionQueue(database.extractions, 2, 2_000, fetch);
    const refresh = new FeedRefreshService(database.feeds, 2, 2_000, undefined, fetch);
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const apiBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    cleanups.push(async () => {
      await app.close();
      await Promise.all([refresh.stop(), extraction.stop()]);
      database.close();
    });

    expect(await json(`${apiBase}/health`)).toEqual({ status: "ok" });
    expect((await fetch(`${apiBase}/api/bootstrap`)).status).toBe(401);
    const rejectedLogin = await fetch(`${apiBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reader", password: "wrong-password" }),
    });
    expect(rejectedLogin.status).toBe(401);
    const login = await fetch(`${apiBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TEST_ACCOUNTS[0]),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Login did not return a session cookie");
    const asReader = <T>(path: string, init?: RequestInit): Promise<T> => {
      const headers = new Headers(init?.headers);
      headers.set("Cookie", cookie);
      return json<T>(`${apiBase}${path}`, { ...init, headers });
    };
    const opml = `<?xml version="1.0"?><opml version="2.0"><body>
      <outline text="Parent"><outline text="Child">
        <outline type="rss" text="My saved label" title="My saved label" xmlUrl="${feedBase}/feed" htmlUrl="${feedBase}"/>
      </outline></outline><outline text="Someday"/>
    </body></opml>`;
    const imported = await asReader<ImportResult>("/api/opml/import", {
      method: "POST",
      body: JSON.stringify({ opml }),
    });
    expect(imported).toEqual({ imported: 1, duplicates: 0, failed: [] });
    await refresh.waitForIdle();
    await extraction.waitForIdle();

    const duplicate = await asReader<ImportResult>("/api/opml/import", {
      method: "POST",
      body: JSON.stringify({ opml }),
    });
    expect(duplicate).toEqual({ imported: 0, duplicates: 1, failed: [] });

    const bootstrap = await asReader<BootstrapData>("/api/bootstrap");
    expect(bootstrap.folders.map((folder) => folder.name)).toEqual(["Child", "Parent", "Someday"]);
    expect(bootstrap.settings.markReadOnScroll).toBe(true);
    expect(
      await asReader("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ markReadOnScroll: false }),
      }),
    ).toMatchObject({ markReadOnScroll: false });
    expect(await asReader("/api/settings")).toMatchObject({ markReadOnScroll: false });
    const parent = bootstrap.folders.find((folder) => folder.name === "Parent");
    const child = bootstrap.folders.find((folder) => folder.name === "Child");
    expect(child?.parentId).toBe(parent?.id);
    expect(bootstrap.folders.some((folder) => folder.name === "Someday")).toBe(true);
    expect(bootstrap.feeds[0]).toMatchObject({ title: "My saved label", folderId: child?.id });
    expect(bootstrap.counts).toMatchObject({ unread: 2, all: 2 });

    const rule = await asReader<Rule>("/api/rules", {
      method: "POST",
      body: JSON.stringify({
        name: "Remove roundups",
        feedId: null,
        folderId: parent?.id,
        conditions: [{ field: "title", pattern: "weekly roundup" }],
        conditionOperator: "and",
        action: "hide",
        enabled: true,
      }),
    });
    expect(rule.matchedCount).toBe(1);
    database.rules.recomputeRulesForArticle(
      database.connection
        .prepare("SELECT id FROM articles WHERE external_id = 'noise'")
        .pluck()
        .get() as number,
    );
    database.rules.recomputeRulesForArticle(
      database.connection
        .prepare("SELECT id FROM articles WHERE external_id = 'noise'")
        .pluck()
        .get() as number,
    );
    const rules = await asReader<{ rules: Rule[] }>("/api/rules");
    expect(rules.rules[0].matchedCount).toBe(1);

    const disabledRule = await asReader<Rule>(`/api/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabledRule).toMatchObject({ enabled: false, matchedCount: 1 });
    const visibleWhileDisabled = await asReader<{ articles: Article[] }>("/api/articles?state=all");
    expect(new Set(visibleWhileDisabled.articles.map((article) => article.title))).toEqual(
      new Set(["Noisy weekly roundup", "Keep this story"]),
    );

    const enabledRule = await asReader<Rule>(`/api/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabledRule).toMatchObject({ enabled: true, matchedCount: 1 });
    expect(
      (await asReader<{ articles: Article[] }>("/api/articles?state=all")).articles.map(
        (article) => article.title,
      ),
    ).toEqual(["Keep this story"]);

    await asReader(`/api/folders/${child?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ parentId: null }),
    });
    const movedOut = await asReader<{ articles: Article[] }>("/api/articles?state=all");
    expect(new Set(movedOut.articles.map((article) => article.title))).toEqual(
      new Set(["Noisy weekly roundup", "Keep this story"]),
    );
    expect((await asReader<{ rules: Rule[] }>("/api/rules")).rules[0].matchedCount).toBe(0);
    await asReader(`/api/folders/${child?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ parentId: parent?.id }),
    });

    const listed = await asReader<{ articles: Article[] }>("/api/articles?state=all");
    expect(listed.articles.map((article) => article.title)).toEqual(["Keep this story"]);
    const keep = listed.articles[0];
    expect(keep).toMatchObject({ contentHtml: null, imageUrl: `${feedBase}/keep.jpg` });
    const expanded = await asReader<{ articles: Article[] }>(
      "/api/articles?state=all&includeContent=true",
    );
    expect(expanded.articles[0].feedContentHtml).toContain("Feed fallback worth reading");
    expect(expanded.articles[0].contentHtml).toBeNull();
    const updated = await asReader<Article>(`/api/articles/${keep.id}/state`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true, isStarred: true }),
    });
    expect(updated).toMatchObject({ isRead: true, isStarred: true });
    expect(await asReader<Article>(`/api/articles/${keep.id}`)).toMatchObject({
      id: keep.id,
      isRead: true,
      isStarred: true,
      imageUrl: `${feedBase}/keep.jpg`,
    });
    expect((await asReader<Article>(`/api/articles/${keep.id}`)).feedContentHtml).toContain(
      "Feed fallback worth reading",
    );

    const retry = await asReader<Article>(`/api/articles/${keep.id}/extract`, {
      method: "POST",
    });
    expect(["pending", "processing"]).toContain(retry.extractionStatus);
    await extraction.waitForIdle();
    expect(await asReader<Article>(`/api/articles/${keep.id}`)).toMatchObject({
      extractionStatus: "failed",
      contentHtml: null,
      feedContentHtml: expect.stringContaining("Feed fallback worth reading"),
      extractionError: "The source page returned HTTP 503.",
    });

    const exported = await fetch(`${apiBase}/api/opml/export`, { headers: { Cookie: cookie } });
    expect(exported.headers.get("content-disposition")).toContain("feedfold-subscriptions.opml");
    const exportedText = await exported.text();
    expect(exportedText).toContain('text="Parent"');
    expect(exportedText).toContain('text="Child"');
    expect(exportedText).toContain('text="Someday"');
    expect(exportedText).toContain(`xmlUrl="${feedBase}/feed"`);
    expect(exportedText).not.toContain("Keep this story");
  });
});
