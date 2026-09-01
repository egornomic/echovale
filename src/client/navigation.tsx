import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Ellipsis,
  ExternalLink,
  FileText,
  Folder,
  LayoutList,
  ListFilter,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Settings,
  UserRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  ArticleState,
  BootstrapData,
  Feed,
  Folder as FolderType,
  MarkReadAgeDays,
  ReadingMode,
  SessionUser,
} from "../shared/types";
import { MARK_READ_AGE_DAYS } from "../shared/types";
import { BrandIdentity } from "./brand";
import { type FeedDragState, useFeedDrag } from "./feed-drag";
import {
  FeedActionMenuItems,
  type FeedManagementAction,
  FolderActionMenuItems,
  type FolderManagementAction,
  handleActionMenuKeyDown,
} from "./feed-management";
import { useMotionPresence } from "./motion";

export type AppView = "reader" | "feeds" | "rules" | "settings";

function selectedFolderPath(
  folders: FolderType[],
  feeds: Feed[],
  selectedFeedId: number | null,
  selectedFolderId: number | null,
): Set<number> {
  const parentIds = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  let folderId =
    selectedFolderId ?? feeds.find((feed) => feed.id === selectedFeedId)?.folderId ?? null;
  const path = new Set<number>();

  while (folderId !== null) {
    path.add(folderId);
    folderId = parentIds.get(folderId) ?? null;
  }

  return path;
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

function ArticleCount({ count }: { count: number }) {
  const exactCount = count.toLocaleString();

  return (
    <span className="nav-count" title={exactCount}>
      <span aria-hidden="true">{count > 999 ? "999+" : count}</span>
      <span className="sr-only">{exactCount}</span>
    </span>
  );
}

function IconButton({
  label,
  children,
  pressed,
  disabled,
  tooltip = false,
  onClick,
  className = "",
}: {
  label: string;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  tooltip?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      type="button"
      aria-label={label}
      title={tooltip ? undefined : label}
      data-tooltip={tooltip ? label : undefined}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface SidebarProps {
  bootstrap: BootstrapData;
  user: SessionUser;
  localApp?: boolean;
  sourceUrl?: string;
  currentState: ArticleState;
  selectedFeedId: number | null;
  selectedFolderId: number | null;
  currentView: AppView;
  open: boolean;
  collapsed: boolean;
  onClose: () => void;
  onToggleCollapse: () => void;
  onSelectState: (state: ArticleState) => void;
  onSelectScope: (feedId: number | null, folderId: number | null) => void;
  onAddFeed: () => void;
  onNavigate: (view: AppView) => void;
  onFeedAction: (feed: Feed, action: FeedManagementAction) => void;
  onFolderAction: (folder: FolderType, action: FolderManagementAction) => void;
  onMoveFeed: (feed: Feed, folderId: number | null) => Promise<boolean>;
  onRefresh: () => void;
  onLogout: () => Promise<void>;
}

type SidebarContextMenuState =
  | {
      kind: "feed";
      feed: Feed;
      trigger: HTMLButtonElement;
      left: number;
      top: number;
    }
  | {
      kind: "folder";
      folder: FolderType;
      trigger: HTMLButtonElement;
      left: number;
      top: number;
    };

export function Sidebar({
  bootstrap,
  user,
  localApp = false,
  sourceUrl,
  currentState,
  selectedFeedId,
  selectedFolderId,
  currentView,
  open,
  collapsed,
  onClose,
  onToggleCollapse,
  onSelectState,
  onSelectScope,
  onAddFeed,
  onNavigate,
  onFeedAction,
  onFolderAction,
  onMoveFeed,
  onRefresh,
  onLogout,
}: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const rootFolders = bootstrap.folders.filter((folder) => folder.parentId === null);
  const uncategorized = bootstrap.feeds.filter((feed) => feed.folderId === null);
  const feedDrag = useFeedDrag(bootstrap.feeds, onMoveFeed);
  const { draggedFeed, dropTarget } = feedDrag;
  const hasFeedErrors = bootstrap.feeds.some((feed) => feed.lastError);
  const refreshing = bootstrap.feeds.some((feed) => feed.refreshing);
  const selectedFolderPathIds = selectedFolderPath(
    bootstrap.folders,
    bootstrap.feeds,
    selectedFeedId,
    selectedFolderId,
  );

  const closeContextMenu = useCallback(() => {
    contextMenu?.trigger.focus();
    setContextMenu(null);
  }, [contextMenu]);

  const openFeedMenu = useCallback(
    (feed: Feed, trigger: HTMLButtonElement, left: number, top: number) => {
      trigger.focus();
      setContextMenu({ kind: "feed", feed, trigger, left, top });
    },
    [],
  );

  const openFolderMenu = useCallback(
    (folder: FolderType, trigger: HTMLButtonElement, left: number, top: number) => {
      trigger.focus();
      setContextMenu({ kind: "folder", folder, trigger, left, top });
    },
    [],
  );

  const topLevelDropAvailable = draggedFeed !== null && draggedFeed.folderId !== null;
  const topLevelDropActive = dropTarget === "top-level";

  return (
    <aside
      className={`sidebar${open ? " is-open" : ""}${collapsed ? " is-collapsed" : ""}${draggedFeed ? " is-dragging-feed" : ""}`}
      aria-label="Primary navigation"
    >
      <div className="brand-row">
        <button className="brand" type="button" onClick={() => onSelectScope(null, null)}>
          <BrandIdentity />
        </button>
        <IconButton
          label={collapsed ? "Show sidebar" : "Hide sidebar"}
          onClick={onToggleCollapse}
          className="sidebar-collapse-button"
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden="true" size={18} />
          ) : (
            <PanelLeftClose aria-hidden="true" size={18} />
          )}
        </IconButton>
        <IconButton label="Close navigation" onClick={onClose} className="close-nav">
          <X aria-hidden="true" size={18} />
        </IconButton>
      </div>

      <nav className="sidebar-navigation">
        <ul className="nav-list quick-links">
          <li>
            <button
              className="nav-item"
              aria-current={
                currentView === "reader" &&
                currentState !== "starred" &&
                selectedFeedId === null &&
                selectedFolderId === null
                  ? "page"
                  : undefined
              }
              type="button"
              onClick={() => onSelectState("unread")}
            >
              <span>Feed</span>
              <ArticleCount count={bootstrap.counts.unread} />
              <Kbd>g u</Kbd>
            </button>
          </li>
          <li>
            <button
              className="nav-item"
              aria-current={
                currentView === "reader" &&
                currentState === "starred" &&
                selectedFeedId === null &&
                selectedFolderId === null
                  ? "page"
                  : undefined
              }
              type="button"
              onClick={() => onSelectState("starred")}
            >
              <span>Saved</span>
              <ArticleCount count={bootstrap.counts.starred} />
              <Kbd>g s</Kbd>
            </button>
          </li>
        </ul>

        <div className="sidebar-scroll">
          <fieldset
            className={`sidebar-section-heading sidebar-top-level-drop${topLevelDropAvailable ? " is-feed-drop-available" : ""}${topLevelDropActive ? " is-feed-drop-target" : ""}`}
            aria-label={topLevelDropAvailable ? "Move feed to top level" : "Subscription actions"}
            onDragEnter={(event) => feedDrag.enterTarget(null, event)}
            onDragOver={(event) => feedDrag.enterTarget(null, event)}
            onDragLeave={(event) => feedDrag.leaveTarget(null, event)}
            onDrop={(event) => void feedDrag.dropOnTarget(null, event)}
          >
            <span>
              {topLevelDropActive
                ? "Drop at top level"
                : topLevelDropAvailable
                  ? "Top level"
                  : "Subscriptions"}
            </span>
            <span className="sidebar-section-actions">
              {bootstrap.capabilities.manualRefresh ? (
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={refreshing}
                  aria-label="Refresh feeds"
                  title="Refresh feeds (R)"
                >
                  <RefreshCw className={refreshing ? "spin" : ""} aria-hidden="true" size={14} />
                </button>
              ) : null}
              <button type="button" onClick={onAddFeed} aria-label="Add feed" title="Add feed">
                <Plus aria-hidden="true" size={15} />
              </button>
            </span>
          </fieldset>

          {bootstrap.feeds.length === 0 ? (
            <button className="sidebar-empty" type="button" onClick={onAddFeed}>
              <Plus aria-hidden="true" size={15} />
              Add your first feed
            </button>
          ) : (
            <ul className="folder-tree">
              {rootFolders.map((folder) => (
                <SidebarFolder
                  key={folder.id}
                  folder={folder}
                  folders={bootstrap.folders}
                  feeds={bootstrap.feeds}
                  selectedFeedId={selectedFeedId}
                  selectedFolderId={selectedFolderId}
                  selectedFolderPathIds={selectedFolderPathIds}
                  currentView={currentView}
                  feedDrag={feedDrag}
                  onSelectScope={onSelectScope}
                  onOpenFeedMenu={openFeedMenu}
                  onOpenFolderMenu={openFolderMenu}
                />
              ))}
              {uncategorized.map((feed) => (
                <SidebarFeed
                  key={feed.id}
                  feed={feed}
                  selected={currentView === "reader" && selectedFeedId === feed.id}
                  feedDrag={feedDrag}
                  onSelect={() => onSelectScope(feed.id, null)}
                  onOpenMenu={openFeedMenu}
                />
              ))}
            </ul>
          )}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button
          data-management-focus-fallback
          className="nav-item"
          aria-current={currentView === "feeds" ? "page" : undefined}
          type="button"
          onClick={() => onNavigate("feeds")}
        >
          {hasFeedErrors ? (
            <AlertTriangle className="status-warning" aria-hidden="true" size={16} />
          ) : (
            <Rss aria-hidden="true" size={16} />
          )}
          <span>Manage feeds</span>
          <Kbd>g f</Kbd>
        </button>
        <button
          className="nav-item"
          aria-current={currentView === "rules" ? "page" : undefined}
          type="button"
          onClick={() => onNavigate("rules")}
        >
          <ListFilter aria-hidden="true" size={16} />
          <span>Rules</span>
          <Kbd>g r</Kbd>
        </button>
        <button
          className="nav-item"
          aria-current={currentView === "settings" ? "page" : undefined}
          type="button"
          onClick={() => onNavigate("settings")}
        >
          <Settings aria-hidden="true" size={16} />
          <span>Settings</span>
          <Kbd>g ,</Kbd>
        </button>
        {!localApp ? (
          <div className="sidebar-account">
            <span className="account-name" title={user.username}>
              <UserRound aria-hidden="true" size={16} />
              <span className="truncate">{user.username}</span>
            </span>
            <span className="sidebar-account-actions">
              {sourceUrl ? (
                <a
                  className="icon-button"
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View feedfold on GitHub"
                  title="View on GitHub"
                >
                  <ExternalLink aria-hidden="true" size={16} />
                </a>
              ) : null}
              <button
                className="icon-button"
                type="button"
                aria-label={`Log out ${user.username}`}
                title="Log out"
                onClick={() => void onLogout()}
              >
                <LogOut aria-hidden="true" size={16} />
              </button>
            </span>
          </div>
        ) : null}
      </div>
      {contextMenu ? (
        <SidebarContextMenu
          state={contextMenu}
          onClose={closeContextMenu}
          onFeedAction={(feed, action) => {
            closeContextMenu();
            onFeedAction(feed, action);
          }}
          onFolderAction={(folder, action) => {
            closeContextMenu();
            onFolderAction(folder, action);
          }}
        />
      ) : null}
    </aside>
  );
}

function SidebarContextMenu({
  state,
  onClose,
  onFeedAction,
  onFolderAction,
}: {
  state: SidebarContextMenuState;
  onClose: () => void;
  onFeedAction: (feed: Feed, action: FeedManagementAction) => void;
  onFolderAction: (folder: FolderType, action: FolderManagementAction) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: state.left, top: state.top });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(state.left, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(state.top, window.innerHeight - bounds.height - 8)),
    });
  }, [state]);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    const dismissPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const dismissFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && target !== state.trigger) onClose();
    };
    document.addEventListener("pointerdown", dismissPointer, true);
    document.addEventListener("focusin", dismissFocus);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", dismissPointer, true);
      document.removeEventListener("focusin", dismissFocus);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, state.trigger]);

  return createPortal(
    <div
      ref={menuRef}
      className="sidebar-context-menu context-action-menu"
      role="menu"
      aria-label={`${state.kind === "feed" ? state.feed.title : state.folder.name} actions`}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        handleActionMenuKeyDown(event, onClose);
      }}
    >
      {state.kind === "feed" ? (
        <FeedActionMenuItems
          feed={state.feed}
          onAction={(action) => onFeedAction(state.feed, action)}
        />
      ) : (
        <FolderActionMenuItems onAction={(action) => onFolderAction(state.folder, action)} />
      )}
    </div>,
    document.body,
  );
}

function SidebarFolder({
  folder,
  folders,
  feeds,
  selectedFeedId,
  selectedFolderId,
  selectedFolderPathIds,
  currentView,
  feedDrag,
  onSelectScope,
  onOpenFeedMenu,
  onOpenFolderMenu,
}: {
  folder: FolderType;
  folders: FolderType[];
  feeds: Feed[];
  selectedFeedId: number | null;
  selectedFolderId: number | null;
  selectedFolderPathIds: Set<number>;
  currentView: AppView;
  feedDrag: FeedDragState;
  onSelectScope: (feedId: number | null, folderId: number | null) => void;
  onOpenFeedMenu: (feed: Feed, trigger: HTMLButtonElement, left: number, top: number) => void;
  onOpenFolderMenu: (
    folder: FolderType,
    trigger: HTMLButtonElement,
    left: number,
    top: number,
  ) => void;
}) {
  const revealsSelection = selectedFolderPathIds.has(folder.id);
  const [expanded, setExpanded] = useState(revealsSelection);
  const childFolders = folders.filter((candidate) => candidate.parentId === folder.id);
  const childFeeds = feeds.filter((feed) => feed.folderId === folder.id);
  const hasChildren = childFolders.length > 0 || childFeeds.length > 0;
  const selectedScope =
    selectedFeedId !== null
      ? `feed:${selectedFeedId}`
      : selectedFolderId !== null
        ? `folder:${selectedFolderId}`
        : null;
  const dropAvailable =
    feedDrag.draggedFeed !== null && feedDrag.draggedFeed.folderId !== folder.id;
  const dropActive = feedDrag.dropTarget === folder.id;

  useEffect(() => {
    if (revealsSelection && selectedScope) setExpanded(true);
  }, [revealsSelection, selectedScope]);

  return (
    <li>
      <div
        className={`tree-row${dropAvailable ? " is-feed-drop-available" : ""}${dropActive ? " is-feed-drop-target" : ""}`}
      >
        <button
          className="tree-toggle"
          type="button"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${folder.name}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          disabled={!hasChildren}
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" size={14} />
          )}
        </button>
        <button
          data-management-folder-id={folder.id}
          className="nav-item tree-nav-item"
          aria-current={
            currentView === "reader" && selectedFolderId === folder.id && selectedFeedId === null
              ? "page"
              : undefined
          }
          type="button"
          onDragEnter={(event) => feedDrag.enterTarget(folder.id, event)}
          onDragOver={(event) => feedDrag.enterTarget(folder.id, event)}
          onDragLeave={(event) => feedDrag.leaveTarget(folder.id, event)}
          onDrop={(event) => {
            void feedDrag.dropOnTarget(folder.id, event).then((moved) => {
              if (moved) setExpanded(true);
            });
          }}
          onClick={() => onSelectScope(null, folder.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenFolderMenu(folder, event.currentTarget, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenFolderMenu(folder, event.currentTarget, bounds.left + 24, bounds.bottom - 4);
          }}
          aria-haspopup="menu"
        >
          <Folder aria-hidden="true" size={15} />
          <span className="truncate" title={folder.name}>
            {folder.name}
          </span>
          {folder.unreadCount > 0 ? <ArticleCount count={folder.unreadCount} /> : null}
        </button>
        <button
          className="folder-menu-button"
          type="button"
          aria-label={`Manage ${folder.name}`}
          title={`Manage ${folder.name}`}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenFolderMenu(folder, event.currentTarget, bounds.right, bounds.bottom);
          }}
        >
          <Ellipsis aria-hidden="true" size={15} />
        </button>
      </div>
      {expanded && hasChildren ? (
        <ul className="folder-tree nested-tree">
          {childFolders.map((child) => (
            <SidebarFolder
              key={child.id}
              folder={child}
              folders={folders}
              feeds={feeds}
              selectedFeedId={selectedFeedId}
              selectedFolderId={selectedFolderId}
              selectedFolderPathIds={selectedFolderPathIds}
              currentView={currentView}
              feedDrag={feedDrag}
              onSelectScope={onSelectScope}
              onOpenFeedMenu={onOpenFeedMenu}
              onOpenFolderMenu={onOpenFolderMenu}
            />
          ))}
          {childFeeds.map((feed) => (
            <SidebarFeed
              key={feed.id}
              feed={feed}
              selected={currentView === "reader" && selectedFeedId === feed.id}
              feedDrag={feedDrag}
              onSelect={() => onSelectScope(feed.id, null)}
              onOpenMenu={onOpenFeedMenu}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SidebarFeed({
  feed,
  selected,
  feedDrag,
  onSelect,
  onOpenMenu,
}: {
  feed: Feed;
  selected: boolean;
  feedDrag: FeedDragState;
  onSelect: () => void;
  onOpenMenu: (feed: Feed, trigger: HTMLButtonElement, left: number, top: number) => void;
}) {
  const healthClass =
    feed.healthStatus !== "healthy" ? "failed" : feed.paused ? "paused" : "healthy";
  const healthLabel =
    feed.healthStatus !== "healthy" ? "Needs attention" : feed.paused ? "Paused" : "Healthy";
  const dragging = feedDrag.draggedFeed?.id === feed.id;
  const moving = feedDrag.movingFeedId === feed.id;

  return (
    <li>
      <div
        className={`feed-tree-row${dragging ? " is-dragging" : ""}${moving ? " is-moving" : ""}`}
      >
        <button
          data-management-feed-id={feed.id}
          className="nav-item feed-nav-item"
          aria-current={selected ? "page" : undefined}
          aria-haspopup="menu"
          aria-busy={moving || undefined}
          draggable={feedDrag.movingFeedId === null}
          type="button"
          onDragStart={(event) => feedDrag.start(feed, event)}
          onDragEnd={feedDrag.end}
          onClick={onSelect}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenMenu(feed, event.currentTarget, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenMenu(feed, event.currentTarget, bounds.left + 24, bounds.bottom - 4);
          }}
        >
          <span
            className={`status-dot ${healthClass}`}
            role="img"
            aria-label={`Feed health: ${healthLabel}`}
            title={feed.lastError ?? healthLabel}
          />
          <span className="truncate">{feed.title}</span>
          {feed.unreadCount > 0 ? <ArticleCount count={feed.unreadCount} /> : null}
        </button>
        <button
          className="feed-menu-button"
          type="button"
          aria-label={`Manage ${feed.title}`}
          title={`Manage ${feed.title}`}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenMenu(feed, event.currentTarget, bounds.right, bounds.bottom);
          }}
        >
          <Ellipsis aria-hidden="true" size={15} />
        </button>
      </div>
    </li>
  );
}

interface ReaderToolbarProps {
  title: string;
  articleState: ArticleState;
  unreadCount: number;
  searchInput: string;
  searchActive: boolean;
  mode: ReadingMode;
  refreshing: boolean;
  markReadPending: boolean;
  navOpen: boolean;
  readingArticle: boolean;
  manualRefreshEnabled: boolean;
  onToggleNav: () => void;
  onArticleStateChange: (state: "unread" | "all") => void;
  onSearchInput: (value: string) => void;
  onSearch: (event: FormEvent) => void;
  onClearSearch: () => void;
  onModeChange: (mode: ReadingMode) => void;
  onRefresh: () => void;
  onRefreshAll: () => void;
  onMarkRead: () => void;
  onMarkReadByAge: (days: MarkReadAgeDays) => void;
  onHelp: () => void;
}

export function ReaderToolbar({
  title,
  articleState,
  unreadCount,
  searchInput,
  searchActive,
  mode,
  refreshing,
  markReadPending,
  navOpen,
  readingArticle,
  manualRefreshEnabled,
  onToggleNav,
  onArticleStateChange,
  onSearchInput,
  onSearch,
  onClearSearch,
  onModeChange,
  onRefresh,
  onRefreshAll,
  onMarkRead,
  onMarkReadByAge,
  onHelp,
}: ReaderToolbarProps) {
  const showArticleStateSwitcher =
    !readingArticle && (articleState === "unread" || articleState === "all");

  return (
    <header className={`reader-toolbar${readingArticle ? " is-reading-article" : ""}`}>
      <div className="reader-title-row">
        <IconButton
          label={navOpen ? "Close navigation" : "Open navigation"}
          onClick={onToggleNav}
          className="menu-button"
          tooltip
        >
          <Menu aria-hidden="true" size={19} />
        </IconButton>
        <div className="scope-title">
          <h1>{title}</h1>
        </div>
        {showArticleStateSwitcher ? (
          <fieldset className="segmented-control article-state-switcher">
            <legend className="sr-only">Article filter</legend>
            <button
              type="button"
              aria-pressed={articleState === "unread"}
              onClick={() => onArticleStateChange("unread")}
            >
              {unreadCount} Unread
            </button>
            <button
              type="button"
              aria-pressed={articleState === "all"}
              onClick={() => onArticleStateChange("all")}
            >
              All articles
            </button>
          </fieldset>
        ) : null}
        <form className="search-form" aria-label="Article search" onSubmit={onSearch}>
          <Search aria-hidden="true" size={16} />
          <label className="sr-only" htmlFor="article-search">
            Search articles
          </label>
          <input
            id="article-search"
            type="search"
            value={searchInput}
            placeholder="Search articles"
            onChange={(event) => onSearchInput(event.target.value)}
          />
          {searchInput || searchActive ? (
            <button type="button" onClick={onClearSearch} aria-label="Clear search">
              <X aria-hidden="true" size={15} />
            </button>
          ) : null}
          <button className="search-submit" type="submit">
            Search
          </button>
        </form>
        <fieldset className="view-switcher">
          <legend className="sr-only">Reading view</legend>
          <button
            type="button"
            aria-label="Magazine view"
            data-tooltip="Magazine view (1)"
            aria-pressed={mode === "magazine"}
            onClick={() => onModeChange("magazine")}
          >
            <LayoutList aria-hidden="true" size={16} />
          </button>
          <button
            type="button"
            aria-label="Expanded view"
            data-tooltip="Expanded view (2)"
            aria-pressed={mode === "expanded"}
            onClick={() => onModeChange("expanded")}
          >
            <FileText aria-hidden="true" size={16} />
          </button>
        </fieldset>
        {!readingArticle ? (
          <ReaderOptionsMenu
            articleState={articleState}
            unreadCount={unreadCount}
            showArticleFilters={showArticleStateSwitcher}
            mode={mode}
            onArticleStateChange={onArticleStateChange}
            onModeChange={onModeChange}
          />
        ) : null}
        <div className="toolbar-actions">
          {manualRefreshEnabled ? (
            <>
              <IconButton
                label="Refresh this view (R)"
                onClick={onRefresh}
                disabled={refreshing}
                tooltip
              >
                <RefreshCw className={refreshing ? "spin" : ""} aria-hidden="true" size={17} />
              </IconButton>
              <IconButton
                label="Refresh all feeds (Shift+R)"
                onClick={onRefreshAll}
                disabled={refreshing}
                className="refresh-all-action"
                tooltip
              >
                <Rss aria-hidden="true" size={17} />
              </IconButton>
            </>
          ) : null}
          <MarkReadSplitButton
            disabled={markReadPending}
            onMarkRead={onMarkRead}
            onMarkReadByAge={onMarkReadByAge}
          />
          <IconButton
            label="Open keyboard shortcut reference (?)"
            onClick={onHelp}
            className="help-action"
            tooltip
          >
            <CircleHelp aria-hidden="true" size={18} />
          </IconButton>
        </div>
      </div>
    </header>
  );
}

const READER_OPTIONS_MENU_ID = "reader-options-menu";

function ReaderOptionsMenu({
  articleState,
  unreadCount,
  showArticleFilters,
  mode,
  onArticleStateChange,
  onModeChange,
}: {
  articleState: ArticleState;
  unreadCount: number;
  showArticleFilters: boolean;
  mode: ReadingMode;
  onArticleStateChange: (state: "unread" | "all") => void;
  onModeChange: (mode: ReadingMode) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<"current" | "first" | "last">("current");
  const [open, setOpen] = useState(false);

  const optionButtons = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );

  const focusOption = (target: "current" | "first" | "last") => {
    const options = optionButtons();
    const current = options.find((option) => option.getAttribute("aria-checked") === "true");
    const next = target === "first" ? options[0] : target === "last" ? options.at(-1) : current;
    next?.focus({ preventScroll: true });
  };

  const closeMenu = useCallback((restoreFocus = true) => {
    const menu = menuRef.current;
    if (menu?.matches(":popover-open")) menu.hidePopover();
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenu = (target: "current" | "first" | "last") => {
    pendingFocus.current = target;
    const menu = menuRef.current;
    if (menu && !menu.matches(":popover-open")) menu.showPopover();
  };

  const handleToggle = (event: SyntheticEvent<HTMLDivElement>) => {
    const nextOpen = event.currentTarget.matches(":popover-open");
    setOpen(nextOpen);
    if (nextOpen) window.requestAnimationFrame(() => focusOption(pendingFocus.current));
  };

  const chooseArticleState = (state: "unread" | "all") => {
    closeMenu();
    onArticleStateChange(state);
  };

  const chooseMode = (nextMode: ReadingMode) => {
    closeMenu();
    onModeChange(nextMode);
  };

  const menu = (
    <div
      ref={menuRef}
      id={READER_OPTIONS_MENU_ID}
      className="reader-options-menu dropdown-select-menu dropdown-menu-surface"
      popover="auto"
      role="menu"
      aria-label="Reader options"
      onToggle={handleToggle}
      onKeyDown={(event) => handleActionMenuKeyDown(event, closeMenu)}
    >
      {showArticleFilters ? (
        <fieldset className="dropdown-select-group" aria-labelledby="article-options-label">
          <legend id="article-options-label" className="dropdown-select-group-label">
            Articles
          </legend>
          <button
            className="dropdown-select-option"
            type="button"
            role="menuitemradio"
            aria-checked={articleState === "unread"}
            onClick={() => chooseArticleState("unread")}
          >
            <span>{unreadCount} Unread</span>
            {articleState === "unread" ? <Check aria-hidden="true" size={15} /> : null}
          </button>
          <button
            className="dropdown-select-option"
            type="button"
            role="menuitemradio"
            aria-checked={articleState === "all"}
            onClick={() => chooseArticleState("all")}
          >
            <span>All articles</span>
            {articleState === "all" ? <Check aria-hidden="true" size={15} /> : null}
          </button>
        </fieldset>
      ) : null}
      <fieldset className="dropdown-select-group" aria-labelledby="view-options-label">
        <legend id="view-options-label" className="dropdown-select-group-label">
          Reading view
        </legend>
        <button
          className="dropdown-select-option"
          type="button"
          role="menuitemradio"
          aria-checked={mode === "magazine"}
          onClick={() => chooseMode("magazine")}
        >
          <span>Magazine</span>
          {mode === "magazine" ? <Check aria-hidden="true" size={15} /> : null}
        </button>
        <button
          className="dropdown-select-option"
          type="button"
          role="menuitemradio"
          aria-checked={mode === "expanded"}
          onClick={() => chooseMode("expanded")}
        >
          <span>Expanded</span>
          {mode === "expanded" ? <Check aria-hidden="true" size={15} /> : null}
        </button>
      </fieldset>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        className="icon-button reader-options-trigger"
        type="button"
        aria-label="Reader options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={READER_OPTIONS_MENU_ID}
        popoverTarget={READER_OPTIONS_MENU_ID}
        onPointerDown={() => {
          pendingFocus.current = "current";
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openMenu(event.key === "ArrowDown" ? "first" : "last");
        }}
      >
        <Ellipsis aria-hidden="true" size={18} />
      </button>
      {typeof document === "undefined" ? null : createPortal(menu, document.body)}
    </>
  );
}

const MARK_READ_AGE_LABELS: Record<MarkReadAgeDays, string> = {
  1: "Older than a day",
  2: "Older than two days",
  3: "Older than three days",
  7: "Older than a week",
  14: "Older than two weeks",
};

const MARK_READ_MENU_ID = "mark-read-age-menu";
const MARK_READ_MENU_HEADING_ID = "mark-read-age-menu-heading";

function MarkReadSplitButton({
  disabled,
  onMarkRead,
  onMarkReadByAge,
}: {
  disabled: boolean;
  onMarkRead: () => void;
  onMarkReadByAge: (days: MarkReadAgeDays) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    right: number;
    maxHeight: number;
  } | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPresence = useMotionPresence(menuOpen);

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const positionMenu = useCallback(() => {
    const control = controlRef.current;
    if (!control) return;
    const bounds = control.getBoundingClientRect();
    setMenuPosition({
      top: bounds.bottom + 6,
      right: Math.max(8, window.innerWidth - bounds.right),
      maxHeight: Math.max(120, window.innerHeight - bounds.bottom - 14),
    });
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    positionMenu();

    const dismissOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (controlRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const dismissOnFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (controlRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };

    document.addEventListener("pointerdown", dismissOnPointerDown, true);
    document.addEventListener("focusin", dismissOnFocus, true);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", positionMenu);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown, true);
      document.removeEventListener("focusin", dismissOnFocus, true);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", positionMenu);
    };
  }, [closeMenu, menuOpen, positionMenu]);

  useEffect(() => {
    if (!menuOpen || !menuPosition) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menuOpen, menuPosition]);

  useEffect(() => {
    if (disabled && menuOpen) closeMenu();
  }, [closeMenu, disabled, menuOpen]);

  useEffect(() => {
    if (!menuPresence.present) setMenuPosition(null);
  }, [menuPresence.present]);

  const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!menuRef.current) return;
    const items = [...menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  return (
    <div className="mark-read-split-button" ref={controlRef}>
      <IconButton
        label="Mark loaded articles as read"
        onClick={onMarkRead}
        disabled={disabled}
        className="mark-read-primary"
        tooltip
      >
        <CheckCheckIcon />
      </IconButton>
      <button
        ref={triggerRef}
        className="icon-button mark-read-menu-trigger"
        type="button"
        aria-label="Mark older articles as read"
        data-tooltip="Mark older articles as read"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={MARK_READ_MENU_ID}
        disabled={disabled}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {menuPresence.present && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              id={MARK_READ_MENU_ID}
              className="mark-read-menu context-action-menu"
              data-state={menuPresence.state}
              role="menu"
              aria-labelledby={MARK_READ_MENU_HEADING_ID}
              inert={menuPresence.state === "closed"}
              style={menuPosition}
              onKeyDown={moveMenuFocus}
            >
              <p id={MARK_READ_MENU_HEADING_ID}>Mark older articles as read</p>
              {MARK_READ_AGE_DAYS.map((days) => (
                <button
                  key={days}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu(true);
                    onMarkReadByAge(days);
                  }}
                >
                  {MARK_READ_AGE_LABELS[days]}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function CheckCheckIcon() {
  return (
    <span className="check-check" aria-hidden="true">
      <Check size={15} />
      <Check size={15} />
    </span>
  );
}
