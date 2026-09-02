import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArticleState } from "../shared/types";
import type { AppView } from "./navigation";
import { readerRouteForSelection } from "./reader-state";
import {
  type AppRoute,
  appRoutePath,
  appRouteUrl,
  DEFAULT_READER_ROUTE,
  parseAppRoute,
  type ReaderRoute,
} from "./routes";

interface AppHistoryState {
  feedfold?: true;
  returnTo?: string;
  returnsWithBack?: boolean;
  articleIndex?: number;
}

function historyState(): AppHistoryState {
  return (window.history.state ?? {}) as AppHistoryState;
}

function readerRouteFromReturnPath(path: string | undefined, basePath: string): ReaderRoute | null {
  if (!path) return null;
  const base = basePath.replace(/\/$/, "");
  const url = new URL(`${base}${path}`, window.location.origin);
  const route = parseAppRoute(url.pathname, url.search, basePath);
  return route.kind === "reader" ? route : null;
}

function routeView(route: AppRoute): AppView {
  if (route.kind === "reader" || route.kind === "article") return "reader";
  if (route.kind === "add-feed") return "feeds";
  return route.kind;
}

export interface AppRouteController {
  route: AppRoute;
  readerRoute: ReaderRoute;
  view: AppView;
  routedArticleId: number | null;
  searchInput: string;
  setSearchInput: (value: string) => void;
  navigate: (route: AppRoute, historyMode?: "push" | "replace", articleIndex?: number) => void;
  navigateToView: (view: AppView) => void;
  selectScope: (feedId: number | null, folderId: number | null, state?: ArticleState) => void;
  setArticleContext: (route: ReaderRoute, articleIndex?: number) => void;
  openRulesFromArticle: (returnRoute: ReaderRoute) => void;
  returnToContextArticle: (articleId: number, returnRoute: ReaderRoute) => void;
  returnToArticleList: () => void;
  articleContext: () => { route: ReaderRoute; articleIndex?: number } | null;
  current: () => AppRoute;
}

export function useAppRoute(basePath: string): AppRouteController {
  const initialRoute = useRef(
    parseAppRoute(window.location.pathname, window.location.search, basePath),
  ).current;
  const initialArticleReturnRoute = useRef(
    initialRoute.kind === "article"
      ? readerRouteFromReturnPath(historyState().returnTo, basePath)
      : null,
  ).current;
  const initialReaderRoute = useRef<ReaderRoute>(
    initialRoute.kind === "reader"
      ? initialRoute
      : initialRoute.kind === "article"
        ? (initialArticleReturnRoute ?? { ...DEFAULT_READER_ROUTE, state: "all" })
        : DEFAULT_READER_ROUTE,
  ).current;
  const [route, setRoute] = useState<AppRoute>(initialRoute);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [searchInput, setSearchInput] = useState(initialReaderRoute.search);
  const currentRoute = useRef<AppRoute>(initialRoute);
  const lastReaderRoute = useRef<ReaderRoute>(initialReaderRoute);

  const applyRoute = useCallback((nextRoute: AppRoute) => {
    currentRoute.current = nextRoute;
    if (nextRoute.kind === "reader") {
      lastReaderRoute.current = nextRoute;
      setSearchInput(nextRoute.search);
    }
    setRoute(nextRoute);
    setHistoryRevision((current) => current + 1);
  }, []);

  const navigate = useCallback(
    (nextRoute: AppRoute, historyMode: "push" | "replace" = "push", articleIndex?: number) => {
      const url = appRouteUrl(nextRoute, basePath);
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      const previousState = historyState();
      if (currentUrl === url) {
        window.history.replaceState({ ...previousState, feedfold: true }, "", url);
        return;
      }

      const state: AppHistoryState = { feedfold: true };
      if (nextRoute.kind === "article") {
        state.returnTo = appRoutePath(lastReaderRoute.current);
        if (articleIndex !== undefined && articleIndex >= 0) state.articleIndex = articleIndex;
        state.returnsWithBack =
          (historyMode === "push" && currentRoute.current.kind === "reader") ||
          (historyMode === "replace" &&
            currentRoute.current.kind === "article" &&
            previousState.returnsWithBack === true);
      }

      if (historyMode === "replace") window.history.replaceState(state, "", url);
      else window.history.pushState(state, "", url);
      applyRoute(nextRoute);
    },
    [applyRoute, basePath],
  );

  useEffect(() => {
    const parsed = parseAppRoute(window.location.pathname, window.location.search, basePath);
    window.history.replaceState(
      { ...historyState(), feedfold: true },
      "",
      appRouteUrl(parsed, basePath),
    );
    const restoreRoute = () => {
      applyRoute(parseAppRoute(window.location.pathname, window.location.search, basePath));
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [applyRoute, basePath]);

  const readerRoute = useMemo(() => {
    void historyRevision;
    if (route.kind === "reader") return route;
    if (route.kind === "article") {
      return (
        readerRouteFromReturnPath(historyState().returnTo, basePath) ?? lastReaderRoute.current
      );
    }
    return lastReaderRoute.current;
  }, [basePath, historyRevision, route]);

  const setArticleContext = useCallback((nextReaderRoute: ReaderRoute, articleIndex?: number) => {
    lastReaderRoute.current = nextReaderRoute;
    const nextState: AppHistoryState = {
      ...historyState(),
      feedfold: true,
      returnTo: appRoutePath(nextReaderRoute),
      ...(articleIndex === undefined ? {} : { articleIndex }),
    };
    window.history.replaceState(nextState, "");
    setHistoryRevision((current) => current + 1);
    setSearchInput(nextReaderRoute.search);
  }, []);

  const navigateToView = useCallback(
    (nextView: AppView) => {
      navigate(
        nextView === "reader"
          ? lastReaderRoute.current
          : nextView === "settings"
            ? { kind: "settings", category: "appearance" }
            : { kind: nextView },
      );
    },
    [navigate],
  );

  const selectScope = useCallback(
    (feedId: number | null, folderId: number | null, state = readerRoute.state) => {
      navigate(readerRouteForSelection(state, feedId, folderId, readerRoute.search));
    },
    [navigate, readerRoute],
  );

  const openRulesFromArticle = useCallback(
    (returnRoute: ReaderRoute) => {
      const fromReaderRoute = currentRoute.current.kind === "reader";
      const returnsWithBack =
        fromReaderRoute ||
        (currentRoute.current.kind === "article" && historyState().returnsWithBack === true);
      navigate({ kind: "rules" }, fromReaderRoute ? "push" : "replace");
      window.history.replaceState(
        {
          ...historyState(),
          returnTo: appRoutePath(returnRoute),
          returnsWithBack,
        },
        "",
      );
    },
    [navigate],
  );

  const returnToContextArticle = useCallback(
    (articleId: number, returnRoute: ReaderRoute) => {
      const returnTo = appRoutePath(returnRoute);
      const returnsWithBack =
        historyState().returnTo === returnTo && historyState().returnsWithBack === true;
      navigate({ kind: "article", articleId }, "replace");
      window.history.replaceState({ ...historyState(), returnTo, returnsWithBack }, "");
      lastReaderRoute.current = returnRoute;
      setHistoryRevision((current) => current + 1);
    },
    [navigate],
  );

  const returnToArticleList = useCallback(() => {
    const state = historyState();
    if (state.feedfold && state.returnTo && state.returnsWithBack) {
      window.history.back();
      return;
    }
    const returnRoute = readerRouteFromReturnPath(state.returnTo, basePath);
    navigate(returnRoute ?? lastReaderRoute.current, "replace");
  }, [basePath, navigate]);

  const articleContext = useCallback(() => {
    const contextRoute = readerRouteFromReturnPath(historyState().returnTo, basePath);
    if (!contextRoute) return null;
    const { articleIndex } = historyState();
    return { route: contextRoute, ...(articleIndex === undefined ? {} : { articleIndex }) };
  }, [basePath]);

  return {
    route,
    readerRoute,
    view: routeView(route),
    routedArticleId: route.kind === "article" ? route.articleId : null,
    searchInput,
    setSearchInput,
    navigate,
    navigateToView,
    selectScope,
    setArticleContext,
    openRulesFromArticle,
    returnToContextArticle,
    returnToArticleList,
    articleContext,
    current: () => currentRoute.current,
  };
}
