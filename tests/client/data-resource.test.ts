import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { api, type FeedInput, type FeedUpdateInput } from "../../src/client/api.js";
import { ReaderDataResource } from "../../src/client/data-resource.js";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import type { ArticlePage, BootstrapData, Feed, Rule } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const FEED_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Resource test feed</title>
    <link>https://example.test/</link>
    <description>Resource integration test</description>
    <item>
      <guid>resource-story</guid>
      <title>Resource story</title>
      <link>https://example.test/resource-story</link>
      <pubDate>Tue, 28 Jul 2026 12:00:00 GMT</pubDate>
      <description>Loaded after the refresh gate opens.</description>
    </item>
  </channel>
</rss>`;

describe("reader data resource", () => {
  it("reloads feed-dependent data after moving a feed to a folder", async () => {
    const database = new AppDatabase(":memory:");
    cleanups.push(() => database.close());
    const sourceFolder = database.folders.createFolder(1, { name: "Source" });
    const destinationFolder = database.folders.createFolder(1, { name: "Destination" });
    const feed = database.feeds.createFeed(1, {
      title: "Moving feed",
      feedUrl: "https://example.test/moving.xml",
      folderId: sourceFolder.id,
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: feed.title,
        siteUrl: null,
        articles: [
          {
            externalId: "moving-story",
            title: "Moving story",
            url: null,
            author: null,
            publishedAt: null,
            summary: "",
            imageUrl: null,
            feedContentHtml: null,
          },
        ],
      },
    });
    const rule = database.rules.createRule(1, {
      name: "Hide moved stories",
      folderId: destinationFolder.id,
      conditions: [{ field: "title", pattern: "moving" }],
      conditionOperator: "and",
      action: "hide",
    });
    expect(rule.matchedCount).toBe(0);

    const client = {
      ...api,
      bootstrap: async () => ({
        ...database.bootstrap.getBootstrap(1),
        aiSettings: {
          credentialStorageAvailable: false,
          providers: [],
          features: { articleSummary: null },
        },
      }),
      updateFeed: async (id: number, input: FeedUpdateInput) => {
        const updated = database.feeds.updateFeed(1, id, input);
        if (!updated) throw new Error("Feed was not found");
        return updated;
      },
    };
    const resource = new ReaderDataResource(client);
    cleanups.push(() => resource.pause());
    let latestBootstrap: BootstrapData | null = null;
    let latestArticles: ArticlePage | null = null;
    let latestRules: Rule[] | null = null;
    resource.connect({
      getBootstrap: () => latestBootstrap,
      applyBootstrap: (bootstrap) => {
        latestBootstrap = bootstrap;
      },
      setBootstrapError: (message) => {
        if (message) throw new Error(message);
      },
      reloadArticles: async () => {
        latestArticles = database.articles.listArticlePage(1, { state: "all" });
      },
      reloadRules: async () => {
        latestRules = database.rules.listRules(1);
      },
    });
    const currentBootstrap = () => {
      if (!latestBootstrap) throw new Error("Bootstrap data was not reloaded");
      return latestBootstrap;
    };
    const currentArticles = () => {
      if (!latestArticles) throw new Error("Articles were not reloaded");
      return latestArticles;
    };
    const currentRules = () => {
      if (!latestRules) throw new Error("Rules were not reloaded");
      return latestRules;
    };

    await resource.updateFeed(feed.id, { folderId: destinationFolder.id });

    expect(currentBootstrap().feeds.find((candidate) => candidate.id === feed.id)?.folderId).toBe(
      destinationFolder.id,
    );
    expect(currentArticles().articles).toEqual([]);
    expect(currentRules()).toEqual([expect.objectContaining({ id: rule.id, matchedCount: 1 })]);
  });

  it("cancels an obsolete article request when a newer query starts", async () => {
    const firstRequestStarted = deferred();
    const firstRequestAborted = deferred();
    const server = createServer((request, response) => {
      if (request.url === "/first") {
        firstRequestStarted.resolve();
        request.once("aborted", firstRequestAborted.resolve);
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("new query");
    });
    const baseUrl = await listen(server);
    const resource = new ReaderDataResource(api, 5);
    cleanups.push(() => resource.pause());
    const appliedResponses: string[] = [];
    let requestNumber = 0;
    resource.connect({
      getBootstrap: () => null,
      applyBootstrap: () => {},
      setBootstrapError: () => {},
      reloadArticles: async (signal) => {
        requestNumber += 1;
        const path = requestNumber === 1 ? "first" : "second";
        const response = await fetch(`${baseUrl}/${path}`, { signal });
        appliedResponses.push(await response.text());
      },
      reloadRules: async () => {},
    });

    const obsoleteRequest = resource.loadArticles();
    await firstRequestStarted.promise;
    const currentRequest = resource.loadArticles();
    await Promise.all([obsoleteRequest, currentRequest, firstRequestAborted.promise]);

    expect(appliedResponses).toEqual(["new query"]);
  });

  it("reloads unread counts with the article list after background delivery", async () => {
    const database = new AppDatabase(":memory:");
    cleanups.push(() => database.close());
    const feed = database.feeds.createFeed(1, {
      title: "Background feed",
      feedUrl: "https://example.test/background.xml",
      folderId: null,
    });
    const client = {
      ...api,
      bootstrap: async () => ({
        ...database.bootstrap.getBootstrap(1),
        aiSettings: {
          credentialStorageAvailable: false,
          providers: [],
          features: { articleSummary: null },
        },
      }),
    };
    const resource = new ReaderDataResource(client);
    cleanups.push(() => resource.pause());
    let latestBootstrap: BootstrapData | null = null;
    let latestArticles: ArticlePage | null = null;
    let deliverDuringReload = false;
    resource.connect({
      getBootstrap: () => latestBootstrap,
      applyBootstrap: (bootstrap) => {
        latestBootstrap = bootstrap;
      },
      setBootstrapError: (message) => {
        if (message) throw new Error(message);
      },
      reloadArticles: async () => {
        if (deliverDuringReload) {
          deliverDuringReload = false;
          database.feeds.completeRefresh(feed.id, {
            httpStatus: 200,
            etag: null,
            lastModified: null,
            parsed: {
              title: feed.title,
              siteUrl: null,
              articles: [
                {
                  externalId: "background-story",
                  title: "Delivered while reading",
                  url: null,
                  author: null,
                  publishedAt: null,
                  summary: "",
                  imageUrl: null,
                  feedContentHtml: null,
                },
              ],
            },
          });
        }
        latestArticles = database.articles.listArticlePage(1, { state: "unread" });
      },
      reloadRules: async () => {},
    });
    const currentBootstrap = () => {
      if (!latestBootstrap) throw new Error("Bootstrap data was not reloaded");
      return latestBootstrap;
    };
    const currentArticles = () => {
      if (!latestArticles) throw new Error("Articles were not reloaded");
      return latestArticles;
    };

    await resource.loadBootstrap();
    expect(currentBootstrap().counts.unread).toBe(0);

    deliverDuringReload = true;
    await resource.reloadReader();

    expect(currentArticles().articles.map((article) => article.title)).toEqual([
      "Delivered while reading",
    ]);
    expect(currentBootstrap().counts.unread).toBe(1);
    expect(currentBootstrap().feeds[0]?.unreadCount).toBe(1);
  });

  it("updates every unread count when a delivery invalidation arrives", async () => {
    const database = new AppDatabase(":memory:");
    cleanups.push(() => database.close());
    const folder = database.folders.createFolder(1, { name: "Live deliveries" });
    const feed = database.feeds.createFeed(1, {
      title: "Live feed",
      feedUrl: "https://example.test/live.xml",
      folderId: folder.id,
    });
    let bootstrapCalls = 0;
    const client = {
      ...api,
      bootstrap: async () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 2) throw new Error("transient bootstrap failure");
        return {
          ...database.bootstrap.getBootstrap(1),
          aiSettings: {
            credentialStorageAvailable: false,
            providers: [],
            features: { articleSummary: null },
          },
        };
      },
    };
    let invalidate = () => {};
    let unsubscribed = false;
    const resource = new ReaderDataResource(
      client,
      5,
      (listener) => {
        invalidate = listener;
        return () => {
          unsubscribed = true;
        };
      },
      5,
    );
    cleanups.push(() => resource.pause());
    let latestBootstrap: BootstrapData | null = null;
    let latestArticles: ArticlePage | null = null;
    let bootstrapError: string | null = null;
    const liveCountApplied = deferred();
    const liveArticlesApplied = deferred();
    resource.connect({
      getBootstrap: () => latestBootstrap,
      applyBootstrap: (bootstrap) => {
        latestBootstrap = bootstrap;
        if (bootstrap.counts.unread === 1) liveCountApplied.resolve();
      },
      setBootstrapError: (message) => {
        bootstrapError = message;
      },
      reloadArticles: async () => {
        const page = database.articles.listArticlePage(1, { state: "unread" });
        latestArticles = page;
        if (page.articles.some((article) => article.title === "Delivered without a click")) {
          liveArticlesApplied.resolve();
        }
      },
      reloadRules: async () => {},
    });
    const currentBootstrap = () => {
      if (!latestBootstrap) throw new Error("Bootstrap data was not reloaded");
      return latestBootstrap;
    };
    const currentArticles = () => {
      if (!latestArticles) throw new Error("Articles were not reloaded");
      return latestArticles;
    };

    resource.resume();
    await resource.loadBootstrap();
    expect(currentBootstrap().counts.unread).toBe(0);

    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: feed.title,
        siteUrl: null,
        articles: [
          {
            externalId: "live-story",
            title: "Delivered without a click",
            url: null,
            author: null,
            publishedAt: null,
            summary: "",
            imageUrl: null,
            feedContentHtml: null,
          },
        ],
      },
    });
    expect(database.bootstrap.getBootstrap(1).counts.unread).toBe(1);
    expect(currentBootstrap().counts.unread).toBe(0);

    invalidate();
    await Promise.all([liveCountApplied.promise, liveArticlesApplied.promise]);

    expect(currentBootstrap().counts.unread).toBe(1);
    expect(currentBootstrap().feeds[0]?.unreadCount).toBe(1);
    expect(currentBootstrap().folders[0]?.unreadCount).toBe(1);
    expect(bootstrapCalls).toBe(3);
    expect(bootstrapError).toBeNull();
    expect(currentArticles().articles.map((article) => article.title)).toEqual([
      "Delivered without a click",
    ]);

    resource.pause();
    expect(unsubscribed).toBe(true);
  });

  it("keeps an optimistic read and its counters while a background snapshot overlaps the save", async () => {
    const database = new AppDatabase(":memory:");
    cleanups.push(() => database.close());
    const feed = database.feeds.createFeed(1, {
      title: "Concurrent feed",
      feedUrl: "https://example.test/concurrent.xml",
      folderId: null,
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: feed.title,
        siteUrl: null,
        articles: [
          {
            externalId: "existing-story",
            title: "Existing unread story",
            url: null,
            author: null,
            publishedAt: null,
            summary: "",
            imageUrl: null,
            feedContentHtml: null,
          },
        ],
      },
    });
    const existingArticle = database.articles.listArticlePage(1, { state: "unread" }).articles[0];
    if (!existingArticle) throw new Error("The existing article was not stored");

    const staleSnapshotStarted = deferred();
    const releaseStaleSnapshot = deferred();
    let holdNextSnapshot = false;
    const client = {
      ...api,
      bootstrap: async () => {
        const snapshot = {
          ...database.bootstrap.getBootstrap(1),
          aiSettings: {
            credentialStorageAvailable: false,
            providers: [],
            features: { articleSummary: null },
          },
        };
        if (holdNextSnapshot) {
          holdNextSnapshot = false;
          staleSnapshotStarted.resolve();
          await releaseStaleSnapshot.promise;
        }
        return snapshot;
      },
    };
    let invalidate = () => {};
    const resource = new ReaderDataResource(client, 5, (listener) => {
      invalidate = listener;
      return () => {};
    });
    cleanups.push(() => resource.pause());
    let latestBootstrap: BootstrapData | null = null;
    const appliedUnreadCounts: number[] = [];
    const appliedReadStates: boolean[] = [];
    const articlesReconciled = deferred();
    resource.connect({
      getBootstrap: () => latestBootstrap,
      applyBootstrap: (bootstrap) => {
        latestBootstrap = bootstrap;
        appliedUnreadCounts.push(bootstrap.counts.unread);
      },
      setBootstrapError: (message) => {
        if (message) throw new Error(message);
      },
      reloadArticles: async (signal) => {
        const article = database.articles.getArticle(1, existingArticle.id);
        if (!article || signal.aborted) return;
        appliedReadStates.push(article.isRead);
        if (article.isRead) articlesReconciled.resolve();
      },
      reloadRules: async () => {},
    });
    const currentBootstrap = () => {
      if (!latestBootstrap) throw new Error("Bootstrap data was not reloaded");
      return latestBootstrap;
    };

    resource.resume();
    await resource.loadBootstrap();
    expect(currentBootstrap().counts.unread).toBe(1);

    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: feed.title,
        siteUrl: null,
        articles: [
          {
            externalId: "delivered-story",
            title: "Newly delivered story",
            url: null,
            author: null,
            publishedAt: null,
            summary: "",
            imageUrl: null,
            feedContentHtml: null,
          },
        ],
      },
    });
    expect(database.bootstrap.getBootstrap(1).counts.unread).toBe(2);

    holdNextSnapshot = true;
    invalidate();
    await staleSnapshotStarted.promise;

    const optimistic = currentBootstrap();
    latestBootstrap = {
      ...optimistic,
      counts: { ...optimistic.counts, unread: 0 },
      feeds: optimistic.feeds.map((item) =>
        item.id === feed.id ? { ...item, unreadCount: 0 } : item,
      ),
    };
    appliedUnreadCounts.push(0);
    const releaseMutation = deferred();
    const mutation = resource.runCounterMutation(async () => {
      await releaseMutation.promise;
      database.articles.updateArticleState(1, existingArticle.id, { isRead: true });
    });

    releaseStaleSnapshot.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(currentBootstrap().counts.unread).toBe(0);
    expect(appliedReadStates).toEqual([]);

    releaseMutation.resolve();
    await mutation;
    await articlesReconciled.promise;

    expect(appliedUnreadCounts).not.toContain(2);
    expect(appliedReadStates).toEqual([true]);
    expect(currentBootstrap().counts.unread).toBe(1);
    expect(currentBootstrap().feeds[0]?.unreadCount).toBe(1);
  });

  it("does not let a delayed delivery snapshot revert saved settings", async () => {
    const database = new AppDatabase(":memory:");
    cleanups.push(() => database.close());
    const staleSnapshotStarted = deferred();
    const releaseStaleSnapshot = deferred();
    let holdNextSnapshot = false;
    const client = {
      ...api,
      bootstrap: async () => {
        const snapshot = {
          ...database.bootstrap.getBootstrap(1),
          aiSettings: {
            credentialStorageAvailable: false,
            providers: [],
            features: { articleSummary: null },
          },
        };
        if (holdNextSnapshot) {
          holdNextSnapshot = false;
          staleSnapshotStarted.resolve();
          await releaseStaleSnapshot.promise;
        }
        return snapshot;
      },
    };
    let invalidate = () => {};
    const resource = new ReaderDataResource(client, 5, (listener) => {
      invalidate = listener;
      return () => {};
    });
    cleanups.push(() => resource.pause());
    let latestBootstrap: BootstrapData | null = null;
    const appliedSettings: boolean[] = [];
    const reconciled = deferred();
    resource.connect({
      getBootstrap: () => latestBootstrap,
      applyBootstrap: (bootstrap) => {
        latestBootstrap = bootstrap;
        appliedSettings.push(bootstrap.settings.singleKeyShortcuts);
        if (appliedSettings.filter((value) => !value).length === 2) reconciled.resolve();
      },
      setBootstrapError: (message) => {
        if (message) throw new Error(message);
      },
      reloadArticles: async () => {},
      reloadRules: async () => {},
    });
    const currentBootstrap = () => {
      if (!latestBootstrap) throw new Error("Bootstrap data was not reloaded");
      return latestBootstrap;
    };

    resource.resume();
    await resource.loadBootstrap();
    expect(currentBootstrap().settings.singleKeyShortcuts).toBe(true);

    holdNextSnapshot = true;
    invalidate();
    await staleSnapshotStarted.promise;
    const savedSettings = database.settings.updateSettings(1, { singleKeyShortcuts: false });
    resource.mutateBootstrap((current) => ({ ...current, settings: savedSettings }));

    releaseStaleSnapshot.resolve();
    await reconciled.promise;

    expect(appliedSettings.slice(1)).toEqual([false, false]);
    expect(currentBootstrap().settings.singleKeyShortcuts).toBe(false);
  });

  it("replaces a stale add-feed snapshot after ingestion and reloads articles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedfold-data-resource-test-"));
    const database = new AppDatabase(join(directory, "feedfold.db"));
    const authService = new AuthService(database.auth);
    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const fetchStarted = [deferred(), deferred()];
    const fetchRelease = [deferred(), deferred()];
    let fetchIndex = 0;
    const feedFetcher: typeof fetch = async () => {
      const index = fetchIndex;
      fetchIndex += 1;
      fetchStarted[index]?.resolve();
      await fetchRelease[index]?.promise;
      return new Response(FEED_SOURCE, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      });
    };
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000, undefined, feedFetcher);
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
    });
    cleanups.push(
      () => rm(directory, { recursive: true, force: true }),
      () => database.close(),
      () => Promise.all([refresh.stop(), extraction.stop()]).then(() => undefined),
      () => app.close(),
    );

    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username: "resource-reader", password: "reader-password" },
    });
    for (const initialFeed of database.feeds.listFeeds(1))
      database.feeds.deleteFeed(1, initialFeed.id);
    const setCookie = registration.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    if (!cookie) throw new Error("Registration did not return a session cookie");

    const request = (options: InjectOptions) =>
      app.inject({ ...options, headers: { ...options.headers, cookie } });
    const createInput = (feedUrl: string): FeedInput => ({
      title: "Resource test feed",
      feedUrl,
      siteUrl: "https://example.test/",
      folderId: null,
      sourceKind: "published",
    });

    const oneShotCreate = await request({
      method: "POST",
      url: "/api/feeds",
      payload: createInput("https://example.test/one-shot.xml"),
    });
    const oneShotFeed = oneShotCreate.json<Feed>();
    await fetchStarted[0].promise;
    const oneShotSnapshot = (
      await request({ method: "GET", url: "/api/bootstrap" })
    ).json<BootstrapData>();
    expect(oneShotSnapshot.feeds[0]).toMatchObject({
      id: oneShotFeed.id,
      refreshing: true,
      unreadCount: 0,
    });

    fetchRelease[0].resolve();
    await refresh.waitForIdle();
    const completedServerSnapshot = (
      await request({ method: "GET", url: "/api/bootstrap" })
    ).json<BootstrapData>();
    expect(oneShotSnapshot.feeds[0]).toMatchObject({ refreshing: true, unreadCount: 0 });
    expect(completedServerSnapshot.feeds[0]).toMatchObject({ refreshing: false, unreadCount: 1 });

    await request({ method: "DELETE", url: `/api/feeds/${oneShotFeed.id}` });

    const client = {
      ...api,
      bootstrap: async (signal?: AbortSignal) => {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await request({ method: "GET", url: "/api/bootstrap" });
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return response.json<BootstrapData>();
      },
      createFeed: async (input: FeedInput) =>
        (await request({ method: "POST", url: "/api/feeds", payload: input })).json<Feed>(),
    };
    const resource = new ReaderDataResource(client, 5);
    cleanups.push(() => resource.pause());
    let latestBootstrap: BootstrapData | null = null;
    let latestArticles: ArticlePage | null = null;
    const healthyBootstrap = deferred();
    const articlesReloaded = deferred();
    resource.connect({
      getBootstrap: () => latestBootstrap,
      applyBootstrap: (bootstrap) => {
        latestBootstrap = bootstrap;
        if (bootstrap.feeds.some((feed) => !feed.refreshing && feed.unreadCount === 1)) {
          healthyBootstrap.resolve();
        }
      },
      setBootstrapError: (message) => {
        if (message) throw new Error(message);
      },
      reloadArticles: async (signal) => {
        if (signal.aborted) return;
        const articlePage = (
          await request({ method: "GET", url: "/api/articles?state=unread" })
        ).json<ArticlePage>();
        latestArticles = articlePage;
        if (articlePage.articles.length === 1) articlesReloaded.resolve();
      },
      reloadRules: async (signal) => {
        if (signal.aborted) return;
        (await request({ method: "GET", url: "/api/rules" })).json<{ rules: Rule[] }>();
      },
    });

    const currentBootstrap = () => {
      if (!latestBootstrap) throw new Error("The resource did not load bootstrap data");
      return latestBootstrap;
    };
    const currentArticles = () => {
      if (!latestArticles) throw new Error("The resource did not load articles");
      return latestArticles;
    };

    const trackedFeed = await resource.createFeed(createInput("https://example.test/tracked.xml"));
    await fetchStarted[1].promise;
    expect(currentBootstrap().feeds[0]).toMatchObject({
      id: trackedFeed.id,
      refreshing: true,
      unreadCount: 0,
    });

    fetchRelease[1].resolve();
    await Promise.all([refresh.waitForIdle(), healthyBootstrap.promise, articlesReloaded.promise]);
    expect(currentBootstrap().feeds[0]).toMatchObject({
      id: trackedFeed.id,
      refreshing: false,
      unreadCount: 1,
    });
    expect(currentArticles().articles).toHaveLength(1);
  });
});
