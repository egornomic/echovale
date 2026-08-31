import { afterEach, describe, expect, it, vi } from "vitest";
import { api as demoApi } from "../src/demo/api.js";
import { DemoStore } from "../src/demo/store.js";

const DEMO_NOW = new Date("2026-08-12T12:00:00.000Z");

describe("static demo data", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves reader data without making a backend request", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("The network should not be used.")));
    vi.stubGlobal("fetch", fetch);

    await expect(demoApi.session()).resolves.toEqual({ id: 1, username: "demo" });
    await expect(demoApi.bootstrap()).resolves.toMatchObject({
      counts: { unread: 15, starred: 1, all: 17 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps reader filters and counts in sync with article actions", () => {
    const store = new DemoStore(DEMO_NOW);

    expect(store.bootstrap().counts).toEqual({ unread: 15, starred: 1, all: 17 });
    expect(store.articles({ state: "unread" }).articles).toHaveLength(15);
    expect(store.articles({ state: "starred" }).articles).toHaveLength(1);

    store.updateArticleState(1, { isRead: true, isStarred: true });

    expect(store.bootstrap().counts).toEqual({ unread: 14, starred: 2, all: 17 });
    expect(store.articles({ state: "unread" }).articles.map((article) => article.id)).not.toContain(
      1,
    );
    expect(store.articles({ state: "all", search: "solar-powered" }).articles).toHaveLength(1);
  });

  it("starts with an explorable folder hierarchy", () => {
    const store = new DemoStore(DEMO_NOW);
    const bootstrap = store.bootstrap();

    expect(bootstrap.folders).toMatchObject([
      { id: 5, parentId: null, name: "feedfold", unreadCount: 1 },
      { id: 1, parentId: null, unreadCount: 6 },
      { id: 2, parentId: 1, unreadCount: 3 },
      { id: 3, parentId: null, unreadCount: 3 },
      { id: 4, parentId: null, unreadCount: 3 },
    ]);
    expect(bootstrap.feeds.some((feed) => feed.folderId === null)).toBe(true);
    expect(store.articles({ state: "all", folderId: 1 }).articles).toHaveLength(6);
    expect(store.articles({ state: "all", folderId: 2 }).articles).toHaveLength(3);
  });

  it("keeps the linked feedfold release saved and first in the demo", () => {
    const store = new DemoStore(new Date("2027-08-12T12:00:00.000Z"));
    const releaseFeed = store
      .bootstrap()
      .feeds.find((feed) => feed.feedUrl === "https://github.com/egornomic/feedfold/releases.atom");

    expect(releaseFeed).toMatchObject({
      folderId: 5,
      title: "releases",
      siteUrl: "https://github.com/egornomic/feedfold/releases",
      unreadCount: 1,
      totalCount: 1,
    });
    expect(store.articles({ state: "all", feedId: releaseFeed?.id }).articles).toMatchObject([
      {
        title: "feedfold 0.4.4",
        url: "https://github.com/egornomic/feedfold/releases/tag/v0.4.4",
        author: "egornomic",
        publishedAt: "2026-08-31T18:38:45.000Z",
        isStarred: true,
      },
    ]);

    for (const state of ["all", "unread", "starred"] as const) {
      expect(store.articles({ state }).articles[0]?.url).toBe(
        "https://github.com/egornomic/feedfold/releases/tag/v0.4.4",
      );
    }
  });

  it("moves a feed and its articles into a demo folder", () => {
    const store = new DemoStore(DEMO_NOW);
    const folder = store.createFolder({
      name: "Design",
      parentId: null,
      sortDirection: "newest",
    });

    store.updateFeed(1, { folderId: folder.id });

    const bootstrap = store.bootstrap();
    expect(bootstrap.folders.find((candidate) => candidate.id === folder.id)?.unreadCount).toBe(3);
    expect(store.articles({ state: "all", folderId: folder.id }).articles).toHaveLength(3);
    expect(store.article(1).folderId).toBe(folder.id);
  });
});
