import { afterEach, describe, expect, it, vi } from "vitest";
import { api as demoApi } from "../src/demo/api.js";
import { DEMO_RELEASE_ARTICLE_ID } from "../src/demo/fixtures.js";
import { DemoStore } from "../src/demo/store.js";

const DEMO_NOW = new Date("2026-08-12T12:00:00.000Z");

describe("static demo data", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves reader data without making a backend request", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("The network should not be used.")));
    vi.stubGlobal("fetch", fetch);

    await expect(demoApi.session()).resolves.toEqual({
      id: "demo",
      username: "demo",
      hasPassword: false,
    });
    await expect(demoApi.bootstrap()).resolves.toMatchObject({
      counts: { unread: 15, starred: 1, all: 17 },
      capabilities: { manualRefresh: true },
    });
    await expect(demoApi.authConfig()).resolves.toEqual({
      registrationAvailable: false,
      passkeysAvailable: false,
    });
    await expect(demoApi.passkeys()).resolves.toEqual({ passkeys: [], hasPassword: false });
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
    const release = store.article(DEMO_RELEASE_ARTICLE_ID);
    expect(release.isStarred).toBe(true);
    expect(release.url).toMatch(/^https:\/\/github\.com\/egornomic\/feedfold\/releases\/tag\/v/);
    expect(store.articles({ state: "all", feedId: release.feedId }).articles).toEqual([release]);

    for (const state of ["all", "unread", "starred"] as const) {
      expect(store.articles({ state }).articles[0]?.id).toBe(release.id);
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
