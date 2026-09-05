import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  BookOpenText,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FileText,
  Inbox,
  Languages,
  List,
  ListFilter,
  LoaderCircle,
  Mail,
  MailOpen,
  MessageSquareText,
  RefreshCw,
  Rss,
  SearchX,
  Sparkles,
  Star,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { extractHttpLinks } from "../shared/article-links";
import { telegramPostIdentity } from "../shared/telegram";
import type {
  AiCustomPrompt,
  Article,
  ArticleAiTranslation,
  ArticleState,
  ReadingMode,
  TelegramArticleMedia,
  XArticleMedia,
} from "../shared/types";
import { withXVideoPlaceholder, xPostId, xVideoPlaceholderId, xVideoPostId } from "../shared/x";
import { AiMarkdown } from "./ai-markdown";
import { api, appUrl, errorMessage } from "./api";
import { articleContentView, shouldShowArticleDescription } from "./article-content";
import { ArticleHtml } from "./article-html";
import {
  type ArticleSwipeDirection,
  type ArticleSwipeIntent,
  articleSwipeDirection,
  articleSwipeDownAction,
  articleSwipeIntent,
  articleSwipeOffset,
} from "./article-swipe";
import { ArticleThumbnailPlaceholder } from "./article-thumbnail-placeholder";
import { BrandLogo } from "./brand";
import {
  FeedActionMenuItems,
  type FeedManagementAction,
  handleActionMenuKeyDown,
} from "./feed-management";
import { ImageLightbox, type ImageLightboxItem, type ImageLightboxState } from "./image-lightbox";
import { interactionMotionIsInstant, useMotionPresence } from "./motion";
import { animateHorizontalSpring, type HorizontalSpringController } from "./swipe-motion";
import {
  captureTextSelection,
  restoreTextSelection,
  type TextSelectionSnapshot,
} from "./text-selection";

const ARTICLE_SWIPE_TARGETS =
  "a, button, input, select, textarea, summary, video, audio, iframe, pre, .article-table-scroll, [contenteditable], [data-image-lightbox-trigger]";
const ARTICLE_SWIPE_SURFACE = "[data-article-swipe-surface]";
const SWIPE_SAMPLE_WINDOW = 100;
const SWIPE_SAMPLE_LIMIT = 5;
const SWIPE_SPRING_RESPONSE = 0.32;
const SWIPE_SPRING_DAMPING = 1;
const REDUCED_SWIPE_DURATION = 200;

type ArticleNavigationHandler = () => boolean | Promise<boolean>;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function articleImageUrl(value: string): string {
  return value.startsWith("/api/") ? appUrl(value) : value;
}

function surfaceTranslateX(element: HTMLElement): number {
  const transform = window.getComputedStyle(element).transform;
  return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
}

function clearSwipeSurface(element: HTMLElement): void {
  element.style.removeProperty("transform");
  element.style.removeProperty("opacity");
  delete element.dataset.swiping;
}

function formatRelativeDate(value: string | null): string {
  if (!value) return "No date";
  const date = new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of ranges) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return "Just now";
}

function articleDate(article: Article): string {
  return formatRelativeDate(article.publishedAt ?? article.discoveredAt);
}

function articleLabel(article: Article): string {
  return article.title || article.summary || "article";
}

function formatViewCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function mediaTypeLabel(article: Article): string | null {
  if (!article.media) return null;
  return article.media.type === "short" ? "Short" : "Video";
}

function useActionMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusMenuOnOpen = useRef(false);

  const closeMenu = useCallback(() => {
    menuRef.current?.hidePopover();
    triggerRef.current?.focus();
  }, []);

  const handleTriggerPointerDown = useCallback(() => {
    focusMenuOnOpen.current = false;
  }, []);

  const handleTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        return;
      }
      if (["ArrowDown", "Enter", " "].includes(event.key)) {
        focusMenuOnOpen.current = true;
      }
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      menuRef.current?.showPopover();
    },
    [closeMenu, open],
  );

  const handleMenuToggle = useCallback((event: SyntheticEvent<HTMLDivElement>) => {
    const nextOpen = event.currentTarget.matches(":popover-open");
    setOpen(nextOpen);
    if (!nextOpen || !focusMenuOnOpen.current) return;
    window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
  }, []);

  const handleMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      event.stopPropagation();
      handleActionMenuKeyDown(event, closeMenu);
    },
    [closeMenu],
  );

  return {
    closeMenu,
    handleMenuKeyDown,
    handleMenuToggle,
    handleTriggerKeyDown,
    handleTriggerPointerDown,
    menuRef,
    open,
    triggerRef,
  };
}

function LinkifiedText({ text }: { text: string }) {
  const links = extractHttpLinks(text);
  if (links.length === 0) return text;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const link of links) {
    if (link.start > cursor) nodes.push(text.slice(cursor, link.start));
    nodes.push(
      <a
        key={`${link.href}-${link.start}`}
        href={link.href}
        target="_blank"
        rel="noreferrer"
        title={link.href}
      >
        {link.text}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>,
    );
    cursor = link.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function useMarkReadOnScroll({
  articles,
  activeId,
  enabled,
  onMarkPassedRead,
  rootRef,
  useParent = false,
  topAlignedId = null,
}: {
  articles: Article[];
  activeId: number | null;
  enabled: boolean;
  onMarkPassedRead: (articles: Article[]) => Promise<unknown>;
  rootRef: React.RefObject<HTMLElement | null>;
  useParent?: boolean;
  topAlignedId?: number | null;
}) {
  const itemRefs = useRef(new Map<number, HTMLElement>());
  const articlesRef = useRef(articles);
  const enabledRef = useRef(enabled);
  const markPassedRef = useRef(onMarkPassedRead);
  const scrollIntentUntil = useRef(0);
  const lastScrollTop = useRef(0);
  const readRequests = useRef(new Set<number>());
  const queuedReads = useRef(new Map<number, Article>());
  const readTimer = useRef<number | null>(null);
  articlesRef.current = articles;
  enabledRef.current = enabled;
  markPassedRef.current = onMarkPassedRead;

  useEffect(() => {
    const activeItem = activeId === null ? null : itemRefs.current.get(activeId);
    if (!activeItem) return;
    if (!useParent) {
      activeItem.scrollIntoView({ behavior: "auto", block: "nearest" });
      return;
    }
    const root = rootRef.current;
    const container = root?.parentElement;
    if (!container) return;
    const itemRect = activeItem.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    if (activeId === topAlignedId) {
      container.scrollTop += itemRect.top - containerRect.top;
      return;
    }

    const isVisible = itemRect.bottom > containerRect.top && itemRect.top < containerRect.bottom;
    if (isVisible) return;
    if (itemRect.top >= containerRect.bottom && itemRect.height <= containerRect.height) {
      container.scrollTop += itemRect.bottom - containerRect.bottom;
      return;
    }
    container.scrollTop += itemRect.top - containerRect.top;
  }, [activeId, rootRef, topAlignedId, useParent]);

  useEffect(() => {
    const root = rootRef.current;
    const container = useParent ? root?.parentElement : root;
    if (!container) return;
    lastScrollTop.current = container.scrollTop;

    const noteScrollIntent = () => {
      scrollIntentUntil.current = performance.now() + 1500;
    };
    const noteScrollbarIntent = (event: PointerEvent) => {
      if (event.target === container) noteScrollIntent();
    };
    const noteKeyboardScrollIntent = (event: KeyboardEvent) => {
      if (["ArrowDown", "End", "PageDown", " "].includes(event.key)) noteScrollIntent();
    };
    const flushQueuedReads = () => {
      readTimer.current = null;
      if (!enabledRef.current) {
        queuedReads.current.clear();
        return;
      }
      const currentArticles = new Map(articlesRef.current.map((article) => [article.id, article]));
      const batch = [...queuedReads.current.keys()].flatMap((id) => {
        const article = currentArticles.get(id);
        return article && !article.isRead ? [article] : [];
      });
      queuedReads.current.clear();
      if (batch.length === 0) return;
      for (const article of batch) readRequests.current.add(article.id);
      void markPassedRef.current(batch).finally(() => {
        for (const article of batch) readRequests.current.delete(article.id);
      });
    };
    const markPassedItemsRead = () => {
      const scrollingDown = container.scrollTop > lastScrollTop.current + 1;
      lastScrollTop.current = container.scrollTop;
      if (
        !enabledRef.current ||
        !scrollingDown ||
        container.scrollTop <= 0 ||
        performance.now() > scrollIntentUntil.current
      ) {
        return;
      }

      const passedBoundary = container.getBoundingClientRect().top;
      for (const article of articlesRef.current) {
        if (
          article.isRead ||
          queuedReads.current.has(article.id) ||
          readRequests.current.has(article.id)
        ) {
          continue;
        }
        const item = itemRefs.current.get(article.id);
        if (!item || item.getBoundingClientRect().bottom > passedBoundary) continue;
        queuedReads.current.set(article.id, article);
      }

      if (queuedReads.current.size > 0) {
        if (readTimer.current) window.clearTimeout(readTimer.current);
        readTimer.current = window.setTimeout(flushQueuedReads, 250);
      }
    };

    container.addEventListener("wheel", noteScrollIntent, { passive: true });
    container.addEventListener("pointerdown", noteScrollbarIntent, { passive: true });
    container.addEventListener("touchmove", noteScrollIntent, { passive: true });
    container.addEventListener("keydown", noteKeyboardScrollIntent, true);
    container.addEventListener("scroll", markPassedItemsRead, { passive: true });
    return () => {
      container.removeEventListener("wheel", noteScrollIntent);
      container.removeEventListener("pointerdown", noteScrollbarIntent);
      container.removeEventListener("touchmove", noteScrollIntent);
      container.removeEventListener("keydown", noteKeyboardScrollIntent, true);
      container.removeEventListener("scroll", markPassedItemsRead);
      if (readTimer.current) window.clearTimeout(readTimer.current);
      flushQueuedReads();
    };
  }, [rootRef, useParent]);

  return (id: number, element: HTMLElement | null) => {
    if (element) itemRefs.current.set(id, element);
    else itemRefs.current.delete(id);
  };
}

function useExpandedActionDocking(
  streamRef: React.RefObject<HTMLElement | null>,
  articleIds: string,
) {
  useLayoutEffect(() => {
    const stream = streamRef.current;
    const container = stream?.parentElement;
    if (!stream || !container || !articleIds) return;

    const dockingTargets: Array<{ actions: HTMLElement; article: HTMLElement }> = [];
    for (const article of stream.querySelectorAll<HTMLElement>(".expanded-article")) {
      const actions = article.querySelector<HTMLElement>(".expanded-actions");
      if (actions) dockingTargets.push({ actions, article });
    }
    const dockingLead = dockingTargets[0]
      ? Number.parseFloat(
          window.getComputedStyle(dockingTargets[0].article).borderBottomRightRadius,
        )
      : 0;
    const dockedRadius = dockingTargets[0]
      ? Number.parseFloat(window.getComputedStyle(dockingTargets[0].actions).borderTopRightRadius)
      : 0;
    const actionHeight = dockingTargets[0]?.actions.getBoundingClientRect().height ?? 0;
    const currentRadii = new WeakMap<HTMLElement, number>();
    let frameHandle: number | null = null;
    const updateDockingState = () => {
      frameHandle = null;
      const containerTop = container.getBoundingClientRect().top;
      const nextRadii = dockingTargets.map(({ article }) => {
        if (dockingLead === 0) return 0;
        const articleBottom = article.getBoundingClientRect().bottom;
        const progress = Math.min(
          1,
          Math.max(0, (containerTop + actionHeight + dockingLead - articleBottom) / dockingLead),
        );
        return Math.round(dockedRadius * progress * 100) / 100;
      });
      for (const [index, { actions }] of dockingTargets.entries()) {
        const radius = nextRadii[index] ?? 0;
        if (currentRadii.get(actions) === radius) continue;
        currentRadii.set(actions, radius);
        actions.style.borderBottomRightRadius = `${radius}px`;
        actions.style.borderBottomLeftRadius = `${radius}px`;
      }
    };
    const scheduleDockingUpdate = () => {
      if (frameHandle !== null) return;
      frameHandle = window.requestAnimationFrame(updateDockingState);
    };

    updateDockingState();
    container.addEventListener("scroll", scheduleDockingUpdate, { passive: true });
    window.addEventListener("resize", scheduleDockingUpdate);
    return () => {
      container.removeEventListener("scroll", scheduleDockingUpdate);
      window.removeEventListener("resize", scheduleDockingUpdate);
      if (frameHandle !== null) window.cancelAnimationFrame(frameHandle);
      for (const { actions } of dockingTargets) {
        actions.style.removeProperty("border-bottom-right-radius");
        actions.style.removeProperty("border-bottom-left-radius");
      }
    };
  }, [articleIds, streamRef]);
}

function ArticleLoadSentinel({
  rootRef,
  useParent = false,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  useParent?: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = useParent ? rootRef.current?.parentElement : rootRef.current;
    if (!sentinel || !root || !hasMore || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current();
      },
      { root, rootMargin: "0px 0px 400px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, rootRef, useParent]);

  if (!hasMore) return null;
  return (
    <div
      ref={sentinelRef}
      className={`article-load-sentinel${loadingMore ? " is-loading" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy={loadingMore}
    >
      {loadingMore ? (
        <>
          <LoaderCircle className="spin" aria-hidden="true" size={15} />
          <span>Loading more articles</span>
        </>
      ) : null}
    </div>
  );
}

export function AppSkeleton() {
  return (
    <div
      className="app-shell app-loading"
      role="status"
      aria-busy="true"
      aria-label="Loading feedfold"
    >
      <aside className="sidebar skeleton-sidebar">
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line short" />
      </aside>
      <main className="main-column">
        <div className="skeleton-toolbar" />
        <div className="reading-workspace mode-magazine">
          <ArticleListSkeleton mode="magazine" />
        </div>
      </main>
      <span className="sr-only">Loading feeds and articles</span>
    </div>
  );
}

export function StartupError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <main className="startup-state">
      <BrandLogo className="startup-logo" />
      <h1>feedfold is unavailable</h1>
      <p>{message}</p>
      <button className="primary-button" type="button" onClick={retry}>
        <RefreshCw aria-hidden="true" size={16} />
        Try again
      </button>
    </main>
  );
}

export function ArticleListSkeleton({ mode }: { mode: ReadingMode }) {
  if (mode === "expanded") {
    return (
      <div
        className="expanded-stream skeleton-stream"
        role="status"
        aria-busy="true"
        aria-label="Loading articles"
      >
        {[0, 1, 2].map((key) => (
          <div className="expanded-article skeleton-expanded" key={key}>
            <div className="skeleton-line short" />
            <div className="skeleton-line wide" />
            <div className="skeleton-line" />
            <div className="skeleton-block" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      <div
        className="article-list skeleton-list"
        role="status"
        aria-busy="true"
        aria-label="Loading articles"
      >
        {[0, 1, 2, 3, 4, 5].map((key) => (
          <div className="skeleton-list-row" key={key}>
            <div className="skeleton-line short" />
            <div className="skeleton-line wide" />
            <div className="skeleton-line" />
          </div>
        ))}
      </div>
      <div className="reader-pane skeleton-reader">
        <div className="skeleton-line short" />
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <div className="skeleton-block" />
      </div>
    </>
  );
}

export function InlineError({
  title,
  detail,
  retry,
}: {
  title: string;
  detail: string;
  retry: () => void;
}) {
  return (
    <section className="inline-state error-state" role="alert">
      <AlertTriangle aria-hidden="true" size={22} />
      <h2>{title}</h2>
      <p>{detail}</p>
      <button className="secondary-button" type="button" onClick={retry}>
        <RefreshCw aria-hidden="true" size={16} />
        Try again
      </button>
    </section>
  );
}

export function EmptyArticles({
  hasFeeds,
  search,
  state,
  onAddFeed,
  onShowAll,
  onClearSearch,
}: {
  hasFeeds: boolean;
  search: string;
  state: ArticleState;
  onAddFeed: () => void;
  onShowAll: () => void;
  onClearSearch: () => void;
}) {
  if (!hasFeeds) {
    return (
      <section className="inline-state empty-state">
        <Rss aria-hidden="true" size={40} strokeWidth={1.7} />
        <h2>Add your first feed</h2>
        <p>Enter a website or feed URL, or import subscriptions from an OPML file.</p>
        <button className="primary-button" type="button" onClick={onAddFeed}>
          Add a feed
        </button>
      </section>
    );
  }
  if (search) {
    return (
      <section className="inline-state empty-state">
        <SearchX aria-hidden="true" size={40} strokeWidth={1.7} />
        <h2>No articles match “{search}”</h2>
        <p>Use a shorter phrase, or clear the search to show this queue again.</p>
        <button className="secondary-button" type="button" onClick={onClearSearch}>
          Clear search
        </button>
      </section>
    );
  }
  if (state === "unread") {
    return (
      <section className="inline-state empty-state">
        <CheckCheck aria-hidden="true" size={40} strokeWidth={1.7} />
        <h2>No unread articles</h2>
        <p>New articles will appear after the next refresh.</p>
        <button className="secondary-button" type="button" onClick={onShowAll}>
          Show read articles
        </button>
      </section>
    );
  }
  return (
    <section className="inline-state empty-state">
      <Inbox aria-hidden="true" size={40} strokeWidth={1.7} />
      <h2>No articles in this view</h2>
      <p>Choose another feed or article state.</p>
      <button className="secondary-button" type="button" onClick={onShowAll}>
        Show all articles
      </button>
    </section>
  );
}

export function ArticleList({
  articles,
  activeId,
  markReadOnScroll,
  showYouTubeDescriptions,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  onMarkPassedRead,
  onToggleRead,
  onToggleStar,
}: {
  articles: Article[];
  activeId: number | null;
  markReadOnScroll: boolean;
  showYouTubeDescriptions: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (article: Article, openReader?: boolean) => void;
  onMarkPassedRead: (articles: Article[]) => Promise<unknown>;
  onToggleRead: (article: Article) => void;
  onToggleStar: (article: Article) => void;
}) {
  const listRef = useRef<HTMLElement>(null);
  const registerItem = useMarkReadOnScroll({
    articles,
    activeId,
    enabled: markReadOnScroll,
    onMarkPassedRead,
    rootRef: listRef,
  });

  return (
    <section ref={listRef} className="article-list" aria-label="Articles">
      <ol>
        {articles.map((article) => (
          <li
            key={article.id}
            ref={(element) => registerItem(article.id, element)}
            className={`article-list-item${article.id === activeId ? " is-active" : ""}${article.isRead ? " is-read" : ""}`}
          >
            <button
              className="article-open-button"
              type="button"
              aria-current={article.id === activeId ? "true" : undefined}
              onClick={() => onOpen(article)}
            >
              <span className="sr-only">Open {articleLabel(article)}</span>
            </button>
            <div className="article-card-content">
              {article.imageUrl ? (
                <img
                  className="article-card-image"
                  src={articleImageUrl(article.imageUrl)}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span
                  className="article-card-image article-card-image-placeholder"
                  aria-hidden="true"
                >
                  <ArticleThumbnailPlaceholder />
                </span>
              )}
              <span className="article-list-copy">
                <span className="article-list-title">{article.title || article.summary}</span>
                <span className="article-list-meta">
                  <span className="article-feed-identity">
                    <span className="feed-name truncate">{article.feedTitle}</span>
                  </span>
                  {article.media ? (
                    <span className={`article-media-badge ${article.media.type}`}>
                      {mediaTypeLabel(article)}
                    </span>
                  ) : null}
                  <span className="article-meta-divider" aria-hidden="true">
                    ·
                  </span>
                  <time dateTime={article.publishedAt ?? article.discoveredAt}>
                    {articleDate(article)}
                  </time>
                </span>
                {article.title &&
                article.summary &&
                shouldShowArticleDescription(article, showYouTubeDescriptions) ? (
                  <span className="article-list-summary-text">
                    <LinkifiedText text={article.summary} />
                  </span>
                ) : null}
              </span>
            </div>
            <div className="article-card-state-actions">
              <button
                className="list-read-button"
                type="button"
                aria-label={
                  article.isRead
                    ? `Mark ${articleLabel(article)} as unread`
                    : `Mark ${articleLabel(article)} as read`
                }
                title={article.isRead ? "Mark as unread" : "Mark as read"}
                onClick={() => onToggleRead(article)}
              >
                {article.isRead ? (
                  <CheckCircle2 aria-hidden="true" size={15} />
                ) : (
                  <Circle aria-hidden="true" size={15} />
                )}
              </button>
              <button
                className={`list-star-button${article.isStarred ? " is-starred" : ""}`}
                type="button"
                aria-label={
                  article.isStarred
                    ? `Remove ${articleLabel(article)} from Saved`
                    : `Save ${articleLabel(article)}`
                }
                title={article.isStarred ? "Remove from Saved" : "Save"}
                aria-pressed={article.isStarred}
                onClick={() => onToggleStar(article)}
              >
                <Star
                  aria-hidden="true"
                  size={15}
                  fill={article.isStarred ? "currentColor" : "none"}
                />
              </button>
            </div>
          </li>
        ))}
      </ol>
      <ArticleLoadSentinel
        rootRef={listRef}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
      />
      {!hasMore ? (
        <div className="article-list-end" role="status">
          No more articles here
        </div>
      ) : null}
    </section>
  );
}

export interface ArticleSummaryViewState {
  visible: boolean;
  loading: boolean;
  error: string | null;
  configurationMissing: boolean;
  promptId: string | null;
}

export const EMPTY_ARTICLE_SUMMARY_STATE: ArticleSummaryViewState = {
  visible: false,
  loading: false,
  error: null,
  configurationMissing: false,
  promptId: null,
};

export interface ArticleTranslationViewState {
  visible: boolean;
  loading: boolean;
  error: string | null;
  configurationMissing: boolean;
  translation: ArticleAiTranslation | null;
}

export const EMPTY_ARTICLE_TRANSLATION_STATE: ArticleTranslationViewState = {
  visible: false,
  loading: false,
  error: null,
  configurationMissing: false,
  translation: null,
};

interface ArticleActionsProps {
  article: Article;
  fullContentVisible: boolean;
  summaryState: ArticleSummaryViewState;
  translationState: ArticleTranslationViewState;
  translationLanguage: string;
  customPrompts: AiCustomPrompt[];
  onPrevious?: () => void;
  onNext?: () => void;
  canPrevious?: boolean;
  canNext?: boolean;
  navigationPending?: boolean;
  onToggleRead: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onOpenSource: (article: Article) => void;
  onToggleFullContent: (article: Article) => void;
  onRunSummaryPrompt: (article: Article, promptId: string | null) => void;
  onToggleTranslation: (article: Article) => void;
}

function ArticleActions({
  article,
  fullContentVisible,
  summaryState,
  translationState,
  translationLanguage,
  customPrompts,
  onPrevious,
  onNext,
  canPrevious = true,
  canNext = true,
  navigationPending = false,
  onToggleRead,
  onToggleStar,
  onCopy,
  onOpenSource,
  onToggleFullContent,
  onRunSummaryPrompt,
  onToggleTranslation,
}: ArticleActionsProps) {
  const summaryMenu = useActionMenu();
  const moreMenu = useActionMenu();
  const summaryMenuId = `article-${article.id}-summary-menu`;
  const summaryAnchorName = `--article-${article.id}-summary`;
  const moreMenuId = `article-${article.id}-more-menu`;
  const moreAnchorName = `--article-${article.id}-more`;
  const fullContentAvailable = Boolean(article.url) && !article.media;
  const cachedFullContent = article.extractionStatus === "complete" && Boolean(article.contentHtml);
  const fullContentLoading =
    fullContentVisible &&
    (article.extractionStatus === "pending" || article.extractionStatus === "processing");
  const fullContentLoaded = fullContentVisible && cachedFullContent;
  const fullContentFailed = fullContentVisible && article.extractionStatus === "failed";
  const fullContentLabel = fullContentLoading
    ? "Loading the full article"
    : fullContentLoaded
      ? "Show feed text"
      : fullContentFailed
        ? "Retry full article"
        : cachedFullContent
          ? "Show full article"
          : "Load full article";
  const FullContentIcon = fullContentLoading
    ? LoaderCircle
    : fullContentLoaded
      ? Rss
      : fullContentFailed
        ? RefreshCw
        : cachedFullContent
          ? FileText
          : Download;
  const translationLabel = translationState.loading
    ? `Translating to ${translationLanguage}`
    : translationState.visible
      ? "Show original article"
      : translationState.error
        ? `Retry ${translationLanguage} translation`
        : `Translate to ${translationLanguage}`;
  const readTooltip = article.isRead ? "Mark as unread (U)" : "Mark as read (U)";
  const savedTooltip = article.isStarred ? "Remove from Saved (S)" : "Save article (S)";
  return (
    <div className="article-actions" role="toolbar" aria-label="Article actions">
      {onPrevious ? (
        <button
          className="article-navigation-action"
          type="button"
          disabled={!canPrevious || navigationPending}
          onClick={onPrevious}
          aria-label="Previous article (K)"
          data-tooltip="Previous article (K)"
        >
          <ArrowLeft aria-hidden="true" size={16} />
        </button>
      ) : null}
      {onNext ? (
        <button
          className="article-navigation-action"
          type="button"
          disabled={!canNext || navigationPending}
          onClick={onNext}
          aria-label="Next article (J)"
          data-tooltip="Next article (J)"
        >
          <ArrowRight aria-hidden="true" size={16} />
        </button>
      ) : null}
      <span className="action-divider" aria-hidden="true" />
      {fullContentAvailable ? (
        <button
          className="full-content-action"
          type="button"
          disabled={fullContentLoading}
          aria-pressed={fullContentLoaded}
          onClick={() => onToggleFullContent(article)}
          aria-label={`${fullContentLabel} (W)`}
          data-tooltip={`${fullContentLabel} (W)`}
        >
          <FullContentIcon
            className={fullContentLoading ? "spin" : undefined}
            aria-hidden="true"
            size={16}
          />
        </button>
      ) : null}
      <button
        ref={summaryMenu.triggerRef}
        className="summary-action"
        type="button"
        disabled={summaryState.loading}
        aria-haspopup="menu"
        aria-expanded={summaryMenu.open}
        aria-pressed={summaryState.visible}
        aria-controls={summaryMenuId}
        popoverTarget={summaryMenuId}
        style={{ anchorName: summaryAnchorName }}
        onPointerDown={summaryMenu.handleTriggerPointerDown}
        onKeyDown={summaryMenu.handleTriggerKeyDown}
        aria-label="Choose an AI action"
        data-tooltip="Choose an AI action"
      >
        {summaryState.loading ? (
          <LoaderCircle className="spin" aria-hidden="true" size={16} />
        ) : summaryState.error && !summaryState.visible ? (
          <RefreshCw aria-hidden="true" size={16} />
        ) : (
          <Sparkles
            aria-hidden="true"
            size={16}
            fill={summaryState.visible ? "currentColor" : "none"}
          />
        )}
        <ChevronDown className="summary-action-chevron" aria-hidden="true" size={10} />
      </button>
      <div
        ref={summaryMenu.menuRef}
        id={summaryMenuId}
        className="summary-prompt-menu context-action-menu"
        popover="auto"
        role="menu"
        aria-label="AI actions"
        style={{ positionAnchor: summaryAnchorName }}
        onToggle={summaryMenu.handleMenuToggle}
        onKeyDown={summaryMenu.handleMenuKeyDown}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            summaryMenu.closeMenu();
            onRunSummaryPrompt(article, null);
          }}
        >
          <Sparkles aria-hidden="true" size={15} />
          <span>Summarize</span>
          <kbd>M</kbd>
        </button>
        {customPrompts.length > 0 ? <hr className="context-menu-separator" /> : null}
        {customPrompts.map((prompt) => (
          <button
            key={prompt.id}
            type="button"
            role="menuitem"
            onClick={() => {
              summaryMenu.closeMenu();
              onRunSummaryPrompt(article, prompt.id);
            }}
          >
            <MessageSquareText aria-hidden="true" size={15} />
            <span>{prompt.name}</span>
          </button>
        ))}
      </div>
      <button
        className="translation-action"
        type="button"
        disabled={translationState.loading}
        aria-pressed={translationState.visible}
        onClick={() => onToggleTranslation(article)}
        aria-label={`${translationLabel} (T)`}
        data-tooltip={`${translationLabel} (T)`}
      >
        {translationState.loading ? (
          <LoaderCircle className="spin" aria-hidden="true" size={16} />
        ) : translationState.visible ? (
          <BookOpenText aria-hidden="true" size={16} />
        ) : (
          <Languages aria-hidden="true" size={16} />
        )}
      </button>
      <span className="action-divider" aria-hidden="true" />
      <button
        className="read-state-action"
        type="button"
        aria-label={readTooltip}
        aria-pressed={article.isRead}
        onClick={() => onToggleRead(article)}
        data-tooltip={readTooltip}
      >
        {article.isRead ? (
          <MailOpen aria-hidden="true" size={16} />
        ) : (
          <Mail aria-hidden="true" size={16} />
        )}
      </button>
      <button
        className={`star-state-action${article.isStarred ? " is-starred" : ""}`}
        type="button"
        aria-pressed={article.isStarred}
        onClick={() => onToggleStar(article)}
        aria-label={savedTooltip}
        data-tooltip={savedTooltip}
      >
        <Star aria-hidden="true" size={16} fill={article.isStarred ? "currentColor" : "none"} />
      </button>
      <button
        className="copy-action"
        type="button"
        onClick={() => onCopy(article)}
        aria-label="Copy article link (C)"
        data-tooltip="Copy article link (C)"
      >
        <Copy aria-hidden="true" size={16} />
      </button>
      <button
        className="open-source-action"
        type="button"
        onClick={() => onOpenSource(article)}
        aria-label="Open article source (O)"
        data-tooltip="Open article source (O)"
      >
        <ExternalLink aria-hidden="true" size={16} />
      </button>
      <button
        ref={moreMenu.triggerRef}
        className="article-more-action"
        type="button"
        aria-label="More article actions"
        aria-haspopup="menu"
        aria-expanded={moreMenu.open}
        aria-controls={moreMenuId}
        popoverTarget={moreMenuId}
        style={{ anchorName: moreAnchorName }}
        onPointerDown={moreMenu.handleTriggerPointerDown}
        onKeyDown={moreMenu.handleTriggerKeyDown}
        data-tooltip="More article actions"
      >
        <Ellipsis aria-hidden="true" size={18} />
      </button>
      <div
        ref={moreMenu.menuRef}
        id={moreMenuId}
        className="article-more-menu context-action-menu"
        popover="auto"
        role="menu"
        aria-label="More article actions"
        style={{ positionAnchor: moreAnchorName }}
        onToggle={moreMenu.handleMenuToggle}
        onKeyDown={moreMenu.handleMenuKeyDown}
      >
        {fullContentAvailable ? (
          <>
            <button
              type="button"
              role="menuitem"
              disabled={fullContentLoading}
              onClick={() => {
                moreMenu.closeMenu();
                onToggleFullContent(article);
              }}
            >
              <FullContentIcon
                className={fullContentLoading ? "spin" : undefined}
                aria-hidden="true"
                size={15}
              />
              <span>{fullContentLabel}</span>
              <kbd>W</kbd>
            </button>
            <hr className="context-menu-separator" />
          </>
        ) : null}
        <button
          type="button"
          role="menuitem"
          disabled={translationState.loading}
          onClick={() => {
            moreMenu.closeMenu();
            onToggleTranslation(article);
          }}
        >
          {translationState.loading ? (
            <LoaderCircle className="spin" aria-hidden="true" size={15} />
          ) : translationState.visible ? (
            <BookOpenText aria-hidden="true" size={15} />
          ) : (
            <Languages aria-hidden="true" size={15} />
          )}
          <span>{translationLabel}</span>
          <kbd>T</kbd>
        </button>
        <hr className="context-menu-separator" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            moreMenu.closeMenu();
            onToggleRead(article);
          }}
        >
          {article.isRead ? (
            <Mail aria-hidden="true" size={15} />
          ) : (
            <MailOpen aria-hidden="true" size={15} />
          )}
          <span>{article.isRead ? "Mark as unread" : "Mark as read"}</span>
          <kbd>U</kbd>
        </button>
        <hr className="context-menu-separator" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            moreMenu.closeMenu();
            onCopy(article);
          }}
        >
          <Copy aria-hidden="true" size={15} />
          <span>Copy article link</span>
          <kbd>C</kbd>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            moreMenu.closeMenu();
            onOpenSource(article);
          }}
        >
          <ExternalLink aria-hidden="true" size={15} />
          <span>Open article source</span>
          <kbd>O</kbd>
        </button>
      </div>
    </div>
  );
}

function ArticleSummaryPanel({
  article,
  state,
  customPrompts,
  onRegenerate,
  onOpenSettings,
}: {
  article: Article;
  state: ArticleSummaryViewState;
  customPrompts: AiCustomPrompt[];
  onRegenerate: (article: Article) => void;
  onOpenSettings: () => void;
}) {
  const summaryPresence = useMotionPresence(state.visible);
  const retainedState = useRef(state);
  if (state.visible) retainedState.current = state;
  const displayedState = state.visible ? state : retainedState.current;
  if (!summaryPresence.present) return null;
  const summary = article.aiSummary;
  const titleId = `article-${article.id}-ai-summary-title`;
  const displayedPromptId = summary ? summary.promptId : displayedState.promptId;
  const customPromptName = displayedPromptId
    ? customPrompts.find((prompt) => prompt.id === displayedPromptId)?.name
    : null;

  return (
    <section
      id={`article-${article.id}-ai-summary`}
      className="article-ai-summary"
      data-motion-state={summaryPresence.state}
      inert={summaryPresence.state === "closed" ? true : undefined}
      aria-labelledby={titleId}
      aria-hidden={summaryPresence.state === "closed"}
      aria-live="polite"
      aria-busy={displayedState.loading}
    >
      <div className="article-ai-summary-heading">
        <div>
          <Sparkles aria-hidden="true" size={17} />
          <h3 id={titleId}>{customPromptName ?? "Summary"}</h3>
        </div>
        {summary ? (
          <button
            className="quiet-button article-summary-regenerate"
            type="button"
            disabled={displayedState.loading}
            onClick={() => onRegenerate(article)}
          >
            {displayedState.loading ? (
              <LoaderCircle className="spin" aria-hidden="true" size={14} />
            ) : (
              <RefreshCw aria-hidden="true" size={14} />
            )}
            {displayedState.loading ? "Updating summary" : "Update summary"}
          </button>
        ) : null}
      </div>

      {displayedState.loading && !summary ? (
        <div className="article-summary-loading" role="status">
          <span>Generating summary</span>
          <div className="article-summary-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </div>
      ) : displayedState.configurationMissing ? (
        <div className="article-summary-message">
          <strong>Set up summaries first</strong>
          <p>In Settings, choose an AI provider and save its API key.</p>
          <button className="secondary-button" type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      ) : summary ? (
        <div className="article-summary-text">
          <AiMarkdown text={summary.text} grounding={summary.grounding} />
        </div>
      ) : !displayedState.error ? (
        <div className="article-summary-message">
          <strong>This summary is out of date</strong>
          <p>The article text has changed. Create a summary from the current text.</p>
          <button className="secondary-button" type="button" onClick={() => onRegenerate(article)}>
            <Sparkles aria-hidden="true" size={14} />
            Update summary
          </button>
        </div>
      ) : null}

      {displayedState.error ? (
        <div className="article-summary-error" role="alert">
          <AlertTriangle aria-hidden="true" size={16} />
          <div>
            <strong>Could not create the summary</strong>
            <p>{displayedState.error}</p>
          </div>
          {!summary ? (
            <button
              className="secondary-button"
              type="button"
              disabled={displayedState.loading}
              onClick={() => onRegenerate(article)}
            >
              <RefreshCw aria-hidden="true" size={14} />
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ArticleTranslationNotice({
  state,
  language,
  onOpenSettings,
}: {
  state: ArticleTranslationViewState;
  language: string;
  onOpenSettings: () => void;
}) {
  if (state.visible || (!state.loading && !state.configurationMissing && !state.error)) return null;
  if (state.loading) {
    return (
      <div className="article-extraction-state article-translation-state" role="status">
        <LoaderCircle className="spin" aria-hidden="true" size={18} />
        <div>
          <strong>Translating to {language}</strong>
          <p>You can keep reading the original until the translation is ready.</p>
        </div>
      </div>
    );
  }
  if (state.configurationMissing) {
    return (
      <div className="article-extraction-state article-translation-state" role="note">
        <Languages aria-hidden="true" size={18} />
        <div>
          <strong>Set up translations first</strong>
          <p>In Settings, choose an AI provider and save its API key.</p>
          <button className="secondary-button" type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="article-extraction-state article-translation-state extraction-failed"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" size={18} />
      <div>
        <strong>Could not translate the article</strong>
        <p>{state.error}</p>
      </div>
    </div>
  );
}

interface SelectionMenuState {
  text: string;
  selection: TextSelectionSnapshot;
  left: number;
  top: number;
  placement: "above" | "below";
}

function ArticleDocument({
  article,
  titleId,
  fullContentVisible,
  summaryState,
  translationState,
  translationLanguage,
  customPrompts,
  showYouTubeDescriptions,
  onFeedAction,
  onToggleFullContent,
  onRegenerateSummary,
  onOpenAiSettings,
  onFilterSelection,
}: {
  article: Article;
  titleId: string;
  fullContentVisible: boolean;
  summaryState: ArticleSummaryViewState;
  translationState: ArticleTranslationViewState;
  translationLanguage: string;
  customPrompts: AiCustomPrompt[];
  showYouTubeDescriptions: boolean;
  onFeedAction: (feedId: number, action: FeedManagementAction) => void;
  onToggleFullContent: (article: Article) => void;
  onRegenerateSummary: (article: Article) => void;
  onOpenAiSettings: () => void;
  onFilterSelection: (article: Article, text: string) => void;
}) {
  const documentRef = useRef<HTMLDivElement>(null);
  const readingFlowRef = useRef<HTMLDivElement>(null);
  const readingFlowTop = useRef<number | null>(null);
  const readingFlowAnimation = useRef<Animation | null>(null);
  const previousSummaryVisibility = useRef(summaryState.visible);
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const selectionMenuPresence = useMotionPresence(selectionMenu !== null);
  const retainedSelectionMenu = useRef<SelectionMenuState | null>(selectionMenu);
  if (selectionMenu) retainedSelectionMenu.current = selectionMenu;
  const displayedSelectionMenu = selectionMenu ?? retainedSelectionMenu.current;

  useLayoutEffect(() => {
    const flow = readingFlowRef.current;
    if (!flow) return;
    const visibilityChanged = previousSummaryVisibility.current !== summaryState.visible;
    previousSummaryVisibility.current = summaryState.visible;
    const nextTop = flow.getBoundingClientRect().top;
    const previousTop = readingFlowTop.current;
    readingFlowTop.current = nextTop;
    if (!visibilityChanged) return;
    readingFlowAnimation.current?.cancel();
    readingFlowAnimation.current = null;
    if (previousTop === null) return;

    const delta = previousTop - nextTop;
    const styles = window.getComputedStyle(document.documentElement);
    const duration = Number.parseFloat(styles.getPropertyValue("--duration-surface"));
    if (
      Math.abs(delta) < 0.5 ||
      duration === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const animation = flow.animate(
      [{ transform: `translate3d(0, ${delta}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
      {
        duration,
        easing: styles.getPropertyValue("--ease-in-out").trim(),
      },
    );
    readingFlowAnimation.current = animation;
    animation.onfinish = () => {
      if (readingFlowAnimation.current === animation) readingFlowAnimation.current = null;
    };
  }, [summaryState.visible]);

  useEffect(
    () => () => {
      readingFlowAnimation.current?.cancel();
    },
    [],
  );

  const showSelectionMenu = useCallback(() => {
    const root = documentRef.current;
    const selection = window.getSelection();
    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !root.contains(selection.anchorNode) ||
      !root.contains(selection.focusNode)
    ) {
      setSelectionMenu(null);
      return;
    }

    const selectionSnapshot = captureTextSelection(root, selection);
    const text = selectionSnapshot?.text.replace(/\s+/g, " ").trim() ?? "";
    const bounds = selection.getRangeAt(0).getBoundingClientRect();
    if (!selectionSnapshot || !text || (bounds.width === 0 && bounds.height === 0)) {
      setSelectionMenu(null);
      return;
    }

    const placement = bounds.top < 56 ? "below" : "above";
    setSelectionMenu({
      text,
      selection: selectionSnapshot,
      left: Math.min(window.innerWidth - 52, Math.max(52, bounds.left + bounds.width / 2)),
      top: placement === "above" ? bounds.top : bounds.bottom,
      placement,
    });
  }, []);

  useEffect(() => {
    const root = documentRef.current;
    if (!root) return;

    const dismiss = () => setSelectionMenu(null);
    root.addEventListener("pointerdown", dismiss);
    root.addEventListener("pointerup", showSelectionMenu);
    root.addEventListener("keyup", showSelectionMenu);
    return () => {
      root.removeEventListener("pointerdown", dismiss);
      root.removeEventListener("pointerup", showSelectionMenu);
      root.removeEventListener("keyup", showSelectionMenu);
    };
  }, [showSelectionMenu]);

  useLayoutEffect(() => {
    const root = documentRef.current;
    if (!root || !selectionMenu) return;
    restoreTextSelection(root, selectionMenu.selection);
  }, [selectionMenu]);

  useEffect(() => {
    if (!selectionMenu) return;

    const dismiss = () => setSelectionMenu(null);
    const dismissOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      dismiss();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      window.getSelection()?.removeAllRanges();
      dismiss();
    };

    document.addEventListener("pointerdown", dismissOnPointerDown, true);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown, true);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [selectionMenu]);

  return (
    <>
      <div ref={documentRef} className="article-document">
        <ArticleHeader article={article} id={titleId} onFeedAction={onFeedAction} />
        <div className="article-document-flow">
          <ArticleSummaryPanel
            article={article}
            state={summaryState}
            customPrompts={customPrompts}
            onRegenerate={onRegenerateSummary}
            onOpenSettings={onOpenAiSettings}
          />
          <div ref={readingFlowRef} className="article-reading-flow">
            <ArticleTranslationNotice
              state={translationState}
              language={translationLanguage}
              onOpenSettings={onOpenAiSettings}
            />
            <ArticleBody
              article={article}
              fullContentVisible={fullContentVisible}
              translationState={translationState}
              showYouTubeDescriptions={showYouTubeDescriptions}
              onToggleFullContent={onToggleFullContent}
            />
          </div>
        </div>
      </div>
      {selectionMenuPresence.present && displayedSelectionMenu
        ? createPortal(
            <div
              ref={menuRef}
              className="article-selection-menu"
              role="menu"
              aria-label="Selected text actions"
              data-placement={displayedSelectionMenu.placement}
              data-state={selectionMenuPresence.state}
              inert={selectionMenuPresence.state === "closed"}
              style={{ left: displayedSelectionMenu.left, top: displayedSelectionMenu.top }}
            >
              <button
                type="button"
                role="menuitem"
                aria-label="Filter selected text"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  const { text } = displayedSelectionMenu;
                  setSelectionMenu(null);
                  onFilterSelection(article, text);
                }}
              >
                <ListFilter aria-hidden="true" size={15} />
                Filter
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

interface ArticleSurfaceSnapshot {
  article: Article;
  fullContentVisible: boolean;
  summaryState: ArticleSummaryViewState;
  translationState: ArticleTranslationViewState;
}

interface PointerSample {
  x: number;
  timeStamp: number;
}

interface SwipeGestureState {
  pointerId: number;
  x: number;
  y: number;
  surfaceX: number;
  surfaceOpacity: number;
  reducedMotion: boolean;
  intent: ArticleSwipeIntent;
  startedOnSwipeSurface: boolean;
  samples: PointerSample[];
}

interface FullContentPullGesture {
  identifier: number;
  articleId: number;
  startX: number;
  startY: number;
}

interface PendingArticleNavigation {
  readonly id: number;
  readonly direction: ArticleSwipeDirection;
  readonly releaseVelocity: number;
  readonly reducedMotion: boolean;
  readonly restoreFrameHandle: number;
}

interface OutgoingArticleSurface {
  snapshot: ArticleSurfaceSnapshot;
  requestId: number;
}

interface ArticleTransitionSetup {
  requestId: number;
  direction: ArticleSwipeDirection;
  startX: number;
  startOpacity: number;
  releaseVelocity: number;
  reducedMotion: boolean;
}

function appendPointerSample(samples: PointerSample[], sample: PointerSample): PointerSample[] {
  return [...samples, sample]
    .filter((entry) => sample.timeStamp - entry.timeStamp <= SWIPE_SAMPLE_WINDOW)
    .slice(-SWIPE_SAMPLE_LIMIT);
}

function horizontalReleaseVelocity(samples: PointerSample[]): number {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.timeStamp <= first.timeStamp) return 0;
  return (last.x - first.x) / (last.timeStamp - first.timeStamp);
}

export function ReaderPane({
  article,
  fullContentVisible,
  summaryState,
  translationState,
  translationLanguage,
  customPrompts,
  showYouTubeDescriptions,
  canPrevious,
  canNext,
  onBack,
  onPrevious,
  onNext,
  onToggleRead,
  onToggleStar,
  onCopy,
  onOpenSource,
  onFeedAction,
  onToggleFullContent,
  onRunSummaryPrompt,
  onToggleTranslation,
  onRegenerateSummary,
  onOpenAiSettings,
  onFilterSelection,
}: {
  article: Article | null;
  fullContentVisible: boolean;
  summaryState: ArticleSummaryViewState;
  translationState: ArticleTranslationViewState;
  translationLanguage: string;
  customPrompts: AiCustomPrompt[];
  showYouTubeDescriptions: boolean;
  canPrevious: boolean;
  canNext: boolean;
  onBack: () => void;
  onPrevious: ArticleNavigationHandler;
  onNext: ArticleNavigationHandler;
  onToggleRead: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onOpenSource: (article: Article) => void;
  onFeedAction: (feedId: number, action: FeedManagementAction) => void;
  onToggleFullContent: (article: Article) => void;
  onRunSummaryPrompt: (article: Article, promptId: string | null) => void;
  onToggleTranslation: (article: Article) => void;
  onRegenerateSummary: (article: Article) => void;
  onOpenAiSettings: () => void;
  onFilterSelection: (article: Article, text: string) => void;
}) {
  const initialSurface = article
    ? { article, fullContentVisible, summaryState, translationState }
    : null;
  const [activeSurface, setActiveSurface] = useState<ArticleSurfaceSnapshot | null>(initialSurface);
  const [outgoingSurface, setOutgoingSurface] = useState<OutgoingArticleSurface | null>(null);
  const [navigationPending, setNavigationPending] = useState(false);
  const activeLayerRef = useRef<HTMLDivElement>(null);
  const outgoingLayerRef = useRef<HTMLDivElement>(null);
  const activeSurfaceRef = useRef(activeSurface);
  const outgoingSurfaceRef = useRef(outgoingSurface);
  const activeMotion = useRef<HorizontalSpringController | null>(null);
  const swipeStart = useRef<SwipeGestureState | null>(null);
  const fullContentPullStart = useRef<FullContentPullGesture | null>(null);
  const suppressSwipeSurfaceClick = useRef(false);
  const pendingNavigation = useRef<PendingArticleNavigation | null>(null);
  const nextRequestId = useRef(0);
  const propArticleId = useRef(article?.id ?? null);
  const paginationRestoreRequestId = useRef<number | null>(null);
  const transitionSetup = useRef<ArticleTransitionSetup | null>(null);
  activeSurfaceRef.current = activeSurface;
  outgoingSurfaceRef.current = outgoingSurface;
  propArticleId.current = article?.id ?? null;

  const preserveActivePresentation = useCallback(() => {
    const surface = activeLayerRef.current;
    if (!surface) return { position: 0, opacity: 1 };
    const position = surfaceTranslateX(surface);
    const opacity = Number(window.getComputedStyle(surface).opacity);
    activeMotion.current?.cancel();
    activeMotion.current = null;
    surface.style.transform = `translate3d(${position}px, 0, 0)`;
    surface.style.opacity = String(opacity);
    surface.dataset.swiping = "true";
    return { position, opacity };
  }, []);

  const restoreActiveSurface = useCallback(
    (releaseVelocity = 0, reducedMotion = prefersReducedMotion()) => {
      const surface = activeLayerRef.current;
      if (!surface) return;
      const { position, opacity } = preserveActivePresentation();
      transitionSetup.current = null;
      if (outgoingSurfaceRef.current) {
        outgoingSurfaceRef.current = null;
        setOutgoingSurface(null);
      }

      if (reducedMotion) {
        const animation = surface.animate([{ opacity }, { opacity: 1 }], {
          duration: REDUCED_SWIPE_DURATION,
          easing: "ease",
          fill: "forwards",
        });
        const controller: HorizontalSpringController = {
          cancel: () => animation.cancel(),
        };
        activeMotion.current = controller;
        animation.onfinish = () => {
          if (activeMotion.current !== controller) return;
          animation.cancel();
          activeMotion.current = null;
          clearSwipeSurface(surface);
        };
        return;
      }

      let controller: HorizontalSpringController;
      controller = animateHorizontalSpring({
        initialPosition: position,
        initialVelocity: releaseVelocity,
        target: 0,
        damping: SWIPE_SPRING_DAMPING,
        response: SWIPE_SPRING_RESPONSE,
        onUpdate: ({ position: nextPosition, progress }) => {
          surface.style.transform = `translate3d(${nextPosition}px, 0, 0)`;
          surface.style.opacity = String(opacity + (1 - opacity) * progress);
        },
        onComplete: () => {
          if (activeMotion.current !== controller) return;
          activeMotion.current = null;
          clearSwipeSurface(surface);
        },
      });
      activeMotion.current = controller;
    },
    [preserveActivePresentation],
  );

  const navigateWithAnimation = useCallback(
    (
      direction: ArticleSwipeDirection,
      releaseVelocity = 0,
      reducedMotion = prefersReducedMotion(),
    ) => {
      const directionAvailable = direction === "next" ? canNext : canPrevious;
      if (!directionAvailable) {
        restoreActiveSurface(0, reducedMotion);
        return;
      }
      if (pendingNavigation.current) {
        restoreActiveSurface(releaseVelocity, reducedMotion);
        return;
      }

      const navigate = direction === "next" ? onNext : onPrevious;
      if (interactionMotionIsInstant()) {
        void navigate();
        return;
      }
      if (!activeLayerRef.current) {
        void navigate();
        return;
      }

      const requestId = ++nextRequestId.current;
      const restoreFrameHandle = window.requestAnimationFrame(() => {
        const request = pendingNavigation.current;
        if (request?.id !== requestId) return;
        if (propArticleId.current !== activeSurfaceRef.current?.article.id) return;
        paginationRestoreRequestId.current = requestId;
        restoreActiveSurface(request.releaseVelocity, request.reducedMotion);
      });
      const request = Object.freeze({
        id: requestId,
        direction,
        releaseVelocity,
        reducedMotion,
        restoreFrameHandle,
      });
      pendingNavigation.current = request;
      setNavigationPending(true);
      const navigationResult = navigate();
      void Promise.resolve(navigationResult).then((moved) => {
        if (pendingNavigation.current?.id !== requestId || moved) return;
        pendingNavigation.current = null;
        setNavigationPending(false);
        window.cancelAnimationFrame(restoreFrameHandle);
        const alreadyRestoring = paginationRestoreRequestId.current === requestId;
        paginationRestoreRequestId.current = null;
        if (!alreadyRestoring) restoreActiveSurface(releaseVelocity, reducedMotion);
      });
    },
    [canNext, canPrevious, onNext, onPrevious, restoreActiveSurface],
  );

  useLayoutEffect(() => {
    const nextSurface = article
      ? { article, fullContentVisible, summaryState, translationState }
      : null;
    const currentSurface = activeSurfaceRef.current;
    if (nextSurface?.article.id === currentSurface?.article.id) {
      if (
        nextSurface &&
        (nextSurface.article !== currentSurface?.article ||
          nextSurface.fullContentVisible !== currentSurface.fullContentVisible ||
          nextSurface.summaryState !== currentSurface.summaryState ||
          nextSurface.translationState !== currentSurface.translationState)
      ) {
        activeSurfaceRef.current = nextSurface;
        setActiveSurface(nextSurface);
      }
      return;
    }

    if (!nextSurface || !currentSurface) {
      activeMotion.current?.cancel();
      activeMotion.current = null;
      const request = pendingNavigation.current;
      if (request) window.cancelAnimationFrame(request.restoreFrameHandle);
      pendingNavigation.current = null;
      setNavigationPending(false);
      paginationRestoreRequestId.current = null;
      transitionSetup.current = null;
      outgoingSurfaceRef.current = null;
      activeSurfaceRef.current = nextSurface;
      setOutgoingSurface(null);
      setActiveSurface(nextSurface);
      return;
    }

    const request = pendingNavigation.current;
    if (!request) {
      activeMotion.current?.cancel();
      activeMotion.current = null;
      setNavigationPending(false);
      paginationRestoreRequestId.current = null;
      transitionSetup.current = null;
      outgoingSurfaceRef.current = null;
      activeSurfaceRef.current = nextSurface;
      setOutgoingSurface(null);
      setActiveSurface(nextSurface);
      return;
    }

    const { position, opacity } = preserveActivePresentation();
    window.cancelAnimationFrame(request.restoreFrameHandle);
    pendingNavigation.current = null;
    setNavigationPending(false);
    const wasRestoringPagination = paginationRestoreRequestId.current === request.id;
    paginationRestoreRequestId.current = null;
    transitionSetup.current = {
      requestId: request.id,
      direction: request.direction,
      startX: position,
      startOpacity: opacity,
      releaseVelocity: wasRestoringPagination ? 0 : request.releaseVelocity,
      reducedMotion: request.reducedMotion,
    };
    const nextOutgoingSurface = { snapshot: currentSurface, requestId: request.id };
    outgoingSurfaceRef.current = nextOutgoingSurface;
    activeSurfaceRef.current = nextSurface;
    setOutgoingSurface(nextOutgoingSurface);
    setActiveSurface(nextSurface);
  }, [article, fullContentVisible, preserveActivePresentation, summaryState, translationState]);

  useLayoutEffect(() => {
    const setup = transitionSetup.current;
    const outgoing = outgoingLayerRef.current;
    const incoming = activeLayerRef.current;
    if (!setup || !outgoing || !incoming || outgoingSurface?.requestId !== setup.requestId) return;
    transitionSetup.current = null;
    const width = outgoing.getBoundingClientRect().width;
    const targetX = setup.direction === "next" ? -width : width;
    const incomingStartX = setup.startX - targetX;
    outgoing.dataset.swiping = "true";
    incoming.dataset.swiping = "true";

    const complete = (controller: HorizontalSpringController) => {
      if (activeMotion.current !== controller) return;
      activeMotion.current = null;
      clearSwipeSurface(incoming);
      clearSwipeSurface(outgoing);
      outgoingSurfaceRef.current = null;
      setOutgoingSurface(null);
    };

    if (setup.reducedMotion) {
      outgoing.style.removeProperty("transform");
      incoming.style.removeProperty("transform");
      outgoing.style.opacity = String(setup.startOpacity);
      incoming.style.opacity = "0.65";
      const outgoingAnimation = outgoing.animate(
        [{ opacity: setup.startOpacity }, { opacity: 0.35 }],
        { duration: REDUCED_SWIPE_DURATION, easing: "ease", fill: "forwards" },
      );
      const incomingAnimation = incoming.animate([{ opacity: 0.65 }, { opacity: 1 }], {
        duration: REDUCED_SWIPE_DURATION,
        easing: "ease",
        fill: "forwards",
      });
      const controller: HorizontalSpringController = {
        cancel: () => {
          outgoingAnimation.cancel();
          incomingAnimation.cancel();
        },
      };
      activeMotion.current = controller;
      incomingAnimation.onfinish = () => {
        if (activeMotion.current !== controller) return;
        outgoingAnimation.cancel();
        incomingAnimation.cancel();
        complete(controller);
      };
      return;
    }

    outgoing.style.transform = `translate3d(${setup.startX}px, 0, 0)`;
    outgoing.style.opacity = String(setup.startOpacity);
    incoming.style.transform = `translate3d(${incomingStartX}px, 0, 0)`;
    incoming.style.opacity = "0.65";
    let controller: HorizontalSpringController;
    controller = animateHorizontalSpring({
      initialPosition: setup.startX,
      initialVelocity: setup.releaseVelocity,
      target: targetX,
      damping: SWIPE_SPRING_DAMPING,
      response: SWIPE_SPRING_RESPONSE,
      onUpdate: ({ position, progress }) => {
        outgoing.style.transform = `translate3d(${position}px, 0, 0)`;
        incoming.style.transform = `translate3d(${position - targetX}px, 0, 0)`;
        outgoing.style.opacity = String(
          setup.startOpacity + (0.35 - setup.startOpacity) * progress,
        );
        incoming.style.opacity = String(0.65 + 0.35 * progress);
      },
      onComplete: () => complete(controller),
    });
    activeMotion.current = controller;
  }, [outgoingSurface]);

  useEffect(
    () => () => {
      activeMotion.current?.cancel();
      const request = pendingNavigation.current;
      if (request) window.cancelAnimationFrame(request.restoreFrameHandle);
    },
    [],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch") return;
      if (!event.isPrimary || pendingNavigation.current) return;

      const target = event.target instanceof Element ? event.target : null;
      const swipeSurface = target?.closest(ARTICLE_SWIPE_SURFACE);
      if (!activeLayerRef.current || (target?.closest(ARTICLE_SWIPE_TARGETS) && !swipeSurface)) {
        swipeStart.current = null;
        return;
      }

      const { position, opacity } = preserveActivePresentation();
      transitionSetup.current = null;
      if (outgoingSurfaceRef.current) {
        outgoingSurfaceRef.current = null;
        setOutgoingSurface(null);
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      swipeStart.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        surfaceX: position,
        surfaceOpacity: opacity,
        reducedMotion: prefersReducedMotion(),
        intent: "pending",
        startedOnSwipeSurface: Boolean(swipeSurface),
        samples: [{ x: event.clientX, timeStamp: event.timeStamp }],
      };
    },
    [preserveActivePresentation],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = swipeStart.current;
      if (!start || event.pointerId !== start.pointerId) return;
      start.samples = appendPointerSample(start.samples, {
        x: event.clientX,
        timeStamp: event.timeStamp,
      });

      const horizontalDistance = event.clientX - start.x;
      const verticalDistance = event.clientY - start.y;
      if (start.intent === "pending") {
        start.intent = articleSwipeIntent(horizontalDistance, verticalDistance);
      }
      if (start.intent !== "horizontal") return;

      event.preventDefault();
      const surface = activeLayerRef.current;
      if (!surface) return;
      const directionAvailable = horizontalDistance < 0 ? canNext : canPrevious;
      const visualDistance = articleSwipeOffset(
        horizontalDistance,
        surface.clientWidth,
        directionAvailable,
      );
      const nextX = start.surfaceX + visualDistance;
      const fadeProgress = Math.min(Math.abs(visualDistance) / surface.clientWidth, 1);
      if (!start.reducedMotion) {
        surface.style.transform = `translate3d(${nextX}px, 0, 0)`;
      }
      surface.style.opacity = String(Math.max(0.18, start.surfaceOpacity - fadeProgress * 0.18));
    },
    [canNext, canPrevious],
  );

  const finishPointerGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = swipeStart.current;
      if (!start || event.pointerId !== start.pointerId) return;
      const samples = appendPointerSample(start.samples, {
        x: event.clientX,
        timeStamp: event.timeStamp,
      });
      const velocity = horizontalReleaseVelocity(samples);
      const horizontalDistance = event.clientX - start.x;
      const verticalDistance = event.clientY - start.y;
      const finalIntent =
        start.intent === "pending"
          ? articleSwipeIntent(horizontalDistance, verticalDistance)
          : start.intent;
      swipeStart.current = null;
      if (finalIntent === "horizontal" && start.startedOnSwipeSurface) {
        suppressSwipeSurfaceClick.current = true;
        window.setTimeout(() => {
          suppressSwipeSurfaceClick.current = false;
        }, 0);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (finalIntent !== "horizontal") {
        restoreActiveSurface(0, start.reducedMotion);
        return;
      }

      const direction = articleSwipeDirection({
        startX: start.x,
        startY: start.y,
        endX: event.clientX,
        endY: event.clientY,
        horizontalVelocity: velocity,
      });
      if (!direction) {
        restoreActiveSurface(velocity * 1000, start.reducedMotion);
        return;
      }

      const directionAvailable = direction === "next" ? canNext : canPrevious;
      if (!directionAvailable) {
        restoreActiveSurface(0, start.reducedMotion);
        return;
      }

      navigateWithAnimation(direction, velocity * 1000, start.reducedMotion);
    },
    [canNext, canPrevious, navigateWithAnimation, restoreActiveSurface],
  );

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!suppressSwipeSurfaceClick.current || !target?.closest(ARTICLE_SWIPE_SURFACE)) return;
    suppressSwipeSurfaceClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const cancelPointerGesture = useCallback(() => {
    const start = swipeStart.current;
    if (!start) return;
    swipeStart.current = null;
    restoreActiveSurface(0, start.reducedMotion);
  }, [restoreActiveSurface]);

  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    fullContentPullStart.current = null;
    if (event.touches.length !== 1 || pendingNavigation.current) return;

    const surface = activeLayerRef.current;
    const snapshot = activeSurfaceRef.current;
    const target = event.target instanceof Element ? event.target : null;
    if (
      !surface ||
      surface.scrollTop > 1 ||
      !snapshot ||
      snapshot.fullContentVisible ||
      !snapshot.article.url ||
      snapshot.article.media ||
      target?.closest(ARTICLE_SWIPE_TARGETS)
    ) {
      return;
    }

    const touch = event.touches[0];
    fullContentPullStart.current = {
      identifier: touch.identifier,
      articleId: snapshot.article.id,
      startX: touch.clientX,
      startY: touch.clientY,
    };
  }, []);

  const handleTouchEnd = useCallback(
    (event: ReactTouchEvent<HTMLElement>) => {
      const start = fullContentPullStart.current;
      fullContentPullStart.current = null;
      if (!start) return;

      const touch = Array.from(event.changedTouches).find(
        (candidate) => candidate.identifier === start.identifier,
      );
      const snapshot = activeSurfaceRef.current;
      if (
        !touch ||
        !snapshot ||
        snapshot.article.id !== start.articleId ||
        snapshot.fullContentVisible ||
        !snapshot.article.url ||
        snapshot.article.media ||
        !articleSwipeDownAction({
          startX: start.startX,
          startY: start.startY,
          endX: touch.clientX,
          endY: touch.clientY,
        })
      ) {
        return;
      }

      onToggleFullContent(snapshot.article);
    },
    [onToggleFullContent],
  );

  const cancelFullContentPull = useCallback(() => {
    fullContentPullStart.current = null;
  }, []);

  if (!activeSurface) {
    return (
      <section className="reader-pane reader-placeholder">
        <BookOpen aria-hidden="true" size={24} />
        <p>Choose an article from the list.</p>
      </section>
    );
  }

  const renderArticleDocument = (surface: ArticleSurfaceSnapshot, titleId: string) => (
    <ArticleDocument
      article={surface.article}
      titleId={titleId}
      fullContentVisible={surface.fullContentVisible}
      summaryState={surface.summaryState}
      translationState={surface.translationState}
      translationLanguage={translationLanguage}
      customPrompts={customPrompts}
      showYouTubeDescriptions={showYouTubeDescriptions}
      onFeedAction={onFeedAction}
      onToggleFullContent={onToggleFullContent}
      onRegenerateSummary={onRegenerateSummary}
      onOpenAiSettings={onOpenAiSettings}
      onFilterSelection={onFilterSelection}
    />
  );
  const activeTitleId = `article-${activeSurface.article.id}-title`;

  return (
    <article
      className="reader-pane"
      aria-labelledby={activeTitleId}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerGesture}
      onPointerCancel={cancelPointerGesture}
      onLostPointerCapture={cancelPointerGesture}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={cancelFullContentPull}
      onClickCapture={handleClickCapture}
    >
      <div className="reader-action-bar">
        <div className="reader-action-row">
          <button
            data-management-focus-fallback
            className="reader-back-button"
            type="button"
            aria-label="Back to articles"
            data-tooltip="Back to articles"
            onClick={onBack}
          >
            <List aria-hidden="true" size={16} />
          </button>
          <span className="reader-action-divider" aria-hidden="true" />
          <ArticleActions
            article={activeSurface.article}
            fullContentVisible={activeSurface.fullContentVisible}
            summaryState={activeSurface.summaryState}
            translationState={activeSurface.translationState}
            translationLanguage={translationLanguage}
            customPrompts={customPrompts}
            onPrevious={() => navigateWithAnimation("previous")}
            onNext={() => navigateWithAnimation("next")}
            canPrevious={canPrevious}
            canNext={canNext}
            navigationPending={navigationPending}
            onToggleRead={onToggleRead}
            onToggleStar={onToggleStar}
            onCopy={onCopy}
            onOpenSource={onOpenSource}
            onToggleFullContent={onToggleFullContent}
            onRunSummaryPrompt={onRunSummaryPrompt}
            onToggleTranslation={onToggleTranslation}
          />
        </div>
      </div>
      <div className="article-swipe-stage">
        {outgoingSurface ? (
          <div
            ref={outgoingLayerRef}
            className="article-swipe-layer is-outgoing"
            key={`article-${outgoingSurface.snapshot.article.id}`}
            aria-hidden="true"
            inert
          >
            {renderArticleDocument(
              outgoingSurface.snapshot,
              `article-${outgoingSurface.snapshot.article.id}-outgoing-${outgoingSurface.requestId}-title`,
            )}
          </div>
        ) : null}
        <div
          ref={activeLayerRef}
          className="article-swipe-layer is-active"
          key={`article-${activeSurface.article.id}`}
        >
          {renderArticleDocument(activeSurface, activeTitleId)}
        </div>
      </div>
    </article>
  );
}

function ArticleSourceMenu({
  article,
  onFeedAction,
}: {
  article: Article;
  onFeedAction: (feedId: number, action: FeedManagementAction) => void;
}) {
  const menu = useActionMenu();
  const menuId = `article-${article.id}-source-menu`;
  const anchorName = `--article-${article.id}-source`;

  return (
    <>
      <button
        ref={menu.triggerRef}
        data-management-feed-id={article.feedId}
        className="article-source-trigger"
        type="button"
        aria-label={`${article.feedTitle} feed actions`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menuId}
        popoverTarget={menuId}
        style={{ anchorName }}
        onPointerDown={menu.handleTriggerPointerDown}
        onKeyDown={menu.handleTriggerKeyDown}
      >
        <span>{article.feedTitle}</span>
        <ChevronDown aria-hidden="true" size={15} />
      </button>
      <div
        ref={menu.menuRef}
        id={menuId}
        className="article-source-menu context-action-menu"
        popover="auto"
        role="menu"
        aria-label={`${article.feedTitle} feed actions`}
        style={{ positionAnchor: anchorName }}
        onToggle={menu.handleMenuToggle}
        onKeyDown={menu.handleMenuKeyDown}
      >
        <FeedActionMenuItems
          sourceKind={article.feedSourceKind}
          onAction={(action) => {
            menu.closeMenu();
            onFeedAction(article.feedId, action);
          }}
        />
      </div>
    </>
  );
}

function ArticleHeader({
  article,
  id,
  onFeedAction,
}: {
  article: Article;
  id: string;
  onFeedAction: (feedId: number, action: FeedManagementAction) => void;
}) {
  return (
    <header className="article-header" id={id}>
      <div className="article-source-row">
        <ArticleSourceMenu article={article} onFeedAction={onFeedAction} />
        <span aria-hidden="true">·</span>
        <time dateTime={article.publishedAt ?? article.discoveredAt}>{articleDate(article)}</time>
        {article.media ? (
          <>
            <span aria-hidden="true">·</span>
            <span className={`article-media-badge ${article.media.type}`}>
              {mediaTypeLabel(article)}
            </span>
            {article.media.viewCount !== null ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatViewCount(article.media.viewCount)} views</span>
              </>
            ) : null}
          </>
        ) : null}
        {article.author ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{article.author}</span>
          </>
        ) : null}
      </div>
      {article.title ? (
        <h2>
          {article.url ? (
            <a href={article.url} target="_blank" rel="noreferrer">
              {article.title}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            article.title
          )}
        </h2>
      ) : null}
    </header>
  );
}

function ArticleBody({
  article,
  fullContentVisible,
  translationState,
  showYouTubeDescriptions,
  onToggleFullContent,
}: {
  article: Article;
  fullContentVisible: boolean;
  translationState: ArticleTranslationViewState;
  showYouTubeDescriptions: boolean;
  onToggleFullContent: (article: Article) => void;
}) {
  const xPostId = xVideoPostId(article.url, article.feedContentHtml);
  const translation = shouldShowArticleDescription(article, showYouTubeDescriptions)
    ? translationState.translation
    : null;
  const translationVisible = Boolean(translationState.visible && translation);
  const contentView = articleContentView(article, fullContentVisible);
  const xVideoTargetId =
    xPostId && contentView !== "full" && !translationVisible
      ? xVideoPlaceholderId(article.id)
      : null;

  return (
    <>
      {article.media ? <ArticleMediaPlayer article={article} /> : null}
      <div
        className="article-content-stage"
        data-translation-ready={translation !== null}
        data-translation-visible={translationVisible}
      >
        <div
          className="article-content-layer is-original"
          data-state={translationVisible ? "inactive" : "active"}
          aria-hidden={translationVisible}
          inert={translationVisible}
        >
          <ArticleText
            article={article}
            fullContentVisible={fullContentVisible}
            showYouTubeDescriptions={showYouTubeDescriptions}
            onToggleFullContent={onToggleFullContent}
          />
        </div>
        {translation ? (
          <div
            className="article-content-layer is-translation"
            data-state={translationVisible ? "active" : "inactive"}
            aria-hidden={!translationVisible}
            inert={!translationVisible}
          >
            <ArticleTranslationText translation={translation} />
          </div>
        ) : null}
      </div>
      {telegramPostIdentity(article.url) ? <TelegramPostMedia article={article} /> : null}
      {xPostId ? <XPostVideo article={article} postId={xPostId} targetId={xVideoTargetId} /> : null}
    </>
  );
}

type XMediaViewState =
  | { status: "loading" }
  | { status: "ready"; media: XArticleMedia }
  | { status: "error"; message: string };

function XPostVideo({
  article,
  postId,
  targetId,
}: {
  article: Article;
  postId: string;
  targetId: string | null;
}) {
  const [state, setState] = useState<XMediaViewState>({ status: "loading" });
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const requestController = useRef<AbortController | null>(null);

  const loadMedia = useCallback(() => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setState({ status: "loading" });
    void api
      .xArticleMedia(article.id, controller.signal)
      .then((media) => setState({ status: "ready", media }))
      .catch((error) => {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: errorMessage(error) });
        }
      });
  }, [article.id]);

  useEffect(() => {
    loadMedia();
    return () => requestController.current?.abort();
  }, [loadMedia]);

  useLayoutEffect(() => {
    setPortalTarget(targetId && article.feedContentHtml ? document.getElementById(targetId) : null);
  }, [article.feedContentHtml, targetId]);

  if (state.status === "loading") return null;
  const isQuotedPostVideo = xPostId(article.url) !== postId;
  if (state.status === "error") {
    const error = (
      <div className="x-media-state x-media-error" role="alert">
        <AlertTriangle aria-hidden="true" size={16} />
        <span>{state.message}</span>
        <button className="secondary-button" type="button" onClick={loadMedia}>
          Try again
        </button>
        <a href={`https://x.com/i/status/${postId}`} target="_blank" rel="noreferrer">
          Open on X
        </a>
      </div>
    );
    return portalTarget ? createPortal(error, portalTarget) : error;
  }

  const video = (
    // biome-ignore lint/a11y/useMediaCaption: X's public media metadata does not expose caption tracks.
    <video
      className="x-video-player"
      src={articleImageUrl(state.media.sourceUrl)}
      poster={state.media.posterUrl ? articleImageUrl(state.media.posterUrl) : undefined}
      aria-label={
        isQuotedPostVideo
          ? "X video from quoted post"
          : `X video from ${article.author ?? "this post"}`
      }
      style={state.media.aspectRatio ? { aspectRatio: state.media.aspectRatio } : undefined}
      controls
      playsInline
      preload="metadata"
    />
  );
  return portalTarget ? createPortal(video, portalTarget) : video;
}

type TelegramMediaViewState =
  | { status: "loading" }
  | { status: "ready"; media: TelegramArticleMedia }
  | { status: "error"; message: string };

function TelegramPostMedia({ article }: { article: Article }) {
  const [state, setState] = useState<TelegramMediaViewState>({ status: "loading" });
  const [lightbox, setLightbox] = useState<ImageLightboxState | null>(null);
  const requestController = useRef<AbortController | null>(null);

  const loadMedia = useCallback(() => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setState({ status: "loading" });
    void api
      .telegramArticleMedia(article.id, controller.signal)
      .then((media) => setState({ status: "ready", media }))
      .catch((error) => {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: errorMessage(error) });
        }
      });
  }, [article.id]);

  useEffect(() => {
    loadMedia();
    return () => requestController.current?.abort();
  }, [loadMedia]);

  if (state.status === "loading") return null;
  if (state.status === "error") {
    return (
      <div className="telegram-media-state telegram-media-error" role="alert">
        <AlertTriangle aria-hidden="true" size={16} />
        <span>{state.message}</span>
        <button className="secondary-button" type="button" onClick={loadMedia}>
          Try again
        </button>
      </div>
    );
  }
  if (state.media.items.length === 0) return null;

  const multiple = state.media.items.length > 1;
  const galleryImages: ImageLightboxItem[] = state.media.items
    .filter((item) => item.kind === "image")
    .map((item, index, images) => ({
      src: articleImageUrl(item.sourceUrl),
      alt: `Telegram post image ${index + 1} of ${images.length}`,
    }));
  return (
    <>
      <section
        className={`telegram-media-gallery${multiple ? " is-grouped" : ""}`}
        aria-label="Telegram post media"
      >
        {state.media.items.map((item, index) => {
          const label = `Telegram post ${item.kind} ${index + 1} of ${state.media.items.length}`;
          const style = item.aspectRatio ? { aspectRatio: item.aspectRatio } : undefined;
          if (item.kind === "image") {
            const galleryIndex = state.media.items
              .slice(0, index)
              .filter((candidate) => candidate.kind === "image").length;
            return (
              <button
                key={item.sourceUrl}
                className="telegram-image-lightbox-trigger"
                type="button"
                data-image-lightbox-trigger
                aria-label={`Enlarge image: ${label}`}
                onClick={(event) =>
                  setLightbox({
                    images: galleryImages,
                    index: galleryIndex,
                    returnFocus: event.currentTarget,
                  })
                }
              >
                <img
                  src={articleImageUrl(item.sourceUrl)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  data-image-lightbox-trigger
                />
              </button>
            );
          }
          return (
            // biome-ignore lint/a11y/useMediaCaption: Telegram embeds do not expose caption tracks.
            <video
              key={item.sourceUrl}
              src={articleImageUrl(item.sourceUrl)}
              poster={item.posterUrl ? articleImageUrl(item.posterUrl) : undefined}
              aria-label={label}
              style={style}
              controls
              playsInline
              preload="metadata"
            />
          );
        })}
      </section>
      {lightbox ? <ImageLightbox state={lightbox} onClose={() => setLightbox(null)} /> : null}
    </>
  );
}

function ArticleTranslationText({ translation }: { translation: ArticleAiTranslation }) {
  return (
    <ArticleHtml className="article-content article-translation" sanitizedHtml={translation.html} />
  );
}

function ArticleMediaPlayer({ article }: { article: Article }) {
  const media = article.media;
  const [interactive, setInteractive] = useState(false);
  if (!media) return null;
  const playerUrl = interactive ? `${media.embedUrl}?autoplay=1&playsinline=1` : media.embedUrl;
  return (
    <div className={`article-media-player ${media.type}`}>
      <iframe
        src={playerUrl}
        title={`Play ${article.title}`}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
      {!interactive ? (
        <button
          className="article-media-swipe-surface"
          type="button"
          aria-label={`Play ${article.title || "video"}`}
          data-article-swipe-surface
          onClick={() => setInteractive(true)}
        />
      ) : null}
    </div>
  );
}

function ArticleText({
  article,
  fullContentVisible,
  showYouTubeDescriptions,
  onToggleFullContent,
}: {
  article: Article;
  fullContentVisible: boolean;
  showYouTubeDescriptions: boolean;
  onToggleFullContent: (article: Article) => void;
}) {
  const contentView = articleContentView(article, fullContentVisible);
  if (contentView === "feed" || contentView === "summary" || contentView === "empty") {
    return <FeedArticleText article={article} showYouTubeDescriptions={showYouTubeDescriptions} />;
  }

  if (contentView === "loading") {
    return (
      <>
        <div className="article-extraction-state extraction-loading" role="status">
          <LoaderCircle className="spin" aria-hidden="true" size={18} />
          <div>
            <strong>Loading the full article</strong>
            <p>You can keep reading the feed text while feedfold loads the source page.</p>
          </div>
        </div>
        <FeedArticleText article={article} showYouTubeDescriptions={showYouTubeDescriptions} />
      </>
    );
  }
  if (contentView === "full" && article.contentHtml) {
    return <ArticleHtml sanitizedHtml={article.contentHtml} />;
  }
  if (contentView === "failed") {
    return (
      <>
        <div className="article-extraction-state extraction-failed" role="note">
          <AlertTriangle aria-hidden="true" size={18} />
          <div>
            <strong>Could not load the full article</strong>
            <p>
              {article.extractionError ?? "The source page did not contain readable article text."}
            </p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => onToggleFullContent(article)}
            >
              <RefreshCw aria-hidden="true" size={15} />
              Try again
            </button>
          </div>
        </div>
        <FeedArticleText article={article} showYouTubeDescriptions={showYouTubeDescriptions} />
      </>
    );
  }

  return <FeedArticleText article={article} showYouTubeDescriptions={showYouTubeDescriptions} />;
}

function FeedArticleText({
  article,
  showYouTubeDescriptions,
}: {
  article: Article;
  showYouTubeDescriptions: boolean;
}) {
  if (!shouldShowArticleDescription(article, showYouTubeDescriptions)) return null;
  if (article.feedContentHtml) {
    const xPostId = xVideoPostId(article.url, article.feedContentHtml);
    const html = xPostId
      ? withXVideoPlaceholder(article.feedContentHtml, xPostId, article.id)
      : article.feedContentHtml;
    return <ArticleHtml sanitizedHtml={html} />;
  }
  return article.summary ? (
    <div className="article-content">
      <p>
        <LinkifiedText text={article.summary} />
      </p>
    </div>
  ) : (
    <div className="article-extraction-state">
      <FileText aria-hidden="true" size={18} />
      <p>This feed did not provide article text. Open the source to read it.</p>
    </div>
  );
}

export function ExpandedStream({
  articles,
  activeId,
  topAlignedId,
  fullContentVisibleIds,
  summaryStates,
  translationStates,
  translationLanguage,
  customPrompts,
  showYouTubeDescriptions,
  markReadOnScroll,
  hasMore,
  loadingMore,
  onLoadMore,
  onActivate,
  onMarkPassedRead,
  onToggleRead,
  onToggleStar,
  onCopy,
  onOpenSource,
  onFeedAction,
  onToggleFullContent,
  onRunSummaryPrompt,
  onToggleTranslation,
  onRegenerateSummary,
  onOpenAiSettings,
  onFilterSelection,
}: {
  articles: Article[];
  activeId: number | null;
  topAlignedId: number | null;
  fullContentVisibleIds: ReadonlySet<number>;
  summaryStates: ReadonlyMap<number, ArticleSummaryViewState>;
  translationStates: ReadonlyMap<number, ArticleTranslationViewState>;
  translationLanguage: string;
  customPrompts: AiCustomPrompt[];
  showYouTubeDescriptions: boolean;
  markReadOnScroll: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onActivate: (article: Article) => void;
  onMarkPassedRead: (articles: Article[]) => Promise<unknown>;
  onToggleRead: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onCopy: (article: Article) => void;
  onOpenSource: (article: Article) => void;
  onFeedAction: (feedId: number, action: FeedManagementAction) => void;
  onToggleFullContent: (article: Article) => void;
  onRunSummaryPrompt: (article: Article, promptId: string | null) => void;
  onToggleTranslation: (article: Article) => void;
  onRegenerateSummary: (article: Article) => void;
  onOpenAiSettings: () => void;
  onFilterSelection: (article: Article, text: string) => void;
}) {
  const streamRef = useRef<HTMLElement>(null);
  useExpandedActionDocking(streamRef, articles.map((article) => article.id).join(","));
  const registerItem = useMarkReadOnScroll({
    articles,
    activeId,
    enabled: markReadOnScroll,
    onMarkPassedRead,
    rootRef: streamRef,
    useParent: true,
    topAlignedId,
  });

  return (
    <section ref={streamRef} className="expanded-stream" aria-label="Expanded articles">
      {articles.map((article) => (
        <article
          ref={(element) => registerItem(article.id, element)}
          className={`expanded-article${article.id === activeId ? " is-active" : ""}${article.isRead ? " is-read" : ""}`}
          key={article.id}
          aria-labelledby={`expanded-${article.id}-title`}
          onFocus={() => onActivate(article)}
        >
          <div className="expanded-actions">
            <ArticleActions
              article={article}
              fullContentVisible={fullContentVisibleIds.has(article.id)}
              summaryState={summaryStates.get(article.id) ?? EMPTY_ARTICLE_SUMMARY_STATE}
              translationState={
                translationStates.get(article.id) ?? EMPTY_ARTICLE_TRANSLATION_STATE
              }
              translationLanguage={translationLanguage}
              customPrompts={customPrompts}
              onToggleRead={onToggleRead}
              onToggleStar={onToggleStar}
              onCopy={onCopy}
              onOpenSource={onOpenSource}
              onToggleFullContent={onToggleFullContent}
              onRunSummaryPrompt={onRunSummaryPrompt}
              onToggleTranslation={onToggleTranslation}
            />
          </div>
          <ArticleDocument
            article={article}
            titleId={`expanded-${article.id}-title`}
            fullContentVisible={fullContentVisibleIds.has(article.id)}
            summaryState={summaryStates.get(article.id) ?? EMPTY_ARTICLE_SUMMARY_STATE}
            translationState={translationStates.get(article.id) ?? EMPTY_ARTICLE_TRANSLATION_STATE}
            translationLanguage={translationLanguage}
            customPrompts={customPrompts}
            showYouTubeDescriptions={showYouTubeDescriptions}
            onFeedAction={onFeedAction}
            onToggleFullContent={onToggleFullContent}
            onRegenerateSummary={onRegenerateSummary}
            onOpenAiSettings={onOpenAiSettings}
            onFilterSelection={onFilterSelection}
          />
        </article>
      ))}
      <ArticleLoadSentinel
        rootRef={streamRef}
        useParent
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
      />
    </section>
  );
}
