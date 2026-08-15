import {
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast as showToast } from "sonner";
import type {
  Article,
  ArticleState,
  BootstrapData,
  Feed,
  Folder as FolderType,
  Rule,
  SessionUser,
} from "../shared/types";
import { ApiError, AUTH_REQUIRED_EVENT, api, errorMessage } from "./api";
import { useAppRoute } from "./app-route";
import { useArticleActions } from "./article-actions";
import { useArticleQueue } from "./article-queue";
import { LoginPage, SessionLoading } from "./auth";
import { type ReaderDataBinding, ReaderDataResource } from "./data-resource";
import { isDesktopApp } from "./desktop";
import type {
  FeedManagementAction,
  FolderManagementAction,
  ManagementRequest,
} from "./feed-management";
import { folderPathLabel } from "./folder-hierarchy";
import type { RuleFormDraft } from "./management/rules";
import { type AppView, ReaderToolbar, Sidebar } from "./navigation";
import {
  AppSkeleton,
  ArticleList,
  ArticleListSkeleton,
  EMPTY_ARTICLE_SUMMARY_STATE,
  EMPTY_ARTICLE_TRANSLATION_STATE,
  EmptyArticles,
  ExpandedStream,
  InlineError,
  ReaderPane,
  StartupError,
} from "./reader";
import { ARTICLE_FONT_MAX, ARTICLE_FONT_MIN, useReaderPreferences } from "./reader-preferences";
import {
  filterRuleName,
  readerRouteForSelection,
  readerScopeLabel,
  readerScopeUnreadCount,
  refreshFeedIds,
} from "./reader-state";
import {
  appRoutePath,
  DEFAULT_READER_ROUTE,
  type ReaderRoute,
  routeAfterFeedDeletion,
} from "./routes";

const APP_BASE_PATH = import.meta.env.BASE_URL;
const DEMO_SOURCE_URL =
  (import.meta as ImportMeta & { env?: { VITE_FEEDFOLD_DEMO?: string } }).env
    ?.VITE_FEEDFOLD_DEMO === "true"
    ? "https://github.com/egornomic/feedfold"
    : undefined;
const FeedsPage = lazy(() => import("./management/feeds"));
const AddFeedPage = lazy(async () => ({
  default: (await import("./management/feeds")).AddFeedPage,
}));
const RulesPage = lazy(() => import("./management/rules"));
const SettingsPage = lazy(() => import("./management/settings"));
const ShortcutHelp = lazy(() => import("./management/shortcut-help"));
const ContextManagementDialog = lazy(() => import("./management/context-dialog"));

interface SidebarLayoutSnapshot {
  items: Array<{ element: HTMLElement; left: number; top: number }>;
}

function visibleSidebarMotionItems(main: HTMLElement | null): HTMLElement[] {
  if (!main) return [];
  const content = main.querySelectorAll<HTMLElement>(
    [
      ".reader-title-row > *",
      ".article-list > ol",
      ".mode-magazine .article-document",
      ".expanded-stream",
    ].join(","),
  );
  return [...content].filter((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  });
}

function feedManagementRequest(feedId: number, action: FeedManagementAction): ManagementRequest {
  if (action === "settings") return { kind: "feed-settings", feedId };
  if (action === "selection") return { kind: "web-feed-selection", feedId };
  if (action === "rename") return { kind: "rename-feed", feedId };
  if (action === "move") return { kind: "move-feed", feedId };
  if (action === "rule") return { kind: "create-feed-rule", feedId };
  return { kind: "unsubscribe-feed", feedId };
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function usesSpaceForActivation(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'button, a[href], summary, [role="button"], [role="checkbox"], [role="menuitem"], [role="option"], [role="radio"], [role="switch"], [role="tab"]',
    ) !== null
  );
}

function ManagementRouteFallback() {
  return (
    <div className="management-route-loading" role="status" aria-label="Loading page">
      <span className="skeleton-line wide" />
      <span className="skeleton-line" />
      <span className="skeleton-line short" />
    </div>
  );
}

export function App() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionRequestId = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);

  const loadSession = useCallback(async () => {
    const requestId = sessionRequestId.current + 1;
    sessionRequestId.current = requestId;
    setCheckingSession(true);
    setSessionError(null);
    try {
      const sessionUser = await api.session();
      if (sessionRequestId.current === requestId) setUser(sessionUser);
    } catch (error) {
      if (sessionRequestId.current !== requestId) return;
      setUser(null);
      if (!(error instanceof ApiError && error.status === 401)) {
        setSessionError(
          !navigator.onLine
            ? "You are offline. Reconnect, then try again."
            : error instanceof ApiError
              ? errorMessage(error)
              : "feedfold could not reach the server. Check the connection, then try again.",
        );
      }
    } finally {
      if (sessionRequestId.current === requestId) setCheckingSession(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
    return () => {
      sessionRequestId.current += 1;
    };
  }, [loadSession]);

  useEffect(() => {
    const requireAuthentication = () => {
      setUser(null);
      setCheckingSession(false);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  if (checkingSession) return <SessionLoading />;
  if (sessionError) {
    return <StartupError message={sessionError} retry={() => void loadSession()} />;
  }
  if (!user) return <LoginPage onAuthenticated={setUser} />;
  return <ReaderApp key={user.id} user={user} onLogout={logout} />;
}

function ReaderApp({ user, onLogout }: { user: SessionUser; onLogout: () => Promise<void> }) {
  const route = useAppRoute(APP_BASE_PATH);
  const preferences = useReaderPreferences(user.id);
  const { desktopSidebarCollapsed, setDesktopSidebarCollapsed } = preferences;
  const dataResourceRef = useRef<ReaderDataResource | null>(null);
  if (!dataResourceRef.current) dataResourceRef.current = new ReaderDataResource();
  const dataResource = dataResourceRef.current;
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleFormDraft | null>(null);
  const [managementRequest, setManagementRequest] = useState<ManagementRequest | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const sequence = useRef<{ startedAt: number } | null>(null);
  const ruleDraftId = useRef(0);
  const ruleReturnRoute = useRef<ReaderRoute | null>(null);
  const bootstrapRef = useRef(bootstrap);
  const readingWorkspaceRef = useRef<HTMLDivElement>(null);
  const sidebarLayoutSnapshot = useRef<SidebarLayoutSnapshot | null>(null);
  const sidebarLayoutAnimations = useRef<Animation[]>([]);
  bootstrapRef.current = bootstrap;

  const toggleDesktopSidebar = useCallback(() => {
    const main = document.querySelector<HTMLElement>(".main-column");
    sidebarLayoutSnapshot.current = {
      items: (route.view === "reader" ? visibleSidebarMotionItems(main) : []).map((element) => {
        const bounds = element.getBoundingClientRect();
        return { element, left: bounds.left, top: bounds.top };
      }),
    };
    setDesktopSidebarCollapsed((current) => !current);
  }, [route.view, setDesktopSidebarCollapsed]);

  useLayoutEffect(() => {
    const snapshot = sidebarLayoutSnapshot.current;
    if (!snapshot) return;
    sidebarLayoutSnapshot.current = null;
    for (const animation of sidebarLayoutAnimations.current) animation.cancel();

    const main = document.querySelector<HTMLElement>(".main-column");
    const toggleLabel = desktopSidebarCollapsed ? "Show sidebar" : "Hide sidebar";
    const toggle = document.querySelector<HTMLElement>(
      `.sidebar-collapse-button[aria-label="${toggleLabel}"]`,
    );
    const styles = window.getComputedStyle(document.documentElement);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = Number.parseFloat(
      styles.getPropertyValue(reducedMotion ? "--duration-reduced" : "--duration-surface"),
    );
    const easing = reducedMotion ? "ease" : styles.getPropertyValue("--ease-in-out").trim();
    const animations: Animation[] = [];

    if (reducedMotion) {
      if (main) {
        animations.push(main.animate([{ opacity: 0.86 }, { opacity: 1 }], { duration, easing }));
      }
      if (toggle) {
        animations.push(toggle.animate([{ opacity: 0.72 }, { opacity: 1 }], { duration, easing }));
      }
    } else {
      for (const { element, left, top } of snapshot.items) {
        if (!element.isConnected) continue;
        const bounds = element.getBoundingClientRect();
        const offsetX = left - bounds.left;
        const offsetY = top - bounds.top;
        if (Math.abs(offsetX) < 0.5 && Math.abs(offsetY) < 0.5) continue;
        animations.push(
          element.animate(
            [
              { transform: `translate3d(${offsetX}px, ${offsetY}px, 0)` },
              { transform: "translate3d(0, 0, 0)" },
            ],
            { duration, easing },
          ),
        );
      }
    }

    sidebarLayoutAnimations.current = animations;
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [desktopSidebarCollapsed]);

  const queue = useArticleQueue({
    route,
    dataResource,
    bootstrapReady: bootstrap !== null,
    readingMode: preferences.readingMode,
    showToast,
  });
  const articleActions = useArticleActions({
    bootstrap,
    queue,
    route,
    dataResource,
    readingMode: preferences.readingMode,
    showToast,
  });

  const reloadRules = useCallback(async (signal: AbortSignal) => {
    setRulesLoading(true);
    setRulesError(null);
    try {
      const nextRules = await api.rules(signal);
      if (!signal.aborted) setRules(nextRules);
    } catch (error) {
      if (!signal.aborted) setRulesError(errorMessage(error));
    } finally {
      if (!signal.aborted) setRulesLoading(false);
    }
  }, []);

  const resourceBinding: ReaderDataBinding = {
    getBootstrap: () => bootstrapRef.current,
    applyBootstrap: (nextBootstrap) => {
      bootstrapRef.current = nextBootstrap;
      setBootstrap(nextBootstrap);
    },
    setBootstrapError,
    reloadArticles: (signal, mode) =>
      mode === "query"
        ? queue.reloadQuery(signal)
        : mode === "delivery"
          ? queue.reloadAfterDelivery(signal)
          : queue.reloadAfterMutation(signal),
    reloadRules,
  };
  dataResource.connect(resourceBinding);

  useEffect(() => {
    dataResource.resume();
    void dataResource.loadBootstrap();
    return () => dataResource.pause();
  }, [dataResource]);

  useEffect(() => {
    if (route.view === "rules") void dataResource.loadRules();
  }, [dataResource, route.view]);

  useEffect(() => {
    if (route.route) setNavOpen(false);
  }, [route.route]);

  const selectScope = useCallback(
    (feedId: number | null, folderId: number | null, state: ArticleState = "unread") => {
      const nextRoute = readerRouteForSelection(state, feedId, folderId, route.readerRoute.search);
      const reloadArticles = appRoutePath(route.current()) === appRoutePath(nextRoute);
      queue.invalidate();
      route.selectScope(feedId, folderId, state);
      setNavOpen(false);
      void dataResource.loadBootstrap();
      if (reloadArticles) void queue.loadArticles();
    },
    [dataResource, queue, route],
  );

  const navigateTo = useCallback(
    (view: AppView) => {
      route.navigateToView(view);
      setNavOpen(false);
    },
    [route],
  );

  const openAddFeed = useCallback(() => {
    route.navigate({ kind: "add-feed", sourceUrl: "" });
    setNavOpen(false);
  }, [route]);

  const submitSearch = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      route.navigate(
        readerRouteForSelection(
          route.readerRoute.state,
          route.readerRoute.scope === "feed" ? route.readerRoute.scopeId : null,
          route.readerRoute.scope === "folder" ? route.readerRoute.scopeId : null,
          route.searchInput.trim(),
        ),
      );
    },
    [route],
  );

  const filterSelectedText = useCallback(
    (article: Article, text: string) => {
      const pattern = text.replace(/\s+/g, " ").trim();
      if (!pattern) return;
      ruleDraftId.current += 1;
      setRuleDraft({
        id: ruleDraftId.current,
        name: filterRuleName(pattern),
        article,
        articleIndex: Math.max(
          0,
          queue.articles.findIndex((item) => item.id === article.id),
        ),
        feedId: article.feedId,
        field: "any",
        pattern,
      });
      ruleReturnRoute.current = route.readerRoute;
      route.openRulesFromArticle(route.readerRoute);
    },
    [queue.articles, route],
  );

  const returnToContextArticle = useCallback(
    (draft: RuleFormDraft) => {
      const returnRoute = ruleReturnRoute.current ?? route.readerRoute;
      queue.preserveContextArticle(draft.article, draft.articleIndex, returnRoute);
      route.returnToContextArticle(draft.article.id, returnRoute);
    },
    [queue, route],
  );

  const openFeedManagement = useCallback((feed: Feed, action: FeedManagementAction) => {
    setManagementRequest(feedManagementRequest(feed.id, action));
  }, []);

  const openFeedManagementById = useCallback(
    (feedId: number, action: FeedManagementAction) => {
      const feed = bootstrap?.feeds.find((candidate) => candidate.id === feedId);
      if (feed) openFeedManagement(feed, action);
    },
    [bootstrap, openFeedManagement],
  );

  const openFolderManagement = useCallback((folder: FolderType, action: FolderManagementAction) => {
    if (action === "settings") {
      setManagementRequest({ kind: "folder-settings", folderId: folder.id });
    } else if (action === "add-feed") {
      setManagementRequest({ kind: "add-feed-to-folder", folderId: folder.id });
    } else if (action === "add-folder") {
      setManagementRequest({ kind: "add-folder", parentId: folder.id });
    } else if (action === "rule") {
      setManagementRequest({ kind: "create-folder-rule", folderId: folder.id });
    } else {
      setManagementRequest({ kind: "delete-folder", folderId: folder.id });
    }
  }, []);

  const moveFeed = useCallback(
    async (feed: Feed, folderId: number | null): Promise<boolean> => {
      try {
        await dataResource.updateFeed(feed.id, { folderId });
        const destination = folderPathLabel(folderId, bootstrapRef.current?.folders ?? []);
        showToast(`Moved ${feed.title} to ${destination}`);
        return true;
      } catch (error) {
        showToast(`Could not move ${feed.title}: ${errorMessage(error)}`);
        return false;
      }
    },
    [dataResource],
  );

  const unsubscribeFromFeed = useCallback(
    async (feed: Feed): Promise<boolean> => {
      try {
        await dataResource.deleteFeed(feed.id);
        showToast(`Unsubscribed from ${feed.title}`);
        const currentRoute = route.current();
        const readerRoute =
          currentRoute.kind === "reader" || currentRoute.kind === "article"
            ? route.readerRoute
            : DEFAULT_READER_ROUTE;
        const nextRoute = routeAfterFeedDeletion(currentRoute, readerRoute, feed.id);
        queue.invalidate();
        if (nextRoute) route.navigate(nextRoute, "replace");
        return true;
      } catch (error) {
        showToast(`Could not unsubscribe from ${feed.title}: ${errorMessage(error)}`);
        return false;
      }
    },
    [dataResource, queue, route],
  );

  const refresh = useCallback(
    async (feedId?: number, forceAll = false) => {
      if (!bootstrap) return;
      const selectedFeedId = route.readerRoute.scope === "feed" ? route.readerRoute.scopeId : null;
      const selectedFolderId =
        route.readerRoute.scope === "folder" ? route.readerRoute.scopeId : null;
      const ids = forceAll
        ? undefined
        : refreshFeedIds(bootstrap, feedId ?? selectedFeedId, selectedFolderId);
      const trackedIds = bootstrap.feeds
        .filter((feed) => !feed.paused && (!ids || ids.includes(feed.id)))
        .map((feed) => feed.id);
      try {
        const { result, settled } = await dataResource.beginRefresh(ids, trackedIds);
        showToast(`Refreshing ${result.requested} ${result.requested === 1 ? "feed" : "feeds"}`);
        await settled;
        showToast("Feeds refreshed");
      } catch (error) {
        showToast(`Could not refresh feeds: ${errorMessage(error)}`);
      }
    },
    [bootstrap, dataResource, route.readerRoute],
  );

  const changeReadingMode = useCallback(
    (mode: "magazine" | "expanded") => {
      queue.clearKeyboardTarget();
      preferences.setReadingMode(mode);
    },
    [preferences, queue],
  );

  const scrollArticlePage = useCallback(
    (direction: 1 | -1): boolean => {
      const workspace = readingWorkspaceRef.current;
      if (!workspace || route.view !== "reader") return false;
      const scrollContainer =
        preferences.readingMode === "expanded"
          ? workspace
          : route.routedArticleId !== null
            ? workspace.querySelector<HTMLElement>(".article-swipe-layer.is-active")
            : null;
      if (!scrollContainer) return false;
      scrollContainer.scrollTop += direction * scrollContainer.clientHeight * 0.85;
      return true;
    },
    [preferences.readingMode, route.routedArticleId, route.view],
  );

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (managementRequest) return;
      if (event.key === "Escape") {
        setShortcutHelpOpen(false);
        setNavOpen(false);
        if (route.routedArticleId !== null) route.returnToArticleList();
        return;
      }
      if (shortcutHelpOpen) return;
      if (isEditable(event.target) || !bootstrap?.settings.singleKeyShortcuts) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (sequence.current && Date.now() - sequence.current.startedAt < 1200) {
        sequence.current = null;
        const destinations: Record<string, () => void> = {
          u: () => selectScope(null, null, "unread"),
          s: () => selectScope(null, null, "starred"),
          a: () => selectScope(null, null, "all"),
          f: () => navigateTo("feeds"),
          r: () => navigateTo("rules"),
          ",": () => navigateTo("settings"),
        };
        if (destinations[key]) {
          event.preventDefault();
          destinations[key]();
        }
        return;
      }

      if (key === "g") {
        sequence.current = { startedAt: Date.now() };
        return;
      }
      if (event.shiftKey && key === "r") {
        event.preventDefault();
        void refresh(undefined, true);
        return;
      }
      if (key === " ") {
        if (usesSpaceForActivation(event.target)) return;
        if (scrollArticlePage(event.shiftKey ? -1 : 1)) event.preventDefault();
        return;
      }

      const activeArticle = queue.activeArticle;
      const actions: Record<string, () => void> = {
        j: () => void articleActions.moveArticle(1),
        k: () => void articleActions.moveArticle(-1),
        arrowright: () => void articleActions.moveArticle(1),
        arrowleft: () => void articleActions.moveArticle(-1),
        u: () => {
          if (!activeArticle) return;
          const nextRead = !activeArticle.isRead;
          void articleActions.changeArticleState(activeArticle, { isRead: nextRead });
          showToast(nextRead ? "Article marked as read" : "Article marked as unread");
        },
        s: () => {
          if (!activeArticle) return;
          void articleActions.changeArticleState(activeArticle, {
            isStarred: !activeArticle.isStarred,
          });
          showToast(activeArticle.isStarred ? "Removed from Saved" : "Article saved");
        },
        c: () => void articleActions.copyArticleUrl(activeArticle),
        o: () => articleActions.openArticleSource(activeArticle),
        w: () => {
          if (activeArticle && (preferences.readingMode === "expanded" || route.routedArticleId)) {
            void articleActions.toggleFullContent(activeArticle);
          }
        },
        m: () => {
          if (activeArticle && (preferences.readingMode === "expanded" || route.routedArticleId)) {
            articleActions.toggleArticleSummary(activeArticle);
          }
        },
        t: () => {
          if (activeArticle && (preferences.readingMode === "expanded" || route.routedArticleId)) {
            articleActions.toggleArticleTranslation(activeArticle);
          }
        },
        r: () => void refresh(),
        "[": () => {
          const next = Math.max(ARTICLE_FONT_MIN, preferences.articleFontSize - 1);
          preferences.setArticleFontSize(next);
          showToast(`Article text size set to ${next}px`);
        },
        "]": () => {
          const next = Math.min(ARTICLE_FONT_MAX, preferences.articleFontSize + 1);
          preferences.setArticleFontSize(next);
          showToast(`Article text size set to ${next}px`);
        },
        "1": () => changeReadingMode("magazine"),
        "2": () => changeReadingMode("expanded"),
        "?": () => setShortcutHelpOpen(true),
      };
      if (actions[key]) {
        event.preventDefault();
        actions[key]();
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    articleActions,
    bootstrap?.settings.singleKeyShortcuts,
    changeReadingMode,
    managementRequest,
    navigateTo,
    preferences,
    queue.activeArticle,
    refresh,
    route,
    scrollArticlePage,
    selectScope,
    shortcutHelpOpen,
  ]);

  if (!bootstrap) {
    return bootstrapError ? (
      <StartupError message={bootstrapError} retry={() => void dataResource.loadBootstrap()} />
    ) : (
      <AppSkeleton />
    );
  }

  const selectedFeedId = route.readerRoute.scope === "feed" ? route.readerRoute.scopeId : null;
  const selectedFolderId = route.readerRoute.scope === "folder" ? route.readerRoute.scopeId : null;
  const readerOpen = route.routedArticleId !== null;
  const title = readerScopeLabel(
    bootstrap,
    selectedFeedId,
    selectedFolderId,
    route.readerRoute.state,
  );

  return (
    <div
      className={`app-shell${route.view === "reader" ? "" : " is-management-view"}${readerOpen ? " is-reading-article" : ""}${desktopSidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
    >
      <a className="skip-link" href="#main-content">
        Skip to articles
      </a>
      <Sidebar
        bootstrap={bootstrap}
        user={user}
        localApp={isDesktopApp()}
        sourceUrl={DEMO_SOURCE_URL}
        currentState={route.readerRoute.state}
        selectedFeedId={selectedFeedId}
        selectedFolderId={selectedFolderId}
        currentView={route.view}
        open={navOpen}
        collapsed={desktopSidebarCollapsed}
        onClose={() => setNavOpen(false)}
        onToggleCollapse={toggleDesktopSidebar}
        onSelectState={(state) => selectScope(null, null, state)}
        onSelectScope={selectScope}
        onAddFeed={openAddFeed}
        onNavigate={navigateTo}
        onFeedAction={openFeedManagement}
        onFolderAction={openFolderManagement}
        onMoveFeed={moveFeed}
        onRefresh={() => void refresh()}
        onLogout={onLogout}
      />

      <main id="main-content" className="main-column" tabIndex={-1}>
        {route.view === "reader" ? (
          <>
            <ReaderToolbar
              title={title}
              articleState={route.readerRoute.state}
              unreadCount={readerScopeUnreadCount(bootstrap, selectedFeedId, selectedFolderId)}
              searchInput={route.searchInput}
              searchActive={Boolean(route.readerRoute.search)}
              mode={preferences.readingMode}
              refreshing={bootstrap.feeds.some((feed) => feed.refreshing)}
              markReadPending={articleActions.markReadPending}
              navOpen={navOpen}
              readingArticle={readerOpen && preferences.readingMode === "magazine"}
              onToggleNav={() => setNavOpen((current) => !current)}
              onArticleStateChange={(state) => selectScope(selectedFeedId, selectedFolderId, state)}
              onSearchInput={route.setSearchInput}
              onSearch={submitSearch}
              onClearSearch={() => {
                route.navigate(
                  readerRouteForSelection(
                    route.readerRoute.state,
                    selectedFeedId,
                    selectedFolderId,
                    "",
                  ),
                );
              }}
              onModeChange={changeReadingMode}
              onRefresh={() => void refresh()}
              onRefreshAll={() => void refresh(undefined, true)}
              onMarkRead={() => void articleActions.markVisibleRead()}
              onMarkReadByAge={(days) => void articleActions.markOlderArticlesRead(days)}
              onHelp={() => setShortcutHelpOpen(true)}
            />

            <div
              ref={readingWorkspaceRef}
              className={`reading-workspace mode-${preferences.readingMode}${readerOpen ? " is-reading-article" : ""}`}
            >
              {queue.loading ? (
                <ArticleListSkeleton mode={preferences.readingMode} />
              ) : queue.error ? (
                <InlineError
                  title={
                    route.routedArticleId === null
                      ? "Could not load articles"
                      : "Could not load the article"
                  }
                  detail={queue.error}
                  retry={() =>
                    route.routedArticleId === null
                      ? void queue.loadArticles()
                      : queue.retryRoutedArticle()
                  }
                />
              ) : queue.articles.length === 0 ? (
                <EmptyArticles
                  hasFeeds={bootstrap.feeds.length > 0}
                  search={route.readerRoute.search}
                  state={route.readerRoute.state}
                  onAddFeed={openAddFeed}
                  onShowAll={() =>
                    route.navigate(
                      readerRouteForSelection(
                        "all",
                        selectedFeedId,
                        selectedFolderId,
                        route.readerRoute.search,
                      ),
                    )
                  }
                  onClearSearch={() => {
                    route.navigate(
                      readerRouteForSelection(
                        route.readerRoute.state,
                        selectedFeedId,
                        selectedFolderId,
                        "",
                      ),
                    );
                  }}
                />
              ) : preferences.readingMode === "magazine" ? (
                <>
                  <ArticleList
                    key={`${route.readerRoute.state}:${selectedFeedId ?? "all"}:${selectedFolderId ?? "all"}:${route.readerRoute.search}`}
                    articles={queue.articles}
                    activeId={queue.activeArticleId}
                    markReadOnScroll={bootstrap.settings.markReadOnScroll}
                    showYouTubeDescriptions={bootstrap.settings.showYouTubeDescriptions}
                    hasMore={queue.nextCursor !== null}
                    loadingMore={queue.loadingMore}
                    onLoadMore={() => void queue.loadOlderArticles()}
                    onOpen={articleActions.openArticle}
                    onMarkPassedRead={articleActions.markPassedArticlesRead}
                    onToggleRead={(article) =>
                      void articleActions.changeArticleState(article, { isRead: !article.isRead })
                    }
                    onToggleStar={(article) =>
                      void articleActions.changeArticleState(article, {
                        isStarred: !article.isStarred,
                      })
                    }
                  />
                  <ReaderPane
                    article={queue.activeArticle}
                    canPrevious={queue.activeArticleIndex > 0}
                    canNext={
                      queue.activeArticleIndex >= 0 &&
                      (queue.activeArticleIndex < queue.articles.length - 1 ||
                        (queue.nextCursor !== null && !queue.loadingMore))
                    }
                    fullContentVisible={
                      queue.activeArticle
                        ? articleActions.fullContentVisibleIds.has(queue.activeArticle.id)
                        : false
                    }
                    summaryState={
                      queue.activeArticle
                        ? (articleActions.articleSummaryStates.get(queue.activeArticle.id) ??
                          EMPTY_ARTICLE_SUMMARY_STATE)
                        : EMPTY_ARTICLE_SUMMARY_STATE
                    }
                    translationState={
                      queue.activeArticle
                        ? (articleActions.articleTranslationStates.get(queue.activeArticle.id) ??
                          EMPTY_ARTICLE_TRANSLATION_STATE)
                        : EMPTY_ARTICLE_TRANSLATION_STATE
                    }
                    translationLanguage={bootstrap.settings.translationLanguage}
                    customPrompts={bootstrap.settings.customPrompts}
                    showYouTubeDescriptions={bootstrap.settings.showYouTubeDescriptions}
                    onBack={route.returnToArticleList}
                    onPrevious={() => articleActions.moveArticle(-1)}
                    onNext={() => articleActions.moveArticle(1)}
                    onToggleRead={(article) =>
                      void articleActions.changeArticleState(article, { isRead: !article.isRead })
                    }
                    onToggleStar={(article) =>
                      void articleActions.changeArticleState(article, {
                        isStarred: !article.isStarred,
                      })
                    }
                    onCopy={(article) => void articleActions.copyArticleUrl(article)}
                    onOpenSource={articleActions.openArticleSource}
                    onFeedAction={openFeedManagementById}
                    onToggleFullContent={(article) =>
                      void articleActions.toggleFullContent(article)
                    }
                    onRunSummaryPrompt={articleActions.runArticleSummaryPrompt}
                    onToggleTranslation={articleActions.toggleArticleTranslation}
                    onRegenerateSummary={articleActions.regenerateArticleSummary}
                    onOpenAiSettings={() => navigateTo("settings")}
                    onFilterSelection={filterSelectedText}
                  />
                </>
              ) : (
                <ExpandedStream
                  articles={
                    route.routedArticleId !== null && queue.activeArticle
                      ? [queue.activeArticle]
                      : queue.articles
                  }
                  activeId={queue.activeArticleId}
                  topAlignedId={queue.expandedKeyboardTargetId}
                  fullContentVisibleIds={articleActions.fullContentVisibleIds}
                  summaryStates={articleActions.articleSummaryStates}
                  translationStates={articleActions.articleTranslationStates}
                  translationLanguage={bootstrap.settings.translationLanguage}
                  customPrompts={bootstrap.settings.customPrompts}
                  showYouTubeDescriptions={bootstrap.settings.showYouTubeDescriptions}
                  markReadOnScroll={bootstrap.settings.markReadOnScroll}
                  hasMore={route.routedArticleId === null && queue.nextCursor !== null}
                  loadingMore={queue.loadingMore}
                  onLoadMore={() => void queue.loadOlderArticles()}
                  onActivate={(article) => queue.selectArticle(article.id)}
                  onMarkPassedRead={articleActions.markPassedArticlesRead}
                  onToggleRead={(article) =>
                    void articleActions.changeArticleState(article, { isRead: !article.isRead })
                  }
                  onToggleStar={(article) =>
                    void articleActions.changeArticleState(article, {
                      isStarred: !article.isStarred,
                    })
                  }
                  onCopy={(article) => void articleActions.copyArticleUrl(article)}
                  onOpenSource={articleActions.openArticleSource}
                  onFeedAction={openFeedManagementById}
                  onToggleFullContent={(article) => void articleActions.toggleFullContent(article)}
                  onRunSummaryPrompt={articleActions.runArticleSummaryPrompt}
                  onToggleTranslation={articleActions.toggleArticleTranslation}
                  onRegenerateSummary={articleActions.regenerateArticleSummary}
                  onOpenAiSettings={() => navigateTo("settings")}
                  onFilterSelection={filterSelectedText}
                />
              )}
            </div>
          </>
        ) : route.route.kind === "add-feed" ? (
          <Suspense fallback={<ManagementRouteFallback />}>
            <AddFeedPage
              bootstrap={bootstrap}
              initialSourceUrl={route.route.sourceUrl}
              mutations={dataResource}
              onMenu={() => setNavOpen(true)}
              onBack={() => route.navigate({ kind: "feeds" }, "replace")}
              showToast={showToast}
            />
          </Suspense>
        ) : route.view === "feeds" ? (
          <Suspense fallback={<ManagementRouteFallback />}>
            <FeedsPage
              bootstrap={bootstrap}
              mutations={dataResource}
              onMenu={() => setNavOpen(true)}
              onAddFeed={openAddFeed}
              onAddFolder={() => setManagementRequest({ kind: "create-folder" })}
              onRefresh={(feedId) => void refresh(feedId)}
              onFeedAction={openFeedManagement}
              onFolderAction={openFolderManagement}
              onMoveFeed={moveFeed}
              showToast={showToast}
            />
          </Suspense>
        ) : route.view === "rules" ? (
          <Suspense fallback={<ManagementRouteFallback />}>
            <RulesPage
              bootstrap={bootstrap}
              rules={rules}
              loading={rulesLoading}
              error={rulesError}
              draft={ruleDraft}
              mutations={dataResource}
              onMenu={() => setNavOpen(true)}
              onClearDraft={() => setRuleDraft(null)}
              onReturnToArticle={returnToContextArticle}
              onRetry={() => dataResource.reload({ articles: true, rules: true })}
              showToast={showToast}
            />
          </Suspense>
        ) : (
          <Suspense fallback={<ManagementRouteFallback />}>
            <SettingsPage
              settings={bootstrap.settings}
              aiSettings={bootstrap.aiSettings}
              theme={preferences.theme}
              fontSize={preferences.articleFontSize}
              mutations={dataResource}
              onMenu={() => setNavOpen(true)}
              onTheme={preferences.setTheme}
              onFontSize={preferences.setArticleFontSize}
              onSettings={articleActions.applySettings}
              onAiSettings={articleActions.applyAiSettings}
              showToast={showToast}
            />
          </Suspense>
        )}
      </main>

      {shortcutHelpOpen ? (
        <Suspense fallback={null}>
          <ShortcutHelp
            enabled={bootstrap.settings.singleKeyShortcuts}
            onClose={() => setShortcutHelpOpen(false)}
          />
        </Suspense>
      ) : null}
      {managementRequest ? (
        <Suspense fallback={null}>
          <ContextManagementDialog
            key={
              "feedId" in managementRequest
                ? `${managementRequest.kind}:${managementRequest.feedId}`
                : "folderId" in managementRequest
                  ? `${managementRequest.kind}:${managementRequest.folderId}`
                  : "parentId" in managementRequest
                    ? `${managementRequest.kind}:${managementRequest.parentId}`
                    : managementRequest.kind
            }
            request={managementRequest}
            bootstrap={bootstrap}
            mutations={dataResource}
            onClose={() => setManagementRequest(null)}
            onRefresh={(feedId) => refresh(feedId)}
            onUnsubscribe={unsubscribeFromFeed}
            showToast={showToast}
          />
        </Suspense>
      ) : null}
      <button
        className={`nav-scrim${navOpen ? " is-open" : ""}`}
        type="button"
        aria-label="Close navigation"
        onClick={() => setNavOpen(false)}
      />
    </div>
  );
}
