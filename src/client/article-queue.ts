import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Article, ReadingMode } from "../shared/types";
import { api, errorMessage } from "./api";
import type { AppRouteController } from "./app-route";
import { articlesWithContextReturn, type ContextArticleReturn } from "./contextual-filter";
import type { ReaderDataResource } from "./data-resource";
import {
  appendUnseenArticles,
  articleQueryForReaderRoute,
  articlesWithLocalState,
  firstUnseenArticlePage,
  fullContentIdsAfterReload,
} from "./reader-state";
import { appRoutePath, type ReaderRoute } from "./routes";

export interface ArticleQueueController {
  articles: Article[];
  setArticles: Dispatch<SetStateAction<Article[]>>;
  articlesRef: React.RefObject<Article[]>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  activeArticleId: number | null;
  activeArticle: Article | null;
  activeArticleIndex: number;
  expandedKeyboardTargetId: number | null;
  queryRevision: number;
  fullContentLoadedIds: React.RefObject<Set<number>>;
  loadArticles: (mode?: "query" | "mutation") => Promise<void>;
  reloadQuery: (signal: AbortSignal) => Promise<void>;
  reloadAfterMutation: (signal: AbortSignal) => Promise<void>;
  reloadAfterDelivery: (signal: AbortSignal) => Promise<void>;
  loadOlderArticles: () => Promise<Article[]>;
  selectArticle: (articleId: number, keyboardTarget?: boolean) => void;
  clearKeyboardTarget: () => void;
  mergeArticle: (article: Article) => void;
  preserveContextArticle: (
    article: Article,
    articleIndex: number,
    returnRoute: ReaderRoute,
  ) => void;
  invalidate: () => void;
  retryRoutedArticle: () => void;
}

interface ArticleQueueOptions {
  route: AppRouteController;
  dataResource: ReaderDataResource;
  bootstrapReady: boolean;
  readingMode: ReadingMode;
  showToast: (message: string) => void;
}

export function useArticleQueue({
  route,
  dataResource,
  bootstrapReady,
  readingMode,
  showToast,
}: ArticleQueueOptions): ArticleQueueController {
  const {
    articleContext,
    current: currentRoute,
    readerRoute,
    route: appRoute,
    routedArticleId,
    setArticleContext,
  } = route;
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeArticleId, setActiveArticleId] = useState<number | null>(routedArticleId);
  const [expandedKeyboardTargetId, setExpandedKeyboardTargetId] = useState<number | null>(
    routedArticleId,
  );
  const [routedArticleRetry, setRoutedArticleRetry] = useState(0);
  const [queryRevision, setQueryRevision] = useState(0);
  const articlesRef = useRef(articles);
  const requestId = useRef(0);
  const queueReloadId = useRef(0);
  const loadedReaderRequestKey = useRef<string | null>(null);
  const articleListNeedsReload = useRef(false);
  const contextArticleReturn = useRef<ContextArticleReturn | null>(null);
  const contextArticleReturnRoute = useRef<ReaderRoute | null>(null);
  const fullContentLoadedIds = useRef(new Set<number>());
  const readerRouteRef = useRef(readerRoute);
  const deliveryRequestKeyRef = useRef(`${appRoutePath(readerRoute)}:${readingMode}`);
  articlesRef.current = articles;
  const deliveryRequestKey = `${appRoutePath(readerRoute)}:${readingMode}`;

  useLayoutEffect(() => {
    const requestKeyChanged = deliveryRequestKeyRef.current !== deliveryRequestKey;
    readerRouteRef.current = readerRoute;
    deliveryRequestKeyRef.current = deliveryRequestKey;
    if (requestKeyChanged) dataResource.cancelArticleDelivery();
  }, [dataResource, deliveryRequestKey, readerRoute]);

  const activeArticleIndex = useMemo(
    () => articles.findIndex((article) => article.id === activeArticleId),
    [activeArticleId, articles],
  );
  const activeArticle = activeArticleIndex < 0 ? null : (articles[activeArticleIndex] ?? null);

  const reloadQuery = useCallback(
    async (signal: AbortSignal) => {
      const nextRoute = currentRoute();
      if (!bootstrapReady || nextRoute.kind !== "reader") return;
      const requestKey = `${appRoutePath(nextRoute)}:${readingMode}`;
      queueReloadId.current += 1;
      const currentRequestId = requestId.current + 1;
      requestId.current = currentRequestId;
      setLoadingMore(false);
      const returnTarget =
        contextArticleReturn.current &&
        contextArticleReturnRoute.current &&
        appRoutePath(contextArticleReturnRoute.current) === appRoutePath(nextRoute)
          ? contextArticleReturn.current
          : null;
      if (contextArticleReturn.current && !returnTarget) {
        contextArticleReturn.current = null;
        contextArticleReturnRoute.current = null;
      }
      if (!returnTarget) setLoading(true);
      setError(null);
      try {
        const page = await api.articles(
          articleQueryForReaderRoute(nextRoute, {
            limit: readingMode === "expanded" ? 20 : 100,
            includeContent: readingMode === "expanded",
          }),
          signal,
        );
        if (
          signal.aborted ||
          requestId.current !== currentRequestId ||
          currentRoute().kind !== "reader"
        ) {
          return;
        }

        const nextArticles = articlesWithContextReturn(page.articles, returnTarget);
        articleListNeedsReload.current = false;
        loadedReaderRequestKey.current = requestKey;
        setArticles(nextArticles);
        setNextCursor(page.nextCursor);
        fullContentLoadedIds.current = new Set(
          readingMode === "expanded" ? page.articles.map((article) => article.id) : [],
        );
        setExpandedKeyboardTargetId(
          returnTarget && readingMode === "expanded" ? returnTarget.article.id : null,
        );
        setActiveArticleId((current) => {
          if (returnTarget) return returnTarget.article.id;
          if (current !== null && nextArticles.some((article) => article.id === current)) {
            return current;
          }
          return nextArticles[0]?.id ?? null;
        });
        setQueryRevision((current) => current + 1);
        if (contextArticleReturn.current === returnTarget) {
          contextArticleReturn.current = null;
          contextArticleReturnRoute.current = null;
        }
      } catch (caught) {
        if (!signal.aborted && requestId.current === currentRequestId) {
          setError(errorMessage(caught));
        }
      } finally {
        if (!signal.aborted && requestId.current === currentRequestId) setLoading(false);
      }
    },
    [bootstrapReady, currentRoute, readingMode],
  );

  const reloadAfterMutation = useCallback(
    async (signal: AbortSignal) => {
      const nextRoute = currentRoute();
      const queryRoute =
        nextRoute.kind === "reader" ? nextRoute : nextRoute.kind === "article" ? readerRoute : null;
      if (!queryRoute) {
        loadedReaderRequestKey.current = null;
        return;
      }
      queueReloadId.current += 1;
      const routePath = appRoutePath(nextRoute);
      const activeIndex = articlesRef.current.findIndex(
        (article) => article.id === activeArticleId,
      );
      const preserveActive =
        activeIndex >= 0 && (nextRoute.kind === "article" || readingMode === "expanded")
          ? articlesRef.current[activeIndex]
          : null;
      const currentRequestId = requestId.current + 1;
      requestId.current = currentRequestId;
      setLoadingMore(false);

      try {
        const targetCount = Math.max(
          articlesRef.current.length,
          readingMode === "expanded" ? 20 : 100,
        );
        const reloaded: Article[] = [];
        let cursor: string | null = null;
        do {
          const page = await api.articles(
            articleQueryForReaderRoute(queryRoute, {
              limit: Math.min(500, targetCount - reloaded.length),
              includeContent: readingMode === "expanded",
              ...(cursor ? { cursor } : {}),
            }),
            signal,
          );
          reloaded.push(...page.articles);
          cursor = page.nextCursor;
        } while (cursor && reloaded.length < targetCount);

        const refreshedActiveArticle = preserveActive
          ? await api.article(preserveActive.id, signal)
          : null;
        if (
          signal.aborted ||
          requestId.current !== currentRequestId ||
          appRoutePath(currentRoute()) !== routePath
        ) {
          return;
        }
        const nextArticles = articlesWithContextReturn(
          reloaded,
          refreshedActiveArticle
            ? { article: refreshedActiveArticle, index: activeIndex }
            : preserveActive
              ? { article: preserveActive, index: activeIndex }
              : null,
        );
        setArticles(nextArticles);
        setNextCursor(cursor);
        setActiveArticleId((current) =>
          current !== null && nextArticles.some((article) => article.id === current)
            ? current
            : (nextArticles[0]?.id ?? null),
        );
        fullContentLoadedIds.current = fullContentIdsAfterReload(
          readingMode,
          nextArticles,
          refreshedActiveArticle?.id ?? null,
        );
        loadedReaderRequestKey.current = `${appRoutePath(queryRoute)}:${readingMode}`;
      } catch (caught) {
        if (!signal.aborted) setError(errorMessage(caught));
        loadedReaderRequestKey.current = null;
      } finally {
        if (!signal.aborted && requestId.current === currentRequestId) setLoading(false);
      }
    },
    [activeArticleId, currentRoute, readerRoute, readingMode],
  );

  const reloadAfterDelivery = useCallback(
    async (signal: AbortSignal) => {
      const nextRoute = currentRoute();
      const queryRoute =
        nextRoute.kind === "reader"
          ? nextRoute
          : nextRoute.kind === "article"
            ? readerRouteRef.current
            : null;
      if (!bootstrapReady || !queryRoute) {
        loadedReaderRequestKey.current = null;
        return;
      }
      const requestKey = `${appRoutePath(queryRoute)}:${readingMode}`;
      const currentQueueReloadId = queueReloadId.current;

      const page = await api.articles(
        articleQueryForReaderRoute(queryRoute, {
          limit: readingMode === "expanded" ? 20 : 100,
          includeContent: readingMode === "expanded",
        }),
        signal,
      );
      const currentAppRoute = currentRoute();
      const currentQueryRoute =
        currentAppRoute.kind === "reader"
          ? currentAppRoute
          : currentAppRoute.kind === "article"
            ? readerRouteRef.current
            : null;
      const currentRequestKey = currentQueryRoute
        ? `${appRoutePath(currentQueryRoute)}:${readingMode}`
        : null;
      if (
        signal.aborted ||
        queueReloadId.current !== currentQueueReloadId ||
        currentRequestKey !== requestKey ||
        deliveryRequestKeyRef.current !== requestKey
      ) {
        if (!currentQueryRoute) loadedReaderRequestKey.current = null;
        return;
      }

      requestId.current += 1;
      setLoadingMore(false);

      const appendDeliveredArticles = (
        candidates: Article[],
        cursor: string | null,
        readerQueue: boolean,
      ) => {
        const { articles: nextArticles, appended } = appendUnseenArticles(
          articlesRef.current,
          candidates,
        );
        setArticles((current) => appendUnseenArticles(current, candidates).articles);
        setNextCursor(cursor);
        setError(null);
        if (readingMode === "expanded") {
          for (const article of appended) fullContentLoadedIds.current.add(article.id);
        }
        if (!readerQueue) return;
        articleListNeedsReload.current = false;
        loadedReaderRequestKey.current = requestKey;
        setActiveArticleId((current) =>
          current !== null && nextArticles.some((article) => article.id === current)
            ? current
            : (nextArticles[0]?.id ?? null),
        );
      };

      if (currentAppRoute.kind === "article" || readingMode === "expanded") {
        appendDeliveredArticles(page.articles, page.nextCursor, currentAppRoute.kind === "reader");
        return;
      }

      const loadedCount = articlesRef.current.length;
      const reloaded = [...page.articles];
      let cursor = page.nextCursor;
      while (cursor && reloaded.length < loadedCount) {
        const nextPage = await api.articles(
          articleQueryForReaderRoute(queryRoute, {
            limit: Math.min(500, loadedCount - reloaded.length),
            includeContent: false,
            cursor,
          }),
          signal,
        );
        reloaded.push(...nextPage.articles);
        cursor = nextPage.nextCursor;
      }
      const latestAppRoute = currentRoute();
      const latestRequestKey =
        latestAppRoute.kind === "reader"
          ? `${appRoutePath(latestAppRoute)}:${readingMode}`
          : deliveryRequestKeyRef.current;
      if (
        signal.aborted ||
        queueReloadId.current !== currentQueueReloadId ||
        latestRequestKey !== requestKey ||
        deliveryRequestKeyRef.current !== requestKey
      ) {
        return;
      }

      if (latestAppRoute.kind === "article") {
        appendDeliveredArticles(reloaded, cursor, false);
        return;
      }
      if (latestAppRoute.kind !== "reader") {
        loadedReaderRequestKey.current = null;
        return;
      }

      articleListNeedsReload.current = false;
      loadedReaderRequestKey.current = requestKey;
      const nextArticles = articlesWithLocalState(articlesRef.current, reloaded);
      setArticles(nextArticles);
      setNextCursor(cursor);
      setError(null);
      fullContentLoadedIds.current = new Set();
      setActiveArticleId((current) =>
        current !== null && nextArticles.some((article) => article.id === current)
          ? current
          : (nextArticles[0]?.id ?? null),
      );
      setQueryRevision((current) => current + 1);
    },
    [bootstrapReady, currentRoute, readingMode],
  );

  const loadArticles = useCallback(
    async (mode: "query" | "mutation" = "query") => {
      await dataResource.loadArticles(mode);
    },
    [dataResource],
  );

  const loadOlderArticles = useCallback(async (): Promise<Article[]> => {
    const nextRoute = currentRoute();
    const queryRoute =
      nextRoute.kind === "reader" ? nextRoute : nextRoute.kind === "article" ? readerRoute : null;
    if (!bootstrapReady || !nextCursor || loadingMore || !queryRoute) return [];

    const currentRequestId = requestId.current;
    setLoadingMore(true);
    try {
      const appended = await dataResource.requestArticles(async (signal) => {
        const page = await firstUnseenArticlePage(
          articlesRef.current,
          nextCursor,
          async (cursor) => {
            const loaded = await api.articles(
              articleQueryForReaderRoute(queryRoute, {
                limit: readingMode === "expanded" ? 20 : 100,
                includeContent: readingMode === "expanded",
                cursor,
              }),
              signal,
            );
            const latestRoute = currentRoute();
            if (
              signal.aborted ||
              requestId.current !== currentRequestId ||
              (latestRoute.kind !== "reader" && latestRoute.kind !== "article")
            ) {
              return undefined;
            }
            return { candidates: loaded.articles, nextCursor: loaded.nextCursor };
          },
        );
        if (signal.aborted || requestId.current !== currentRequestId) return [];
        setNextCursor(page.nextCursor);
        if (page.appended.length === 0) return [];
        setArticles((current) => appendUnseenArticles(current, page.candidates).articles);
        if (readingMode === "expanded") {
          for (const article of page.appended) fullContentLoadedIds.current.add(article.id);
        }
        return page.appended;
      });
      return appended ?? [];
    } catch (caught) {
      if (requestId.current === currentRequestId) {
        showToast(`Could not load more articles: ${errorMessage(caught)}`);
      }
      return [];
    } finally {
      if (requestId.current === currentRequestId) setLoadingMore(false);
    }
  }, [
    bootstrapReady,
    currentRoute,
    dataResource,
    loadingMore,
    nextCursor,
    readerRoute,
    readingMode,
    showToast,
  ]);

  useEffect(() => {
    const nextRoute = appRoute;
    dataResource.cancelArticles();
    requestId.current += 1;
    setLoadingMore(false);
    if (!bootstrapReady) return;
    if (nextRoute.kind === "article") {
      articleListNeedsReload.current = true;
      return;
    }
    if (nextRoute.kind !== "reader") return;
    const requestKey = `${appRoutePath(nextRoute)}:${readingMode}`;
    if (
      articleListNeedsReload.current ||
      contextArticleReturn.current ||
      loadedReaderRequestKey.current !== requestKey
    ) {
      void (articleListNeedsReload.current ? dataResource.reloadReader() : loadArticles());
    }
  }, [appRoute, bootstrapReady, dataResource, loadArticles, readingMode]);

  useEffect(() => {
    const articleId = routedArticleId;
    if (!bootstrapReady || articleId === null) return;
    void routedArticleRetry;
    let active = true;
    const currentRequestId = requestId.current;
    const existing = articlesRef.current.find((article) => article.id === articleId);

    const showArticle = (article: Article) => {
      if (!active) return;
      if (!existing) loadedReaderRequestKey.current = null;
      setArticles((current) =>
        current.some((item) => item.id === article.id)
          ? current.map((item) =>
              item.id === article.id
                ? { ...article, isRead: item.isRead, isStarred: item.isStarred }
                : item,
            )
          : [article, ...current],
      );
      setError(null);
      setActiveArticleId(article.id);
    };

    if (existing) {
      showArticle(existing);
      return () => {
        active = false;
      };
    }

    const currentQueueReloadId = queueReloadId.current + 1;
    queueReloadId.current = currentQueueReloadId;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        await dataResource.requestArticles(async (signal) => {
          const article = await api.article(articleId, signal);
          const context = articleContext();
          const queueRoute = context?.route ?? {
            kind: "reader" as const,
            scope: "feed" as const,
            scopeId: article.feedId,
            state: "all" as const,
            search: "",
          };
          const page = await api.articles(
            articleQueryForReaderRoute(queueRoute, {
              limit: readingMode === "expanded" ? 20 : 100,
              includeContent: readingMode === "expanded",
              anchorId: article.id,
            }),
            signal,
          );
          if (
            signal.aborted ||
            !active ||
            requestId.current !== currentRequestId ||
            queueReloadId.current !== currentQueueReloadId
          ) {
            return;
          }
          const pageIndex = page.articles.findIndex((item) => item.id === article.id);
          const anchoredArticles = articlesWithContextReturn(page.articles, {
            article,
            index: page.anchorIndex ?? (pageIndex >= 0 ? pageIndex : (context?.articleIndex ?? 0)),
          });
          const nextArticles = appendUnseenArticles(anchoredArticles, articlesRef.current).articles;
          const actualArticleIndex = nextArticles.findIndex((item) => item.id === article.id);
          setArticleContext(
            queueRoute,
            actualArticleIndex >= 0 ? actualArticleIndex : context?.articleIndex,
          );
          loadedReaderRequestKey.current = `${appRoutePath(queueRoute)}:${readingMode}`;
          fullContentLoadedIds.current.add(article.id);
          setArticles(nextArticles);
          setNextCursor(page.nextCursor);
          setError(null);
          setActiveArticleId(article.id);
        });
      } catch (caught) {
        if (active) setError(errorMessage(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      dataResource.cancelArticles();
    };
  }, [
    articleContext,
    bootstrapReady,
    dataResource,
    readingMode,
    routedArticleId,
    routedArticleRetry,
    setArticleContext,
  ]);

  const selectArticle = useCallback((articleId: number, keyboardTarget = false) => {
    setActiveArticleId(articleId);
    setExpandedKeyboardTargetId(keyboardTarget ? articleId : null);
  }, []);

  const mergeArticle = useCallback((updated: Article) => {
    fullContentLoadedIds.current.add(updated.id);
    setArticles((current) =>
      current.map((article) =>
        article.id === updated.id
          ? { ...updated, isRead: article.isRead, isStarred: article.isStarred }
          : article,
      ),
    );
  }, []);

  const preserveContextArticle = useCallback(
    (article: Article, articleIndex: number, returnRoute: ReaderRoute) => {
      contextArticleReturn.current = { article, index: articleIndex };
      contextArticleReturnRoute.current = returnRoute;
      setActiveArticleId(article.id);
      setExpandedKeyboardTargetId(readingMode === "expanded" ? article.id : null);
    },
    [readingMode],
  );

  const invalidate = useCallback(() => {
    loadedReaderRequestKey.current = null;
  }, []);

  const articleListReloadPending =
    appRoute.kind === "reader" &&
    articleListNeedsReload.current &&
    contextArticleReturn.current === null &&
    error === null;

  return {
    articles,
    setArticles,
    articlesRef,
    loading: loading || articleListReloadPending,
    loadingMore,
    error,
    nextCursor,
    activeArticleId,
    activeArticle,
    activeArticleIndex,
    expandedKeyboardTargetId,
    queryRevision,
    fullContentLoadedIds,
    loadArticles,
    reloadQuery,
    reloadAfterMutation,
    reloadAfterDelivery,
    loadOlderArticles,
    selectArticle,
    clearKeyboardTarget: () => setExpandedKeyboardTargetId(null),
    mergeArticle,
    preserveContextArticle,
    invalidate,
    retryRoutedArticle: () => setRoutedArticleRetry((current) => current + 1),
  };
}
