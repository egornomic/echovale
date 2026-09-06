import { JSDOM } from "jsdom";
import { act, createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { DemoStore } from "../../src/demo/store.js";
import type {
  DesktopRequest,
  DesktopResponse,
  FeedfoldDesktopBridge,
} from "../../src/shared/desktop.js";
import type { AppSettings, Article, BootstrapData } from "../../src/shared/types.js";

type HarnessState = {
  bootstrap: BootstrapData;
  queue: { articles: Article[] };
  actions: {
    articleTranslationStates: ReadonlyMap<
      number,
      { visible: boolean; loading: boolean; translation: { language: string } | null }
    >;
    applySettings: (settings: AppSettings) => void;
    toggleArticleTranslation: (article: Article) => void;
  };
};

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

describe("article AI state", () => {
  it("keeps a newly requested translation visible when an older settings-invalidated response arrives", async () => {
    const store = new DemoStore();
    const initialBootstrap = store.invoke("bootstrap", undefined) as BootstrapData;
    let releaseFirstTranslation = () => {};
    let firstTranslationObserved = () => {};
    let firstTranslationSettled = () => {};
    const firstTranslationStarted = new Promise<void>((resolve) => {
      firstTranslationObserved = resolve;
    });
    const firstTranslationFinished = new Promise<void>((resolve) => {
      firstTranslationSettled = resolve;
    });
    let translationRequests = 0;

    const invoke = async (request: DesktopRequest): Promise<DesktopResponse> => {
      try {
        const value = store.invoke(request.operation, request.payload);
        if (request.operation === "translateArticle" && translationRequests++ === 0) {
          firstTranslationObserved();
          await new Promise<void>((resolve) => {
            releaseFirstTranslation = resolve;
          });
          firstTranslationSettled();
        }
        return { ok: true, value };
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        return { ok: false, error: { message: error.message, status: 500, code: null } };
      }
    };
    const bridge: FeedfoldDesktopBridge = {
      platform: "desktop",
      invoke,
      exportOpml: () => invoke({ operation: "exportOpml" }),
      onDataChanged: () => () => {},
    };
    const dom = new JSDOM('<div id="app"></div>', {
      pretendToBeVisual: true,
      url: "https://feedfold.test/",
    });
    Object.defineProperty(dom.window, "feedfoldDesktop", { configurable: true, value: bridge });
    Object.defineProperty(dom.window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        media: "",
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      }),
    });

    const restoreBrowserGlobals = exposeBrowserGlobals(dom.window);
    const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = dom.window.document.querySelector<HTMLElement>("#app");
    if (!container) throw new Error("The app fixture is incomplete");
    let current: HarnessState | null = null;
    let root: ReturnType<typeof createRoot> | null = null;
    let resource: { pause: () => void } | null = null;

    try {
      const actionsModulePath: string = "../../src/client/article-actions.js";
      const queueModulePath: string = "../../src/client/article-queue.js";
      const routeModulePath: string = "../../src/client/app-route.js";
      const resourceModulePath: string = "../../src/client/data-resource.js";
      const [actionsModule, queueModule, routeModule, resourceModule] = await Promise.all([
        import(actionsModulePath),
        import(queueModulePath),
        import(routeModulePath),
        import(resourceModulePath),
      ]);
      const dataResource = new resourceModule.ReaderDataResource();
      resource = dataResource;

      function Harness() {
        const [bootstrap, setBootstrap] = useState(initialBootstrap);
        const bootstrapRef = useRef(bootstrap);
        bootstrapRef.current = bootstrap;
        const route = routeModule.useAppRoute("/");
        const queue = queueModule.useArticleQueue({
          route,
          dataResource,
          bootstrapReady: true,
          readingMode: "magazine",
          showToast: () => {},
        });
        const actions = actionsModule.useArticleActions({
          bootstrap,
          queue,
          route,
          dataResource,
          readingMode: "magazine",
          showToast: () => {},
        });
        dataResource.connect({
          getBootstrap: () => bootstrapRef.current,
          applyBootstrap: (next: BootstrapData) => {
            bootstrapRef.current = next;
            setBootstrap(next);
          },
          setBootstrapError: () => {},
          reloadArticles: (signal: AbortSignal, mode: "query" | "mutation" | "delivery") =>
            mode === "query"
              ? queue.reloadQuery(signal)
              : mode === "delivery"
                ? queue.reloadAfterDelivery(signal)
                : queue.reloadAfterMutation(signal),
          reloadRules: async () => {},
        });
        current = { bootstrap, queue, actions };

        const article = queue.articles.find((item: Article) => item.media === null);
        const state = article ? actions.articleTranslationStates.get(article.id) : null;
        return createElement(
          "output",
          { "data-testid": "translation-state" },
          `${bootstrap.settings.translationLanguage}:${state?.loading ? "loading" : state?.visible ? state.translation?.language : "hidden"}`,
        );
      }

      root = createRoot(container);
      await act(async () => root?.render(createElement(Harness)));
      await waitFor(
        "a readable demo article",
        () => current?.queue.articles.some((item) => !item.media) === true,
      );

      const article = () => {
        const selected = current?.queue.articles.find((item) => item.media === null);
        if (!selected) throw new Error("The demo did not load a readable article");
        return selected;
      };
      const translationState = () =>
        container.querySelector<HTMLOutputElement>('[data-testid="translation-state"]')
          ?.textContent;
      const germanSettings = store.invoke("updateSettings", {
        translationLanguage: "German",
      }) as AppSettings;
      await act(async () => current?.actions.applySettings(germanSettings));
      await waitFor("German settings", () => translationState() === "German:hidden");

      await act(async () => current?.actions.toggleArticleTranslation(article()));
      await firstTranslationStarted;
      await waitFor(
        "the delayed German translation",
        () => translationState() === "German:loading",
      );

      const polishSettings = store.invoke("updateSettings", {
        translationLanguage: "Polish",
      }) as AppSettings;
      await act(async () => current?.actions.applySettings(polishSettings));
      await waitFor("the cleared Polish translation", () => translationState() === "Polish:hidden");

      await act(async () => current?.actions.toggleArticleTranslation(article()));
      await waitFor("the current Polish translation", () => translationState() === "Polish:Polish");

      await act(async () => {
        releaseFirstTranslation();
        await firstTranslationFinished;
      });
      await waitFor(
        "the stale German translation to be ignored",
        () => translationState() === "Polish:Polish",
      );
      expect(translationState()).toBe("Polish:Polish");
      expect(translationRequests).toBe(2);
    } finally {
      releaseFirstTranslation();
      resource?.pause();
      if (root) await act(async () => root?.unmount());
      dom.window.close();
      if (previousActEnvironment === undefined)
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      else Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
      restoreBrowserGlobals();
    }
  });
});
