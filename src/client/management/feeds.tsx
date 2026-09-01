import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Folder as FolderIcon,
  FolderPlus,
  Globe2,
  GripVertical,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  MousePointer2,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Send,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SVGProps,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  BootstrapData,
  Feed,
  FeedPreview,
  Folder,
  FolderSortDirection,
  WebFeedAnalysis,
  WebPageFeedDiscovery,
} from "../../shared/types";
import { api, errorMessage } from "../api";
import type { ReaderDataMutations } from "../data-resource";
import { DropdownSelect } from "../dropdown";
import { type FeedDragState, type FeedDropTarget, feedDropTarget, useFeedDrag } from "../feed-drag";
import { FeedEntriesPreview } from "../feed-entries-preview";
import {
  type FeedStatusFilter,
  type FeedTypeFilter,
  filterFeeds,
  visibleFeedStatus,
} from "../feed-filters";
import {
  FeedActionMenuItems,
  type FeedManagementAction,
  FolderActionMenuItems,
  type FolderManagementAction,
  handleActionMenuKeyDown,
} from "../feed-management";
import {
  type AddFeedSourceType,
  feedSourceUrl,
  TELEGRAM_HANDLE_PATTERN,
  X_HANDLE_PATTERN,
} from "../feed-source";
import { folderBranchFeedCount, folderHierarchy, folderPathLabel } from "../folder-hierarchy";
import type { MotionState } from "../motion";
import { WebFeedSetup } from "../web-feed-setup";
import {
  ExportOpmlLink,
  formatDate,
  formatRefreshInterval,
  formatRelativeDate,
  ImportOpmlButton,
  PageHeader,
} from "./shared";
import "./feeds.css";

type FeedsPageTab = "subscriptions" | "folders";

function XLogo({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <title>X</title>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

const ADD_FEED_SOURCE_OPTIONS = [
  {
    value: "rss",
    label: "Website or feed",
    description: "Find the published feed for a website, or use a direct feed address.",
    detail: "RSS, Atom, or JSON Feed",
    recommended: true,
    icon: Rss,
  },
  {
    value: "web",
    label: "Web page",
    description: "Turn repeated links on one public page into a feed.",
    detail: "Articles, releases, listings, and more",
    recommended: false,
    icon: Globe2,
  },
  {
    value: "telegram",
    label: "Telegram channel",
    description: "Follow posts from a public Telegram channel.",
    detail: "Public channels only",
    recommended: false,
    icon: Send,
  },
  {
    value: "x",
    label: "X profile",
    description: "Follow a public X profile through Nitter RSS.",
    detail: "Public profiles only",
    recommended: false,
    icon: XLogo,
  },
] as const;

const ADD_FEED_INPUTS: Record<
  AddFeedSourceType,
  {
    label: string;
    heading: string;
    placeholder: string;
    help: string;
    prefix: string | null;
    pattern?: string;
    action: string;
    loading: string;
    add: string;
  }
> = {
  rss: {
    label: "Website or feed address",
    heading: "Which website or feed do you want to follow?",
    placeholder: "https://example.com",
    help: "Paste any public website or direct RSS, Atom, or JSON Feed address.",
    prefix: null,
    action: "Find feed",
    loading: "Finding the published feed",
    add: "Add feed",
  },
  web: {
    label: "Public page address",
    heading: "Which page contains the entries you want?",
    placeholder: "https://example.com/articles",
    help: "Choose one public page that lists repeated articles, releases, posts, or other entries.",
    prefix: null,
    action: "Find entries",
    loading: "Finding entries",
    add: "Add web feed",
  },
  telegram: {
    label: "Telegram channel handle",
    heading: "Which public Telegram channel?",
    placeholder: "durov",
    help: "Enter the public channel handle, with or without @. Links aren't supported.",
    prefix: "t.me/",
    pattern: TELEGRAM_HANDLE_PATTERN,
    action: "Preview channel",
    loading: "Loading channel",
    add: "Add Telegram feed",
  },
  x: {
    label: "X profile handle",
    heading: "Which X profile?",
    placeholder: "egornomic",
    help: "Enter the handle, with or without @. Links aren't supported. Updates come from Nitter RSS.",
    prefix: "x.com/",
    pattern: X_HANDLE_PATTERN,
    action: "Preview profile",
    loading: "Loading profile",
    add: "Add X feed",
  },
};

function handleFeedsTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : event.key === "ArrowRight"
          ? (Math.max(currentIndex, 0) + 1) % tabs.length
          : (currentIndex <= 0 ? tabs.length : currentIndex) - 1;

  event.preventDefault();
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

function feedHost(value: string): string {
  return new URL(value).hostname.replace(/^www\./, "");
}

function feedFaviconUrl(value: string): string {
  return new URL("/favicon.ico", value).toString();
}

function formatCompactRefreshInterval(minutes: number): string {
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
}

function FeedsDesignContract() {
  const markerRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    markerRef.current?.replaceChildren(
      document.createComment(`
THESIS: A compact signal ledger makes subscriptions findable and anomalies obvious; it refuses stacked mobile data cards.
OWN-WORLD: Feedfold charcoal and sparse moss, thin separators, compact controls, exception-only amber, flat rows, anchored menus.
STORY: Search or filter, scan health, repair failures in context, and open one menu for deeper management. Folders retain their own clear view.
FIRST VIEWPORT: Compact app bar, two tabs, one search/filter row, then 60–68px feed rows; Add feed stays top-right.
FORM: Grounded structure 6, flat adaptive ledger, surface seed acac87d8.
`),
    );
  }, []);
  return <span ref={markerRef} hidden data-design-contract="feeds" />;
}

function AnchoredPopover({
  label,
  triggerClassName,
  triggerContent,
  variant,
  managementTarget,
  children,
}: {
  label: string;
  triggerClassName: string;
  triggerContent: ReactNode;
  variant: "actions" | "transfer";
  managementTarget?: { kind: "feed" | "folder"; id: number };
  children: ReactNode;
}) {
  const id = useId().replace(/:/g, "");
  const menuId = `management-actions-${id}`;
  const anchorName = `--management-actions-${id}`;
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const close = () => {
    const menu = menuRef.current;
    if (menu?.matches(":popover-open")) menu.hidePopover();
  };

  const openAndFocus = () => {
    const menu = menuRef.current;
    if (menu && !menu.matches(":popover-open")) menu.showPopover();
    window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
    });
  };

  return (
    <>
      <button
        className={triggerClassName}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        popoverTarget={menuId}
        data-management-feed-id={
          managementTarget?.kind === "feed" ? managementTarget.id : undefined
        }
        data-management-folder-id={
          managementTarget?.kind === "folder" ? managementTarget.id : undefined
        }
        style={{ anchorName }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          openAndFocus();
        }}
      >
        {triggerContent}
      </button>
      <div
        ref={menuRef}
        id={menuId}
        className={`management-actions-popover dropdown-menu-surface${
          variant === "actions" ? " context-action-menu" : " feed-transfer-popover"
        }`}
        popover="auto"
        role="menu"
        aria-label={label}
        style={{ positionAnchor: anchorName }}
        onToggle={(event) => {
          const nextOpen = event.currentTarget.matches(":popover-open");
          setOpen(nextOpen);
          if (nextOpen) {
            window.requestAnimationFrame(() => {
              menuRef.current
                ?.querySelector<HTMLElement>('[role="menuitem"]')
                ?.focus({ preventScroll: true });
            });
          }
        }}
        onKeyDown={(event) => {
          handleActionMenuKeyDown(event, close);
        }}
        onClickCapture={(event) => {
          if ((event.target as Element).closest("button, a")) close();
        }}
      >
        {children}
      </div>
    </>
  );
}

function FeedTransferMenu({
  mutations,
  showToast,
}: {
  mutations: ReaderDataMutations;
  showToast: (message: string) => void;
}) {
  return (
    <AnchoredPopover
      label="Import or export feeds"
      triggerClassName="secondary-button feed-transfer-trigger"
      triggerContent={
        <>
          <MoreHorizontal aria-hidden="true" size={17} />
          <span>Import / export</span>
        </>
      }
      variant="transfer"
    >
      <ImportOpmlButton menuItem mutations={mutations} showToast={showToast} />
      <ExportOpmlLink menuItem />
    </AnchoredPopover>
  );
}

function FeedsPage({
  bootstrap,
  mutations,
  onMenu,
  onAddFeed,
  onAddFolder,
  onRefresh,
  onFeedAction,
  onFolderAction,
  onMoveFeed,
  showToast,
}: {
  bootstrap: BootstrapData;
  mutations: ReaderDataMutations;
  onMenu: () => void;
  onAddFeed: () => void;
  onAddFolder: () => void;
  onRefresh: (feedId: number) => void;
  onFeedAction: (feed: Feed, action: FeedManagementAction) => void;
  onFolderAction: (folder: Folder, action: FolderManagementAction) => void;
  onMoveFeed: (feed: Feed, folderId: number | null) => Promise<boolean>;
  showToast: (message: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<FeedsPageTab>("subscriptions");
  const [searchQuery, setSearchQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [feedTypeFilter, setFeedTypeFilter] = useState<FeedTypeFilter>("all");
  const [feedStatusFilter, setFeedStatusFilter] = useState<FeedStatusFilter>("all");
  const filteredFeeds = filterFeeds(bootstrap.feeds, bootstrap.folders, {
    query: searchQuery,
    type: feedTypeFilter,
    status: feedStatusFilter,
  });
  const filtersActive =
    searchQuery.trim() !== "" || feedTypeFilter !== "all" || feedStatusFilter !== "all";
  const activeFilterCount = Number(feedTypeFilter !== "all") + Number(feedStatusFilter !== "all");
  const publishedFeedCount = bootstrap.feeds.filter(
    (feed) => feed.sourceKind === "published",
  ).length;
  const webFeedCount = bootstrap.feeds.length - publishedFeedCount;
  const orderedFolders = folderHierarchy(bootstrap.folders);
  const rootFolders = orderedFolders.filter(({ depth }) => depth === 0).map(({ folder }) => folder);
  const feedDrag = useFeedDrag(bootstrap.feeds, onMoveFeed);
  const [expandedLocations, setExpandedLocations] = useState<Set<FeedDropTarget>>(() => new Set());
  const statusCounts: Record<Exclude<FeedStatusFilter, "all">, number> = {
    healthy: 0,
    needs_attention: 0,
    paused: 0,
    refreshing: 0,
  };
  for (const feed of bootstrap.feeds) statusCounts[visibleFeedStatus(feed)] += 1;

  const selectTab = (tab: FeedsPageTab) => {
    if (tab === activeTab) return;
    setFiltersOpen(false);
    setActiveTab(tab);
  };

  const clearFeedView = () => {
    setSearchQuery("");
    setFeedTypeFilter("all");
    setFeedStatusFilter("all");
  };

  const toggleLocation = (target: FeedDropTarget) => {
    setExpandedLocations((current) => {
      const next = new Set(current);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  };

  const revealLocation = (target: FeedDropTarget) => {
    setExpandedLocations((current) => {
      if (current.has(target)) return current;
      const next = new Set(current);
      next.add(target);
      return next;
    });
  };

  return (
    <div className="management-page feeds-management-page">
      <FeedsDesignContract />
      <PageHeader
        title="Manage feeds"
        description="Subscriptions, folders, and source health in one place."
        onMenu={onMenu}
        actions={
          activeTab === "subscriptions" ? (
            <div className="feed-page-actions">
              <FeedTransferMenu mutations={mutations} showToast={showToast} />
              <button className="primary-button" type="button" onClick={onAddFeed}>
                <Plus aria-hidden="true" size={16} />
                Add feed
              </button>
            </div>
          ) : (
            <button className="primary-button" type="button" onClick={onAddFolder}>
              <FolderPlus aria-hidden="true" size={16} />
              Add folder
            </button>
          )
        }
      />

      <div className="management-tabs-shell">
        <div
          className="management-tabs"
          role="tablist"
          aria-label="Feed management"
          onKeyDown={handleFeedsTabKeyDown}
        >
          <button
            id="subscriptions-tab"
            type="button"
            role="tab"
            aria-controls="subscriptions-panel"
            aria-selected={activeTab === "subscriptions"}
            tabIndex={activeTab === "subscriptions" ? 0 : -1}
            onClick={() => selectTab("subscriptions")}
          >
            <Rss aria-hidden="true" size={15} />
            Subscriptions
            <span className="management-tab-count">{bootstrap.feeds.length}</span>
          </button>
          <button
            id="folders-tab"
            type="button"
            role="tab"
            aria-controls="folders-panel"
            aria-selected={activeTab === "folders"}
            tabIndex={activeTab === "folders" ? 0 : -1}
            onClick={() => selectTab("folders")}
          >
            <FolderIcon aria-hidden="true" size={15} />
            Folders
            <span className="management-tab-count">{bootstrap.folders.length}</span>
          </button>
        </div>
      </div>

      {activeTab === "subscriptions" ? (
        <div
          id="subscriptions-panel"
          role="tabpanel"
          aria-labelledby="subscriptions-tab"
          className="management-tab-panel"
        >
          <section
            className="management-section feed-management-section"
            aria-labelledby="subscriptions-heading"
          >
            <h2 id="subscriptions-heading" className="sr-only">
              Subscriptions
            </h2>

            {bootstrap.feeds.length > 0 ? (
              <div className="feed-tools">
                <label className="feed-search-field">
                  <Search aria-hidden="true" size={16} />
                  <span className="sr-only">Search feeds or folders</span>
                  <input
                    type="search"
                    value={searchQuery}
                    placeholder="Search feeds or folders"
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                </label>
                <button
                  className={`secondary-button feed-filter-toggle${
                    activeFilterCount > 0 ? " has-active-filters" : ""
                  }`}
                  type="button"
                  aria-expanded={filtersOpen}
                  aria-controls="feed-filter-panel"
                  onClick={() => setFiltersOpen((current) => !current)}
                >
                  <ListFilter aria-hidden="true" size={16} />
                  Filters
                  {activeFilterCount > 0 ? (
                    <span className="filter-count">{activeFilterCount}</span>
                  ) : null}
                </button>
                <fieldset
                  id="feed-filter-panel"
                  className="feed-filter-panel"
                  data-open={filtersOpen || undefined}
                >
                  <legend className="sr-only">Filter subscriptions</legend>
                  <div className="feed-filter-field">
                    <span>Type</span>
                    <DropdownSelect
                      ariaLabel="Feed type"
                      value={feedTypeFilter}
                      options={[
                        { value: "all", label: `All types (${bootstrap.feeds.length})` },
                        { value: "published", label: `Published (${publishedFeedCount})` },
                        { value: "web", label: `Web (${webFeedCount})` },
                      ]}
                      onChange={(value) => setFeedTypeFilter(value as FeedTypeFilter)}
                    />
                  </div>
                  <div className="feed-filter-field">
                    <span>Status</span>
                    <DropdownSelect
                      ariaLabel="Feed status"
                      value={feedStatusFilter}
                      options={[
                        { value: "all", label: `All statuses (${bootstrap.feeds.length})` },
                        { value: "healthy", label: `Healthy (${statusCounts.healthy})` },
                        {
                          value: "needs_attention",
                          label: `Needs attention (${statusCounts.needs_attention})`,
                        },
                        { value: "paused", label: `Paused (${statusCounts.paused})` },
                        { value: "refreshing", label: `Refreshing (${statusCounts.refreshing})` },
                      ]}
                      onChange={(value) => setFeedStatusFilter(value as FeedStatusFilter)}
                    />
                  </div>
                  {feedTypeFilter !== "all" || feedStatusFilter !== "all" ? (
                    <button
                      className="quiet-button feed-filter-clear"
                      type="button"
                      onClick={() => {
                        setFeedTypeFilter("all");
                        setFeedStatusFilter("all");
                      }}
                    >
                      <X aria-hidden="true" size={14} />
                      Clear
                    </button>
                  ) : null}
                </fieldset>
                <p className="feed-result-count" aria-live="polite">
                  {filtersActive ? (
                    <>
                      <strong>{filteredFeeds.length}</strong> of {bootstrap.feeds.length}
                    </>
                  ) : (
                    <>
                      <strong>{bootstrap.feeds.length}</strong>{" "}
                      {bootstrap.feeds.length === 1 ? "feed" : "feeds"}
                    </>
                  )}
                </p>
              </div>
            ) : null}

            {bootstrap.feeds.length === 0 ? (
              <div className="section-empty">
                <Rss aria-hidden="true" size={22} />
                <h3>No feeds yet</h3>
                <p>Add a website or feed URL, or import subscriptions from an OPML file.</p>
                <button className="primary-button" type="button" onClick={onAddFeed}>
                  <Plus aria-hidden="true" size={16} />
                  Add your first feed
                </button>
              </div>
            ) : filteredFeeds.length === 0 ? (
              <div className="section-empty filtered-empty">
                <ListFilter aria-hidden="true" size={22} />
                <h3>No matching feeds</h3>
                <p>Try another search or reset the current filters.</p>
                <button className="secondary-button" type="button" onClick={clearFeedView}>
                  Reset view
                </button>
              </div>
            ) : (
              <div className="feed-management-list">
                <div className="feed-management-list-header" aria-hidden="true">
                  <span>Feed</span>
                  <span>Folder</span>
                  <span>Status</span>
                  <span>Update</span>
                  <span>Last Post</span>
                  <span />
                </div>
                <ul className="feed-management-rows" aria-label="Subscriptions">
                  {filteredFeeds.map((feed) => (
                    <FeedRow
                      key={feed.id}
                      feed={feed}
                      folders={bootstrap.folders}
                      manualRefreshEnabled={bootstrap.capabilities.manualRefresh}
                      onRefresh={() => onRefresh(feed.id)}
                      onAction={(action) => onFeedAction(feed, action)}
                    />
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      ) : (
        <section
          id="folders-panel"
          role="tabpanel"
          aria-labelledby="folders-tab"
          className="management-section management-tab-panel folder-management-section"
        >
          <div className="folder-section-heading">
            <div>
              <h2 id="folders-heading">Folder structure</h2>
              <p>Expand folders to see feeds, then drag a feed onto another folder.</p>
            </div>
            <span>
              {bootstrap.folders.length} {bootstrap.folders.length === 1 ? "folder" : "folders"}
              {` · ${bootstrap.feeds.length} ${bootstrap.feeds.length === 1 ? "feed" : "feeds"}`}
            </span>
          </div>
          {bootstrap.folders.length === 0 && bootstrap.feeds.length === 0 ? (
            <div className="section-empty">
              <FolderIcon aria-hidden="true" size={22} />
              <h3>No folders yet</h3>
              <p>Create a folder to group feeds. Until then, feeds remain at the top level.</p>
              <button className="secondary-button" type="button" onClick={onAddFolder}>
                <FolderPlus aria-hidden="true" size={16} />
                Add folder
              </button>
            </div>
          ) : (
            <ul
              className={`folder-management-list${feedDrag.draggedFeed ? " is-dragging-feed" : ""}`}
              aria-label="Folders and feeds"
            >
              <FolderBranch
                folder={null}
                folders={bootstrap.folders}
                feeds={bootstrap.feeds}
                expandedLocations={expandedLocations}
                feedDrag={feedDrag}
                onToggle={toggleLocation}
                onReveal={revealLocation}
                onFeedAction={onFeedAction}
                onFolderAction={onFolderAction}
              />
              {rootFolders.map((folder) => (
                <FolderBranch
                  key={folder.id}
                  folder={folder}
                  folders={bootstrap.folders}
                  feeds={bootstrap.feeds}
                  expandedLocations={expandedLocations}
                  feedDrag={feedDrag}
                  onToggle={toggleLocation}
                  onReveal={revealLocation}
                  onFeedAction={onFeedAction}
                  onFolderAction={onFolderAction}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function FeedConfirmationSettings({
  title,
  folderId,
  folders,
  disabled,
  onTitleChange,
  onFolderChange,
}: {
  title: string;
  folderId: number | null;
  folders: Folder[];
  disabled: boolean;
  onTitleChange: (title: string) => void;
  onFolderChange: (folderId: number | null) => void;
}) {
  return (
    <div className="feed-confirmation-settings">
      <label className="field">
        <span>Name</span>
        <input
          value={title}
          disabled={disabled}
          onChange={(event) => onTitleChange(event.target.value)}
        />
      </label>
      <div className="field">
        <span>Folder</span>
        <DropdownSelect
          ariaLabel="Folder"
          value={folderId === null ? "" : String(folderId)}
          disabled={disabled}
          options={[
            { value: "", label: "No folder" },
            ...folders.map((folder) => ({
              value: String(folder.id),
              label: folderPathLabel(folder.id, folders),
            })),
          ]}
          onChange={(value) => onFolderChange(value ? Number(value) : null)}
        />
      </div>
    </div>
  );
}

function FeedConfirmationBar({
  sourceType,
  title,
  folderId,
  folders,
  disabled,
  existingFeed,
  canSave,
  onCancel,
  onTitleChange,
  onFolderChange,
}: {
  sourceType: AddFeedSourceType;
  title: string;
  folderId: number | null;
  folders: Folder[];
  disabled: boolean;
  existingFeed?: Feed;
  canSave: boolean;
  onCancel: () => void;
  onTitleChange: (title: string) => void;
  onFolderChange: (folderId: number | null) => void;
}) {
  const inputConfig = ADD_FEED_INPUTS[sourceType];
  const statusTitle = existingFeed ? "Already in your feeds" : "Finish setup";
  const statusDescription = existingFeed
    ? `You already follow this source as ${existingFeed.title}.`
    : "Give the feed a name and choose where it belongs.";
  const actionLabel = disabled
    ? `${inputConfig.add.replace(/^Add /, "Adding ")}…`
    : existingFeed
      ? "Already added"
      : inputConfig.add;

  return (
    <section
      className="feed-confirmation-bar"
      aria-label="Confirm subscription"
      data-blocked={!canSave || !!existingFeed || undefined}
    >
      <div className="feed-confirmation-status" aria-live="polite">
        {existingFeed ? (
          <CheckCircle2 aria-hidden="true" size={18} />
        ) : canSave ? (
          <Check aria-hidden="true" size={18} />
        ) : (
          <MousePointer2 aria-hidden="true" size={18} />
        )}
        <span>
          <strong>{statusTitle}</strong>
          <small>{statusDescription}</small>
        </span>
      </div>

      <FeedConfirmationSettings
        title={title}
        folderId={folderId}
        folders={folders}
        disabled={disabled || !!existingFeed}
        onTitleChange={onTitleChange}
        onFolderChange={onFolderChange}
      />

      <div className="feed-confirmation-actions">
        <button className="secondary-button" type="button" onClick={onCancel} disabled={disabled}>
          Back to feeds
        </button>
        <button
          className="primary-button"
          type="submit"
          disabled={disabled || !canSave || !!existingFeed}
        >
          {disabled ? (
            <LoaderCircle className="spin" aria-hidden="true" size={16} />
          ) : existingFeed ? (
            <Check aria-hidden="true" size={16} />
          ) : (
            <Plus aria-hidden="true" size={16} />
          )}
          {actionLabel}
        </button>
      </div>
    </section>
  );
}

function AddFeedForm({
  feeds,
  folders,
  initialSourceUrl,
  mutations,
  onCancel,
  onSaved,
}: {
  feeds: Feed[];
  folders: Folder[];
  initialSourceUrl: string;
  mutations: ReaderDataMutations;
  onCancel: () => void;
  onSaved: (feed: Feed) => Promise<void> | void;
}) {
  const [sourceType, setSourceType] = useState<AddFeedSourceType | null>(
    initialSourceUrl ? "rss" : null,
  );
  const [sourceInputs, setSourceInputs] = useState<Record<AddFeedSourceType, string>>({
    rss: initialSourceUrl,
    web: initialSourceUrl,
    telegram: "",
    x: "",
  });
  const [previewSourceType, setPreviewSourceType] = useState<AddFeedSourceType>("rss");
  const [preview, setPreview] = useState<FeedPreview | null>(null);
  const [webPage, setWebPage] = useState<WebPageFeedDiscovery | null>(null);
  const [webAnalysis, setWebAnalysis] = useState<WebFeedAnalysis | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [folderId, setFolderId] = useState<number | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [analyzingWebPage, setAnalyzingWebPage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const sourceHeadingRef = useRef<HTMLHeadingElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const flowRef = useRef<HTMLElement>(null);
  const previewFocusFrame = useRef<number | null>(null);
  const autoDiscoveryStarted = useRef(false);
  const sourceInput = sourceType ? sourceInputs[sourceType] : "";
  const inputConfig = sourceType ? ADD_FEED_INPUTS[sourceType] : null;
  const sourceOption = sourceType
    ? ADD_FEED_SOURCE_OPTIONS.find((option) => option.value === sourceType)
    : null;
  const SelectedSourceIcon = sourceOption?.icon ?? Rss;
  const SourcePreviewIcon =
    ADD_FEED_SOURCE_OPTIONS.find((option) => option.value === previewSourceType)?.icon ?? Rss;
  const selectedCandidate =
    webAnalysis?.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  const currentSourceUrl = preview?.feedUrl ?? webAnalysis?.pageUrl ?? webPage?.pageUrl;
  const existingFeed = currentSourceUrl
    ? feeds.find((feed) => feed.feedUrl === currentSourceUrl)
    : undefined;
  const stageKey =
    sourceType === null
      ? "source"
      : discovering || analyzingWebPage
        ? "loading"
        : preview
          ? "published-review"
          : webAnalysis
            ? "web-review"
            : webPage
              ? "web-offer"
              : "address";

  useLayoutEffect(() => {
    void stageKey;
    const scrollContainer = flowRef.current?.closest<HTMLElement>(".management-page");
    if (scrollContainer) scrollContainer.scrollTop = 0;
  }, [stageKey]);

  useEffect(
    () => () => {
      if (previewFocusFrame.current !== null) {
        window.cancelAnimationFrame(previewFocusFrame.current);
      }
    },
    [],
  );

  const clearDiscoveryResult = () => {
    setPreview(null);
    setWebPage(null);
    setWebAnalysis(null);
    setSelectedCandidateId(null);
    setTitle("");
    setError(null);
  };

  const selectSourceType = (nextSourceType: AddFeedSourceType) => {
    if (nextSourceType === sourceType) return;
    if (
      (nextSourceType === "rss" || nextSourceType === "web") &&
      sourceType !== null &&
      (sourceType === "rss" || sourceType === "web") &&
      !sourceInputs[nextSourceType]
    ) {
      setSourceInputs((current) => ({
        ...current,
        [nextSourceType]: current[sourceType],
      }));
    }
    setSourceType(nextSourceType);
    clearDiscoveryResult();
    window.requestAnimationFrame(() => addressInputRef.current?.focus());
  };

  const chooseAnotherSource = () => {
    clearDiscoveryResult();
    setSourceType(null);
    window.requestAnimationFrame(() => sourceHeadingRef.current?.focus());
  };

  const editAddress = () => {
    clearDiscoveryResult();
    window.requestAnimationFrame(() => addressInputRef.current?.focus());
  };

  const discover = useCallback(async (url: string, requestedSourceType: AddFeedSourceType) => {
    if (previewFocusFrame.current !== null) {
      window.cancelAnimationFrame(previewFocusFrame.current);
      previewFocusFrame.current = null;
    }
    setDiscovering(true);
    setError(null);
    setPreview(null);
    setWebPage(null);
    setWebAnalysis(null);
    setSelectedCandidateId(null);
    try {
      const result = await api.discoverFeed(url);
      if (result.kind === "published") {
        setPreview(result.preview);
        setPreviewSourceType(requestedSourceType);
        setTitle(result.preview.title);
      } else {
        setWebPage(result);
        setTitle(result.title);
      }
      previewFocusFrame.current = window.requestAnimationFrame(() => {
        previewFocusFrame.current = null;
        previewHeadingRef.current?.focus({ preventScroll: true });
      });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    if (!initialSourceUrl || autoDiscoveryStarted.current) return;
    autoDiscoveryStarted.current = true;
    void discover(feedSourceUrl("rss", initialSourceUrl), "rss");
  }, [discover, initialSourceUrl]);

  const analyzeWebPage = async (url: string) => {
    setAnalyzingWebPage(true);
    setError(null);
    setPreview(null);
    setWebPage(null);
    setWebAnalysis(null);
    setSelectedCandidateId(null);
    try {
      const result = await api.analyzeWebPage(url);
      setWebAnalysis(result);
      setSelectedCandidateId(result.selectedCandidateId);
      setTitle(result.title);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setAnalyzingWebPage(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if ((!preview && !selectedCandidate) || existingFeed) return;
    setSaving(true);
    setError(null);
    try {
      const feed = preview
        ? await mutations.createFeed({
            title: title.trim() || preview.title,
            feedUrl: preview.feedUrl,
            siteUrl: preview.siteUrl,
            folderId,
            sourceKind: "published",
          })
        : selectedCandidate
          ? await mutations.createFeed({
              title: title.trim() || webAnalysis?.title,
              feedUrl: selectedCandidate.config.pageUrl,
              siteUrl: selectedCandidate.config.pageUrl,
              folderId,
              sourceKind: "web",
              webConfig: selectedCandidate.config,
            })
          : null;
      if (!feed) return;
      await onSaved(feed);
    } catch (error) {
      setError(`Could not add this feed. ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      ref={flowRef}
      className="add-feed-flow"
      aria-busy={discovering || analyzingWebPage || saving}
    >
      {sourceType === null ? (
        <div className="add-feed-stage add-feed-source-stage">
          <header className="add-feed-stage-heading">
            <span className="add-feed-step">Step 1 of 3 · Choose a source</span>
            <h2 ref={sourceHeadingRef} tabIndex={-1}>
              What do you want to follow?
            </h2>
            <p>Choose a source. You will preview what Feedfold found before anything is added.</p>
          </header>
          <div className="add-feed-source-list">
            {ADD_FEED_SOURCE_OPTIONS.map((option) => {
              const OptionIcon = option.icon;
              return (
                <button
                  className="add-feed-source-row"
                  data-source-type={option.value}
                  key={option.value}
                  type="button"
                  onClick={() => selectSourceType(option.value)}
                >
                  <span className="add-feed-source-mark" aria-hidden="true">
                    <OptionIcon size={19} />
                  </span>
                  <span className="add-feed-source-copy">
                    <span>
                      <strong>{option.label}</strong>
                      {option.recommended ? (
                        <span className="add-feed-recommended">Recommended</span>
                      ) : null}
                    </span>
                    <small>{option.description}</small>
                    <em>{option.detail}</em>
                  </span>
                  <ChevronRight aria-hidden="true" size={18} />
                </button>
              );
            })}
          </div>
        </div>
      ) : discovering || analyzingWebPage ? (
        <div className="add-feed-stage add-feed-loading-stage" role="status">
          <LoaderCircle className="spin" aria-hidden="true" size={24} />
          <span className="add-feed-step">Step 2 of 3 · Find the source</span>
          <h2>{analyzingWebPage ? "Finding repeatable entries" : inputConfig?.loading}</h2>
          <p>
            {analyzingWebPage
              ? "Feedfold is loading the page and looking for groups of links that repeat."
              : sourceType === "telegram"
                ? "Loading the public channel and its latest posts."
                : sourceType === "x"
                  ? "Loading the profile through Nitter RSS."
                  : "Checking the website for a published feed and loading its latest entries."}
          </p>
          <div className="feed-preview-loading-lines" aria-hidden="true">
            <div className="skeleton-line wide" />
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        </div>
      ) : preview ? (
        <form
          className="add-feed-stage feed-confirmation-form"
          onSubmit={(event) => void save(event)}
        >
          <header className="add-feed-stage-heading add-feed-review-heading">
            <div>
              <span className="add-feed-step">Step 3 of 3 · Review and add</span>
              <h2 ref={previewHeadingRef} tabIndex={-1}>
                This feed is ready
              </h2>
              <p>Check the recent entries, then choose its name and folder.</p>
            </div>
            <button className="quiet-button" type="button" onClick={editAddress}>
              <ArrowLeft aria-hidden="true" size={15} />
              Edit address
            </button>
          </header>

          {error ? (
            <div className="feed-discovery-error" role="alert">
              <AlertTriangle aria-hidden="true" size={17} />
              <span>{error}</span>
            </div>
          ) : null}

          <section className="feed-preview" aria-labelledby="feed-preview-heading">
            <div className="feed-preview-header">
              <div className="feed-preview-mark" aria-hidden="true">
                <SourcePreviewIcon size={20} />
              </div>
              <div className="feed-preview-title-copy">
                <h3 id="feed-preview-heading">{preview.title}</h3>
                <div className="feed-preview-links">
                  {preview.siteUrl ? (
                    <a href={preview.siteUrl} target="_blank" rel="noreferrer">
                      {feedHost(preview.siteUrl)}
                      <ExternalLink aria-hidden="true" size={12} />
                    </a>
                  ) : (
                    <span>{feedHost(preview.feedUrl)}</span>
                  )}
                  <span aria-hidden="true">·</span>
                  <a href={preview.feedUrl} target="_blank" rel="noreferrer">
                    Open feed source
                    <ExternalLink aria-hidden="true" size={12} />
                  </a>
                </div>
              </div>
            </div>

            <FeedEntriesPreview articles={preview.articles} totalEntries={preview.totalArticles} />

            <FeedConfirmationBar
              sourceType={previewSourceType}
              title={title}
              folderId={folderId}
              folders={folders}
              disabled={saving}
              existingFeed={existingFeed}
              canSave
              onCancel={onCancel}
              onTitleChange={setTitle}
              onFolderChange={setFolderId}
            />
          </section>
        </form>
      ) : webAnalysis ? (
        <form
          className="add-feed-stage web-feed-confirmation-form"
          onSubmit={(event) => void save(event)}
        >
          <span className="add-feed-step">Step 3 of 3 · Choose and review</span>
          {error ? (
            <div className="feed-discovery-error" role="alert">
              <AlertTriangle aria-hidden="true" size={17} />
              <span>{error}</span>
            </div>
          ) : null}
          <WebFeedSetup
            analysis={webAnalysis}
            selectedCandidateId={selectedCandidateId}
            disabled={saving}
            busyLabel="Adding web feed…"
            onSelect={setSelectedCandidateId}
            onBack={editAddress}
            confirmation={
              selectedCandidate ? (
                <>
                  {!selectedCandidate.availableFields.includes("date") ? (
                    <p className="web-feed-date-fallback">
                      These entries have no publication date. Feedfold will use the time it first
                      discovers each one.
                    </p>
                  ) : null}
                  <FeedConfirmationBar
                    sourceType="web"
                    title={title}
                    folderId={folderId}
                    folders={folders}
                    disabled={saving}
                    existingFeed={existingFeed}
                    canSave
                    onCancel={onCancel}
                    onTitleChange={setTitle}
                    onFolderChange={setFolderId}
                  />
                </>
              ) : undefined
            }
          />
        </form>
      ) : webPage ? (
        <div className="add-feed-stage">
          <header className="add-feed-stage-heading">
            <span className="add-feed-step">Step 2 of 3 · Find the source</span>
            <h2 ref={previewHeadingRef} tabIndex={-1}>
              No published feed was found
            </h2>
            <p>This page can still become a web feed by following one repeated group of entries.</p>
          </header>
          <div className="add-feed-fallback">
            <span className="add-feed-source-mark" aria-hidden="true">
              <Globe2 size={20} />
            </span>
            <div>
              <strong>Build a web feed from this page</strong>
              <p>
                Web feeds follow one public page. They cannot sign in, bypass paywalls or CAPTCHAs,
                follow pagination, or track arbitrary text or prices.
              </p>
            </div>
            <div className="add-feed-fallback-actions">
              <button className="secondary-button" type="button" onClick={editAddress}>
                Try another address
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  const pageUrl = webPage.pageUrl;
                  setSourceInputs((current) => ({ ...current, web: pageUrl }));
                  setSourceType("web");
                  void analyzeWebPage(pageUrl);
                }}
              >
                <Globe2 aria-hidden="true" size={16} />
                Choose page entries
              </button>
            </div>
          </div>
        </div>
      ) : inputConfig && sourceOption ? (
        <div className="add-feed-stage add-feed-address-stage">
          <header className="add-feed-stage-heading">
            <span className="add-feed-step">Step 2 of 3 · Enter the source</span>
            <h2>{inputConfig.heading}</h2>
            <p>{sourceOption.description}</p>
          </header>

          <div className="add-feed-selected-source">
            <span className="add-feed-source-mark" aria-hidden="true">
              <SelectedSourceIcon size={18} />
            </span>
            <span>
              <strong>{sourceOption.label}</strong>
              <small>{sourceOption.detail}</small>
            </span>
            <button className="quiet-button" type="button" onClick={chooseAnotherSource}>
              Change
            </button>
          </div>

          <form
            className="add-feed-address-form"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                const url = feedSourceUrl(sourceType, sourceInput);
                if (sourceType === "web") void analyzeWebPage(url);
                else void discover(url, sourceType);
              } catch (caught) {
                setError(errorMessage(caught));
              }
            }}
          >
            <label className="field feed-url-field">
              <span>{inputConfig.label}</span>
              <span
                className={
                  inputConfig.prefix ? "feed-source-input has-prefix" : "feed-source-input"
                }
              >
                {inputConfig.prefix ? <span aria-hidden="true">{inputConfig.prefix}</span> : null}
                <input
                  ref={addressInputRef}
                  type={sourceType === "rss" || sourceType === "web" ? "url" : "text"}
                  required
                  value={sourceInput}
                  pattern={inputConfig.pattern}
                  title={inputConfig.help}
                  placeholder={inputConfig.placeholder}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "feed-url-help feed-discovery-error" : "feed-url-help"}
                  onChange={(event) => {
                    setSourceInputs((current) => ({
                      ...current,
                      [sourceType]: event.target.value,
                    }));
                    clearDiscoveryResult();
                  }}
                />
              </span>
              <small id="feed-url-help">{inputConfig.help}</small>
            </label>

            {error ? (
              <div id="feed-discovery-error" className="feed-discovery-error" role="alert">
                <AlertTriangle aria-hidden="true" size={17} />
                <span>{error}</span>
              </div>
            ) : null}

            <button className="primary-button" type="submit" disabled={!sourceInput.trim()}>
              <Search aria-hidden="true" size={16} />
              {inputConfig.action}
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

export function AddFeedPage({
  bootstrap,
  initialSourceUrl,
  mutations,
  onMenu,
  onBack,
  showToast,
}: {
  bootstrap: BootstrapData;
  initialSourceUrl: string;
  mutations: ReaderDataMutations;
  onMenu: () => void;
  onBack: () => void;
  showToast: (message: string) => void;
}) {
  return (
    <div className="management-page add-feed-page">
      <PageHeader
        title="Add feed"
        description="Choose a source, preview what Feedfold finds, then subscribe."
        onMenu={onMenu}
        actions={
          <button
            className="secondary-button"
            type="button"
            aria-label="All feeds"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden="true" size={16} />
            <span className="add-feed-back-label">All feeds</span>
          </button>
        }
      />
      <AddFeedForm
        feeds={bootstrap.feeds}
        folders={bootstrap.folders}
        initialSourceUrl={initialSourceUrl}
        mutations={mutations}
        onCancel={onBack}
        onSaved={(feed) => {
          showToast(`Subscribed to ${feed.title}`);
          onBack();
        }}
      />
    </div>
  );
}

function feedFailureLabel(feed: Feed): string {
  if (feed.lastErrorKind === "selection_broken") return "Page changed";
  if (feed.lastErrorKind === "javascript_timeout") return "JavaScript timed out";
  if (feed.lastErrorKind === "inaccessible") return "Page inaccessible";
  if (feed.lastErrorKind === "access_blocked") return "Access blocked";
  if (feed.lastErrorKind === "unsupported_content") return "Unsupported page";
  if (feed.lastErrorKind === "timeout") return "Loading timed out";
  if (feed.lastHttpStatus) return `HTTP ${feed.lastHttpStatus}`;
  return "Refresh failed";
}

function feedStatusLabel(feed: Feed, status: ReturnType<typeof visibleFeedStatus>): string {
  if (status === "needs_attention") return feedFailureLabel(feed);
  if (status === "paused") return "Paused";
  if (status === "refreshing") return "Refreshing";
  return "Healthy";
}

function FeedSourceIcon({
  feed,
  sourceUrl,
  status,
  statusLabel,
}: {
  feed: Feed;
  sourceUrl: string;
  status: ReturnType<typeof visibleFeedStatus>;
  statusLabel: string;
}) {
  const faviconUrl = feedFaviconUrl(sourceUrl);
  const [failedFavicon, setFailedFavicon] = useState<string | null>(null);
  const fallbackLabel = Array.from(feed.title.trim())[0]?.toLocaleUpperCase() ?? "•";

  return (
    <span className="feed-source-icon">
      <span className="feed-source-icon-visual" aria-hidden="true">
        <span className="feed-source-icon-fallback">{fallbackLabel}</span>
        {failedFavicon !== faviconUrl ? (
          <img
            className="feed-source-favicon"
            src={faviconUrl}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailedFavicon(faviconUrl)}
          />
        ) : null}
      </span>
      <span className="feed-health-dot" data-status={status} role="img" aria-label={statusLabel} />
    </span>
  );
}

function FeedRow({
  feed,
  folders,
  manualRefreshEnabled,
  onRefresh,
  onAction,
}: {
  feed: Feed;
  folders: Folder[];
  manualRefreshEnabled: boolean;
  onRefresh: () => void;
  onAction: (action: FeedManagementAction) => void;
}) {
  const status = visibleFeedStatus(feed);
  const sourceUrl = feed.siteUrl ?? feed.feedUrl;
  const statusLabel = feedStatusLabel(feed, status);

  return (
    <li className="feed-management-row" data-feed-status={status}>
      <div className="feed-row-identity">
        <FeedSourceIcon
          feed={feed}
          sourceUrl={sourceUrl}
          status={status}
          statusLabel={statusLabel}
        />
        <div>
          <span className="feed-row-title">
            <strong>{feed.title}</strong>
            {feed.sourceKind === "web" ? <span className="feed-type-badge">Web</span> : null}
          </span>
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${feed.title} website`}
          >
            {feedHost(sourceUrl)}
          </a>
        </div>
      </div>
      <div className="feed-row-meta">
        <span className="feed-folder-path">{folderPathLabel(feed.folderId, folders)}</span>
        <div className="feed-health" data-status={status}>
          <span className="feed-health-label">
            {status === "needs_attention" ? (
              <AlertTriangle aria-hidden="true" size={14} />
            ) : status === "refreshing" ? (
              <LoaderCircle className="spin" aria-hidden="true" size={14} />
            ) : (
              <span className="feed-health-mini-dot" aria-hidden="true" />
            )}
            {statusLabel}
          </span>
          {feed.lastError ? <small title={feed.lastError}>{feed.lastError}</small> : null}
          {feed.lastErrorKind === "selection_broken" ? (
            <button
              className="feed-repair-button"
              type="button"
              onClick={() => onAction("selection")}
            >
              Repair
            </button>
          ) : null}
        </div>
        <span
          className="feed-update-interval"
          title={`Updates every ${formatRefreshInterval(feed.pollIntervalMinutes)}`}
        >
          <span className="sr-only">
            Updates every {formatRefreshInterval(feed.pollIntervalMinutes)}
          </span>
          <span aria-hidden="true">
            <span className="feed-mobile-meta-label">every </span>
            {formatCompactRefreshInterval(feed.pollIntervalMinutes)}
          </span>
        </span>
        <time
          className="feed-last-post"
          dateTime={feed.lastPostAt ?? undefined}
          title={formatDate(feed.lastPostAt)}
        >
          <span className="sr-only">Last post {formatRelativeDate(feed.lastPostAt)}</span>
          <span aria-hidden="true">
            <span className="feed-mobile-meta-label">post </span>
            {formatRelativeDate(feed.lastPostAt)}
          </span>
        </time>
      </div>
      <div className="feed-row-actions">
        {manualRefreshEnabled ? (
          <button
            className="feed-refresh-button"
            type="button"
            disabled={feed.refreshing || feed.paused}
            onClick={onRefresh}
            aria-label={`Refresh ${feed.title}`}
            title="Refresh feed"
          >
            <RefreshCw className={feed.refreshing ? "spin" : ""} aria-hidden="true" size={15} />
          </button>
        ) : null}
        <AnchoredPopover
          label={`${feed.title} actions`}
          triggerClassName="feed-actions-trigger"
          triggerContent={<MoreHorizontal aria-hidden="true" size={17} />}
          variant="actions"
          managementTarget={{ kind: "feed", id: feed.id }}
        >
          <FeedActionMenuItems feed={feed} onAction={onAction} />
        </AnchoredPopover>
      </div>
    </li>
  );
}

export function FolderForm({
  folders,
  initial,
  defaultParentId = null,
  motionState,
  mutations,
  onCancel,
  onSaved,
  showToast,
}: {
  folders: Folder[];
  initial?: Folder;
  defaultParentId?: number | null;
  motionState?: MotionState;
  mutations: ReaderDataMutations;
  onCancel: () => void;
  onSaved: (folder: Folder) => Promise<void> | void;
  showToast: (message: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [parentId, setParentId] = useState<number | null>(initial?.parentId ?? defaultParentId);
  const [sortDirection, setSortDirection] = useState<FolderSortDirection>(
    initial?.sortDirection ?? "newest",
  );
  const [saving, setSaving] = useState(false);
  const unavailableParentIds = new Set(initial ? [initial.id] : []);
  if (initial) {
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const folder of folders) {
        if (
          folder.parentId !== null &&
          unavailableParentIds.has(folder.parentId) &&
          !unavailableParentIds.has(folder.id)
        ) {
          unavailableParentIds.add(folder.id);
          foundDescendant = true;
        }
      }
    }
  }
  const availableParents = folders.filter((folder) => !unavailableParentIds.has(folder.id));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const folder = initial
        ? await mutations.updateFolder(initial.id, { name: name.trim(), parentId, sortDirection })
        : await mutations.createFolder({ name: name.trim(), parentId, sortDirection });
      await onSaved(folder);
    } catch (error) {
      showToast(`Could not save the folder: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className={`compact-form${motionState ? " add-folder-form" : ""}`}
      data-motion-state={motionState}
      inert={motionState === "closed" ? true : undefined}
      aria-busy={saving}
      onSubmit={(event) => void submit(event)}
    >
      <label className="field">
        <span>Folder name</span>
        <input
          data-dialog-initial-focus
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="field">
        <span>Parent folder</span>
        <DropdownSelect
          ariaLabel="Parent folder"
          value={parentId === null ? "" : String(parentId)}
          options={[
            { value: "", label: "No parent" },
            ...availableParents.map((folder) => ({
              value: String(folder.id),
              label: folderPathLabel(folder.id, folders),
            })),
          ]}
          onChange={(value) => setParentId(value ? Number(value) : null)}
        />
      </div>
      <div className="field">
        <span>Article order</span>
        <DropdownSelect
          ariaLabel="Article order"
          value={sortDirection}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]}
          onChange={(value) => setSortDirection(value as FolderSortDirection)}
        />
      </div>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary-button" type="submit" disabled={saving || !name.trim()}>
          {saving ? (
            <LoaderCircle className="spin" aria-hidden="true" size={15} />
          ) : (
            <Check aria-hidden="true" size={15} />
          )}
          {initial ? "Save folder" : "Create folder"}
        </button>
      </div>
    </form>
  );
}

function FolderFeedRow({
  feed,
  feedDrag,
  onAction,
}: {
  feed: Feed;
  feedDrag: FeedDragState;
  onAction: (action: FeedManagementAction) => void;
}) {
  const status = visibleFeedStatus(feed);
  const statusLabel = feedStatusLabel(feed, status);
  const sourceUrl = feed.siteUrl ?? feed.feedUrl;
  const dragging = feedDrag.draggedFeed?.id === feed.id;
  const moving = feedDrag.movingFeedId === feed.id;

  return (
    <li
      className={`folder-feed-row${dragging ? " is-dragging" : ""}${moving ? " is-moving" : ""}`}
      data-feed-status={status}
      aria-busy={moving || undefined}
    >
      <button
        className="folder-feed-drag-region"
        type="button"
        aria-label={`Move ${feed.title} to another folder`}
        draggable={feedDrag.movingFeedId === null}
        title={`Drag ${feed.title} to another folder`}
        onDragStart={(event) => feedDrag.start(feed, event)}
        onDragEnd={feedDrag.end}
        onClick={() => onAction("move")}
      >
        <GripVertical className="folder-feed-grip" aria-hidden="true" size={15} />
        <FeedSourceIcon
          feed={feed}
          sourceUrl={sourceUrl}
          status={status}
          statusLabel={statusLabel}
        />
        <span className="folder-feed-copy">
          <strong>{feed.title}</strong>
          <small>{feedHost(sourceUrl)}</small>
        </span>
      </button>
      <AnchoredPopover
        label={`${feed.title} actions`}
        triggerClassName="feed-actions-trigger"
        triggerContent={<MoreHorizontal aria-hidden="true" size={17} />}
        variant="actions"
        managementTarget={{ kind: "feed", id: feed.id }}
      >
        <FeedActionMenuItems feed={feed} onAction={onAction} />
      </AnchoredPopover>
    </li>
  );
}

function FolderBranch({
  folder,
  folders,
  feeds,
  expandedLocations,
  feedDrag,
  onToggle,
  onReveal,
  onFeedAction,
  onFolderAction,
}: {
  folder: Folder | null;
  folders: Folder[];
  feeds: Feed[];
  expandedLocations: ReadonlySet<FeedDropTarget>;
  feedDrag: FeedDragState;
  onToggle: (target: FeedDropTarget) => void;
  onReveal: (target: FeedDropTarget) => void;
  onFeedAction: (feed: Feed, action: FeedManagementAction) => void;
  onFolderAction: (folder: Folder, action: FolderManagementAction) => void;
}) {
  const folderId = folder?.id ?? null;
  const target = feedDropTarget(folderId);
  const topLevel = folder === null;
  const path = folder ? folderPathLabel(folder.id, folders) : "Top level";
  const childFolders = folder
    ? folders
        .filter((candidate) => candidate.parentId === folder.id)
        .sort((left, right) => left.name.localeCompare(right.name))
    : [];
  const childFeeds = feeds.filter((feed) => feed.folderId === folderId);
  const feedCount = folder ? folderBranchFeedCount(folder.id, folders, feeds) : childFeeds.length;
  const hasChildren = childFolders.length > 0 || childFeeds.length > 0;
  const expanded = expandedLocations.has(target);
  const dropAvailable = feedDrag.draggedFeed !== null && feedDrag.draggedFeed.folderId !== folderId;
  const dropActive = feedDrag.dropTarget === target;
  const branchId = `folder-branch-${target}`;

  return (
    <li className="folder-tree-branch">
      <fieldset
        className={`folder-management-row${topLevel ? " is-top-level" : ""}${dropAvailable ? " is-feed-drop-available" : ""}${dropActive ? " is-feed-drop-target" : ""}`}
        aria-label={`${path} folder`}
        onDragEnter={(event) => feedDrag.enterTarget(folderId, event)}
        onDragOver={(event) => feedDrag.enterTarget(folderId, event)}
        onDragLeave={(event) => feedDrag.leaveTarget(folderId, event)}
        onDrop={(event) => {
          void feedDrag.dropOnTarget(folderId, event).then((moved) => {
            if (moved) onReveal(target);
          });
        }}
      >
        <button
          className="folder-disclosure"
          type="button"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${path}`}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-controls={hasChildren ? branchId : undefined}
          disabled={!hasChildren}
          onClick={() => onToggle(target)}
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" size={15} />
          ) : (
            <ChevronRight aria-hidden="true" size={15} />
          )}
        </button>
        <div className="folder-row-identity" title={path}>
          {topLevel ? (
            <Rss aria-hidden="true" size={16} />
          ) : (
            <FolderIcon aria-hidden="true" size={16} />
          )}
          <span>
            <strong>{folder?.name ?? "Top level"}</strong>
            <small>
              {feedCount} {feedCount === 1 ? "feed" : "feeds"}
              {folder
                ? ` · ${folder.sortDirection === "oldest" ? "Oldest" : "Newest"} first`
                : " · No folder"}
            </small>
          </span>
        </div>
        {folder ? (
          <AnchoredPopover
            label={`${path} actions`}
            triggerClassName="folder-actions-trigger"
            triggerContent={<MoreHorizontal aria-hidden="true" size={17} />}
            variant="actions"
            managementTarget={{ kind: "folder", id: folder.id }}
          >
            <FolderActionMenuItems onAction={(action) => onFolderAction(folder, action)} />
          </AnchoredPopover>
        ) : (
          <span className="folder-row-action-space" aria-hidden="true" />
        )}
      </fieldset>
      {expanded && hasChildren ? (
        <ul id={branchId} className="folder-management-children">
          {childFolders.map((childFolder) => (
            <FolderBranch
              key={childFolder.id}
              folder={childFolder}
              folders={folders}
              feeds={feeds}
              expandedLocations={expandedLocations}
              feedDrag={feedDrag}
              onToggle={onToggle}
              onReveal={onReveal}
              onFeedAction={onFeedAction}
              onFolderAction={onFolderAction}
            />
          ))}
          {childFeeds.map((feed) => (
            <FolderFeedRow
              key={feed.id}
              feed={feed}
              feedDrag={feedDrag}
              onAction={(action) => onFeedAction(feed, action)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default FeedsPage;
