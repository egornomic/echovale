import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ApplicationApi, ApplicationApiError } from "../../src/server/application-api.js";
import { AppDatabase, type ParsedFeed } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AiService } from "../../src/server/features/ai/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import { TelegramMediaService } from "../../src/server/telegram-media.js";
import { WebFeedService } from "../../src/server/web-feed.js";
import { XMediaService } from "../../src/server/x-media.js";
import type {
  DesktopRequest,
  DesktopResponse,
  FeedfoldDesktopBridge,
} from "../../src/shared/desktop.js";

const TEST_USER_ID = 1;

async function waitFor(description: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function parsedArticle(
  externalId: string,
  title: string,
  publishedAt: string,
): ParsedFeed["articles"][number] {
  return {
    externalId,
    title,
    url: null,
    author: null,
    publishedAt,
    summary: `${title} summary`,
    imageUrl: null,
    feedContentHtml: null,
  };
}

function exposeBrowserGlobals(window: JSDOM["window"]): () => void {
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const expose = (key: PropertyKey, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };

  expose("window", window);
  expose("document", window.document);
  expose("navigator", window.navigator);
  expose("Element", window.Element);
  expose("HTMLElement", window.HTMLElement);
  expose("Node", window.Node);
  expose("Event", window.Event);
  expose("MouseEvent", window.MouseEvent);
  expose("KeyboardEvent", window.KeyboardEvent);
  expose("DOMException", window.DOMException);

  return () => {
    for (const [key, descriptor] of [...previous].reverse()) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function articleHeading(container: HTMLElement): string | null {
  return (
    container
      .querySelector<HTMLElement>(".article-swipe-layer.is-active .article-header h2")
      ?.textContent?.trim() ?? null
  );
}

function nextArticleButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Next article (J)"]');
  if (!button) throw new Error("The article reader did not render its next button");
  return button;
}

function openArticleButton(container: HTMLElement, title: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".article-open-button")].find(
    (candidate) => candidate.textContent?.includes(`Open ${title}`),
  );
  if (!button) throw new Error(`The article list did not render ${title}`);
  return button;
}

function expandedArticleTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>(".expanded-article .article-header h2")].map(
    (heading) => heading.textContent?.trim() ?? "",
  );
}

function activeExpandedArticleTitle(container: HTMLElement): string | null {
  return (
    container
      .querySelector<HTMLElement>(".expanded-article.is-active .article-header h2")
      ?.textContent?.trim() ?? null
  );
}

describe("live article delivery", () => {
  it("keeps newly fetched articles at the end of active reading queues", async () => {
    const database = new AppDatabase(":memory:");
    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const webFeeds = new WebFeedService();
    let feedRefreshCount = 0;
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000, webFeeds, async () => {
      feedRefreshCount += 1;
      const latestItem =
        feedRefreshCount > 1
          ? `<item>
                <guid>delivered-expanded</guid>
                <title>Delivered into expanded view</title>
                <pubDate>Wed, 12 Aug 2026 12:00:00 GMT</pubDate>
                <description>Delivered into expanded view summary</description>
              </item>`
          : "";
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <title>Live reading</title>
              <link>https://example.test/</link>
              <description>Stories delivered while the queue is open.</description>
              ${latestItem}
              <item>
                <guid>delivered</guid>
                <title>Delivered while reading</title>
                <pubDate>Tue, 11 Aug 2026 12:00:00 GMT</pubDate>
                <description>Delivered while reading summary</description>
              </item>
            </channel>
          </rss>`,
        { status: 200, headers: { "Content-Type": "application/rss+xml" } },
      );
    });
    const application = new ApplicationApi({
      database,
      extractionQueue: extraction,
      refreshService: refresh,
      webFeedService: webFeeds,
      aiService: new AiService(database, { credentialCipher: null }),
      telegramMediaService: new TelegramMediaService(1_000),
      xMediaService: new XMediaService(1_000),
    });
    const feed = database.feeds.createFeed(TEST_USER_ID, {
      title: "Live reading",
      feedUrl: "https://example.test/live-reading.xml",
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
          parsedArticle("starting", "Starting article", "2026-08-10T12:00:00.000Z"),
          parsedArticle("last-loaded", "Last loaded article", "2026-08-09T12:00:00.000Z"),
        ],
      },
    });

    let deliveredArticleListRequests = 0;
    const invoke = async (request: DesktopRequest): Promise<DesktopResponse> => {
      try {
        const value = await application.invoke(request);
        if (
          request.operation === "articles" &&
          database.articles
            .listArticlePage(TEST_USER_ID, { state: "all" })
            .articles.some(({ title }) => title === "Delivered while reading")
        ) {
          deliveredArticleListRequests += 1;
        }
        return { ok: true, value };
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        return {
          ok: false,
          error: {
            message: error.message,
            status: caught instanceof ApplicationApiError ? caught.status : 500,
            code: caught instanceof ApplicationApiError ? caught.code : null,
          },
        };
      }
    };
    const bridge: FeedfoldDesktopBridge = {
      platform: "desktop",
      invoke,
      exportOpml: () => invoke({ operation: "exportOpml" }),
      onDataChanged: (listener) => refresh.subscribe(TEST_USER_ID, listener),
    };

    const dom = new JSDOM('<div id="app"></div>', {
      pretendToBeVisual: true,
      url: "https://feedfold.test/articles/unread",
    });
    Object.defineProperty(dom.window, "feedfoldDesktop", { configurable: true, value: bridge });
    Object.defineProperty(dom.window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }),
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {},
    });
    dom.window.document.documentElement.dataset.inputModality = "keyboard";
    const restoreBrowserGlobals = exposeBrowserGlobals(dom.window);
    const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = dom.window.document.querySelector<HTMLElement>("#app");
    if (!container) throw new Error("The app fixture is incomplete");
    const root = createRoot(container);

    try {
      const appModulePath: string = "../../src/client/App.js";
      const { App } = await import(appModulePath);
      await act(async () => root.render(createElement(App)));
      await waitFor(
        "the initial unread articles",
        () => container.querySelectorAll(".article-open-button").length === 2,
      );
      await act(async () => openArticleButton(container, "Starting article").click());
      await waitFor(
        "the first article to open",
        () => articleHeading(container) === "Starting article",
      );
      expect(nextArticleButton(container).disabled).toBe(false);

      await act(async () => nextArticleButton(container).click());
      await waitFor(
        "the end of the initially loaded sequence",
        () => articleHeading(container) === "Last loaded article",
      );
      await waitFor(
        "the initial articles to be read",
        () =>
          database.articles.listArticlePage(TEST_USER_ID, { state: "unread" }).articles.length ===
          0,
      );
      expect(nextArticleButton(container).disabled).toBe(true);

      const refreshButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Refresh this view (R)"]',
      );
      if (!refreshButton) throw new Error("The reader did not render its refresh button");
      await act(async () => refreshButton.click());
      await waitFor("the fetched article to be stored", () =>
        database.articles
          .listArticlePage(TEST_USER_ID, { state: "unread" })
          .articles.some(({ title }) => title === "Delivered while reading"),
      );
      await waitFor(
        "the delivered article to become reachable",
        () => !nextArticleButton(container).disabled,
      );
      await waitFor("the active refresh reconciliation", () => deliveredArticleListRequests >= 2);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(nextArticleButton(container).disabled).toBe(false);
      expect(articleHeading(container)).toBe("Last loaded article");

      await act(async () => nextArticleButton(container).click());
      await waitFor(
        "navigation into the delivered article",
        () => articleHeading(container) === "Delivered while reading",
      );
      const delivered = database.articles
        .listArticlePage(TEST_USER_ID, { state: "all" })
        .articles.find(({ title }) => title === "Delivered while reading");
      expect(delivered).toBeDefined();
      expect(dom.window.location.pathname).toBe(`/articles/${delivered?.id}`);

      const backButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Back to articles"]',
      );
      if (!backButton) throw new Error("The reader did not render its back button");
      await act(async () => backButton.click());
      await waitFor(
        "the unread article list to return",
        () => dom.window.location.pathname === "/articles/unread",
      );
      const allArticlesButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "All articles",
      );
      if (!allArticlesButton) throw new Error("The reader did not render its All articles filter");
      await act(async () => allArticlesButton.click());
      await waitFor(
        "all articles to load",
        () => container.querySelectorAll(".article-open-button").length === 3,
      );
      const expandedViewButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Expanded view"]',
      );
      if (!expandedViewButton)
        throw new Error("The reader did not render its Expanded view button");
      await act(async () => expandedViewButton.click());
      await waitFor(
        "the expanded article stream",
        () => expandedArticleTitles(container).length === 3,
      );
      expect(expandedArticleTitles(container)).toEqual([
        "Delivered while reading",
        "Starting article",
        "Last loaded article",
      ]);

      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j" }));
      });
      await waitFor(
        "expanded navigation into the second article",
        () => activeExpandedArticleTitle(container) === "Starting article",
      );
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight" }));
      });
      await waitFor(
        "the end of the expanded sequence",
        () => activeExpandedArticleTitle(container) === "Last loaded article",
      );

      const articleRequestsBeforeExpandedRefresh = deliveredArticleListRequests;
      await act(async () => refreshButton.click());
      await waitFor("the expanded article to be fetched", () =>
        database.articles
          .listArticlePage(TEST_USER_ID, { state: "all" })
          .articles.some(({ title }) => title === "Delivered into expanded view"),
      );
      await waitFor(
        "the expanded refresh reconciliation",
        () => deliveredArticleListRequests >= articleRequestsBeforeExpandedRefresh + 2,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(expandedArticleTitles(container)).toEqual([
        "Delivered while reading",
        "Starting article",
        "Last loaded article",
        "Delivered into expanded view",
      ]);
      expect(activeExpandedArticleTitle(container)).toBe("Last loaded article");

      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "j" }));
      });
      await waitFor(
        "expanded navigation into the delivered article",
        () => activeExpandedArticleTitle(container) === "Delivered into expanded view",
      );
    } finally {
      await act(async () => root.unmount());
      await Promise.all([refresh.stop(), extraction.stop()]);
      await webFeeds.close();
      database.close();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
      restoreBrowserGlobals();
      dom.window.close();
    }
  });
});
