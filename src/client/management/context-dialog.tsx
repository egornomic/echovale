import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ExternalLink,
  Folder,
  LoaderCircle,
  MousePointer2,
  Pause,
  Play,
  RefreshCw,
  Rss,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  lazy,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  BootstrapData,
  Feed,
  Folder as FolderType,
  WebFeedAnalysis,
} from "../../shared/types";
import { api, errorMessage } from "../api";
import type { ReaderDataMutations } from "../data-resource";
import { DropdownSelect } from "../dropdown";
import type { ManagementRequest } from "../feed-management";
import { folderPathLabel } from "../folder-hierarchy";
import { useAnimatedDialog } from "../motion";
import { formatDate, formatRefreshInterval } from "./shared";
import "./dialogs.css";

const WebFeedSetup = lazy(async () => ({
  default: (await import("../web-feed-setup")).WebFeedSetup,
}));
const FolderForm = lazy(async () => ({
  default: (await import("./feeds")).FolderForm,
}));
const RuleForm = lazy(async () => ({
  default: (await import("./rules")).RuleForm,
}));

function firstFocusable(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    for (const candidate of document.querySelectorAll<HTMLElement>(selector)) {
      const bounds = candidate.getBoundingClientRect();
      if (
        candidate.isConnected &&
        !candidate.closest("[inert]") &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.right > 0 &&
        bounds.bottom > 0 &&
        bounds.left < window.innerWidth &&
        bounds.top < window.innerHeight &&
        (!(candidate instanceof HTMLButtonElement) || !candidate.disabled)
      ) {
        return candidate;
      }
    }
  }
  return null;
}

function DialogHeading({
  icon,
  title,
  detail,
  onClose,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClose: () => void;
}) {
  return (
    <header className="management-dialog-heading">
      <span className="dialog-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <h2 id="management-dialog-title">{title}</h2>
        <p>{detail}</p>
      </div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
        <X aria-hidden="true" size={18} />
      </button>
    </header>
  );
}

function DialogError({ message }: { message: string }) {
  return (
    <p className="management-dialog-error" role="alert">
      <AlertTriangle aria-hidden="true" size={16} />
      {message}
    </p>
  );
}

function FeedSettingsPanel({
  feed,
  mutations,
  manualRefreshEnabled,
  onClose,
  onRefresh,
  showToast,
}: {
  feed: Feed;
  mutations: ReaderDataMutations;
  manualRefreshEnabled: boolean;
  onClose: () => void;
  onRefresh: (feedId: number) => Promise<void>;
  showToast: (message: string) => void;
}) {
  const [details, setDetails] = useState(feed);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"pause" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetails(await api.feed(feed.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [feed.id]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  const togglePaused = async () => {
    setBusy("pause");
    setError(null);
    try {
      const updated = await mutations.updateFeed(details.id, { paused: !details.paused });
      setDetails(updated);
      showToast(updated.paused ? `Paused ${updated.title}` : `Resumed ${updated.title}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    setError(null);
    try {
      await onRefresh(details.id);
      setDetails(await api.feed(details.id));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const status =
    details.healthStatus === "needs_attention"
      ? "Selection needs repair"
      : details.healthStatus === "failing"
        ? "Refresh failed"
        : details.paused
          ? "Paused"
          : details.refreshing
            ? "Refreshing"
            : "Healthy";

  return (
    <>
      <div className="management-dialog-body feed-settings-body">
        {loading ? (
          <div className="feed-settings-loading" role="status" aria-label="Loading feed settings">
            <span className="skeleton-line" />
            <span className="skeleton-line" />
            <span className="skeleton-line" />
          </div>
        ) : (
          <>
            <div className="feed-settings-summary">
              <span
                className={`feed-settings-status${details.healthStatus !== "healthy" ? " has-error" : ""}`}
              >
                {details.healthStatus !== "healthy" ? (
                  <AlertTriangle aria-hidden="true" size={15} />
                ) : (
                  <CheckCircle2 aria-hidden="true" size={15} />
                )}
                {status}
              </span>
              <span>
                <strong>{details.totalCount}</strong> articles
              </span>
              <span>
                <strong>{details.unreadCount}</strong> unread
              </span>
            </div>

            <dl className="feed-settings-list">
              <div>
                <dt>{details.sourceKind === "web" ? "Webpage" : "Website"}</dt>
                <dd>
                  {details.siteUrl ? (
                    <a href={details.siteUrl} target="_blank" rel="noreferrer">
                      {details.siteUrl}
                      <ExternalLink aria-hidden="true" size={14} />
                    </a>
                  ) : (
                    <span className="muted">Not provided</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>{details.sourceKind === "web" ? "Page URL" : "Feed URL"}</dt>
                <dd>
                  <a href={details.feedUrl} target="_blank" rel="noreferrer">
                    {details.feedUrl}
                    <ExternalLink aria-hidden="true" size={14} />
                  </a>
                </dd>
              </div>
              <div>
                <dt>Subscribed</dt>
                <dd>{formatDate(details.createdAt)}</dd>
              </div>
              <div>
                <dt>Refresh interval</dt>
                <dd>Every {formatRefreshInterval(details.pollIntervalMinutes)}</dd>
              </div>
              <div>
                <dt>Last attempted refresh</dt>
                <dd>{formatDate(details.lastAttemptAt)}</dd>
              </div>
              <div>
                <dt>Last successful refresh</dt>
                <dd>{formatDate(details.lastSuccessAt)}</dd>
              </div>
              <div>
                <dt>Next scheduled refresh</dt>
                <dd>{details.paused ? "Paused" : formatDate(details.nextPollAt)}</dd>
              </div>
              <div>
                <dt>Last HTTP response</dt>
                <dd>{details.lastHttpStatus ?? "No response recorded"}</dd>
              </div>
              {details.sourceKind === "web" ? (
                <div>
                  <dt>Entries found on last success</dt>
                  <dd>{details.lastMatchCount ?? "No successful refresh yet"}</dd>
                </div>
              ) : null}
            </dl>

            {details.lastError ? <DialogError message={details.lastError} /> : null}
          </>
        )}
        {error ? <DialogError message={error} /> : null}
      </div>
      <footer className="management-dialog-footer">
        <div>
          {manualRefreshEnabled ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null || loading || details.paused}
              onClick={() => void refresh()}
            >
              {busy === "refresh" ? (
                <LoaderCircle className="spin" aria-hidden="true" size={15} />
              ) : (
                <RefreshCw aria-hidden="true" size={15} />
              )}
              Refresh feed
            </button>
          ) : null}
          <button
            className="secondary-button"
            type="button"
            disabled={busy !== null || loading}
            onClick={() => void togglePaused()}
          >
            {busy === "pause" ? (
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : details.paused ? (
              <Play aria-hidden="true" size={15} />
            ) : (
              <Pause aria-hidden="true" size={15} />
            )}
            {details.paused ? "Resume feed" : "Pause feed"}
          </button>
        </div>
        <button className="primary-button" type="button" onClick={onClose}>
          Close
        </button>
      </footer>
    </>
  );
}

function WebFeedSelectionPanel({
  feed,
  mutations,
  onClose,
  showToast,
}: {
  feed: Feed;
  mutations: ReaderDataMutations;
  onClose: () => void;
  showToast: (message: string) => void;
}) {
  const [analysis, setAnalysis] = useState<WebFeedAnalysis | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.analyzeWebFeed(feed.id);
      setAnalysis(result);
      setSelectedCandidateId(result.selectedCandidateId ?? result.suggestedCandidateIds[0] ?? null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [feed.id]);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  const saveSelection = async () => {
    const candidate = analysis?.candidates.find((item) => item.id === selectedCandidateId);
    if (!candidate) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await mutations.updateWebFeedSelection(feed.id, candidate.config);
      showToast(`Page selection updated for ${updated.title}`);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        className="management-dialog-body web-feed-selection-dialog"
        aria-busy={loading || saving}
      >
        {loading ? (
          <div className="feed-preview-loading" role="status">
            <span>Reloading the page and finding repeated entries…</span>
            <div className="feed-preview-loading-lines" aria-hidden="true">
              <div className="skeleton-line wide" />
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
            </div>
          </div>
        ) : analysis ? (
          <>
            {!analysis.savedSelectionMatched ? (
              <p className="web-feed-repair-notice" role="status">
                <AlertTriangle aria-hidden="true" size={16} />
                This page has changed, so the saved selection no longer finds entries. Choose a new
                group to repair the feed. Saved articles will remain in its history.
              </p>
            ) : null}
            <WebFeedSetup
              analysis={analysis}
              selectedCandidateId={selectedCandidateId}
              disabled={saving}
              onSelect={setSelectedCandidateId}
            />
          </>
        ) : null}
        {error ? (
          <>
            <DialogError message={error} />
            <button className="secondary-button" type="button" onClick={() => void loadPage()}>
              <RefreshCw aria-hidden="true" size={15} />
              Reload page
            </button>
          </>
        ) : null}
      </div>
      <footer className="management-dialog-footer">
        <span />
        <div>
          <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={loading || saving || !selectedCandidateId}
            onClick={() => void saveSelection()}
          >
            {saving ? (
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : (
              <Check aria-hidden="true" size={15} />
            )}
            {saving ? "Saving selection" : "Save selection"}
          </button>
        </div>
      </footer>
    </>
  );
}

function RenameFeedForm({
  feed,
  mutations,
  onClose,
  showToast,
}: {
  feed: Feed;
  mutations: ReaderDataMutations;
  onClose: () => void;
  showToast: (message: string) => void;
}) {
  const [title, setTitle] = useState(feed.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await mutations.updateFeed(feed.id, { title: title.trim() });
      showToast(`Renamed feed to ${updated.title}`);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="management-dialog-form" onSubmit={(event) => void submit(event)}>
      <div className="management-dialog-body">
        <label className="field">
          <span>Feed name</span>
          <input
            data-dialog-initial-focus
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <small>Renaming does not change the feed URL or saved articles.</small>
        </label>
        {error ? <DialogError message={error} /> : null}
      </div>
      <div className="management-dialog-footer">
        <span />
        <div>
          <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={saving || !title.trim()}>
            {saving ? (
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : (
              <Check aria-hidden="true" size={15} />
            )}
            Save name
          </button>
        </div>
      </div>
    </form>
  );
}

function MoveFeedForm({
  feed,
  folders,
  mutations,
  onClose,
  showToast,
}: {
  feed: Feed;
  folders: FolderType[];
  mutations: ReaderDataMutations;
  onClose: () => void;
  showToast: (message: string) => void;
}) {
  const [folderId, setFolderId] = useState<number | null>(feed.folderId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await mutations.updateFeed(feed.id, { folderId });
      const folderName = folders.find((folder) => folder.id === folderId)?.name ?? "Top level";
      showToast(`Moved ${feed.title} to ${folderName}`);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="management-dialog-form" onSubmit={(event) => void submit(event)}>
      <div className="management-dialog-body">
        <div className="field">
          <span>Folder</span>
          <DropdownSelect
            ariaLabel="Folder"
            initialFocus
            value={folderId === null ? "" : String(folderId)}
            options={[
              { value: "", label: "Top level" },
              ...folders.map((folder) => ({
                value: String(folder.id),
                label: folderPathLabel(folder.id, folders),
              })),
            ]}
            onChange={(value) => setFolderId(value ? Number(value) : null)}
          />
          <small>Choose a folder to move this feed, or choose Top level.</small>
        </div>
        {error ? <DialogError message={error} /> : null}
      </div>
      <div className="management-dialog-footer">
        <span />
        <div>
          <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? (
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : (
              <Folder aria-hidden="true" size={15} />
            )}
            Save folder
          </button>
        </div>
      </div>
    </form>
  );
}

function AddFeedToFolderForm({
  folder,
  feeds,
  mutations,
  onClose,
  showToast,
}: {
  folder: FolderType;
  feeds: Feed[];
  mutations: ReaderDataMutations;
  onClose: () => void;
  showToast: (message: string) => void;
}) {
  const availableFeeds = feeds.filter((feed) => feed.folderId !== folder.id);
  const [feedId, setFeedId] = useState<number | null>(availableFeeds[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (feedId === null) return;
    setSaving(true);
    setError(null);
    try {
      const feed = feeds.find((candidate) => candidate.id === feedId);
      await mutations.updateFeed(feedId, { folderId: folder.id });
      showToast(`Moved ${feed?.title ?? "feed"} to ${folder.name}`);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="management-dialog-form" onSubmit={(event) => void submit(event)}>
      <div className="management-dialog-body">
        {availableFeeds.length === 0 ? (
          <div className="management-dialog-empty">
            <CheckCircle2 aria-hidden="true" size={20} />
            <p>Every feed is already in {folder.name}.</p>
          </div>
        ) : (
          <div className="field">
            <span>Feed</span>
            <DropdownSelect
              ariaLabel="Feed"
              initialFocus
              required
              value={feedId === null ? "" : String(feedId)}
              options={availableFeeds.map((feed) => ({
                value: String(feed.id),
                label: feed.title,
              }))}
              onChange={(value) => setFeedId(Number(value))}
            />
            <small>Saving moves the selected feed to {folder.name}.</small>
          </div>
        )}
        {error ? <DialogError message={error} /> : null}
      </div>
      <div className="management-dialog-footer">
        <span />
        <div>
          <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>
            {availableFeeds.length === 0 ? "Close" : "Cancel"}
          </button>
          {availableFeeds.length > 0 ? (
            <button className="primary-button" type="submit" disabled={saving || feedId === null}>
              {saving ? (
                <LoaderCircle className="spin" aria-hidden="true" size={15} />
              ) : (
                <Folder aria-hidden="true" size={15} />
              )}
              Move to folder
            </button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

function UnsubscribeForm({
  feed,
  onClose,
  onUnsubscribe,
}: {
  feed: Feed;
  onClose: () => void;
  onUnsubscribe: (feed: Feed) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    if (await onUnsubscribe(feed)) onClose();
    else setBusy(false);
  };

  return (
    <form className="management-dialog-form" onSubmit={(event) => void submit(event)}>
      <div className="management-dialog-body unsubscribe-copy">
        <p>
          Unsubscribing deletes this feed, its stored articles, and rules that apply only to this
          feed. This cannot be undone.
        </p>
      </div>
      <div className="management-dialog-footer">
        <span />
        <div>
          <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
            Keep feed
          </button>
          <button className="danger-button" type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : (
              <Trash2 aria-hidden="true" size={15} />
            )}
            Unsubscribe from feed
          </button>
        </div>
      </div>
    </form>
  );
}

function DeleteFolderForm({
  folder,
  mutations,
  onClose,
  showToast,
}: {
  folder: FolderType;
  mutations: ReaderDataMutations;
  onClose: () => void;
  showToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await mutations.deleteFolder(folder.id);
      showToast(`Deleted folder ${folder.name}`);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <form className="management-dialog-form" onSubmit={(event) => void submit(event)}>
      <div className="management-dialog-body unsubscribe-copy">
        <p>
          Deleting this folder moves its feeds and subfolders to the top level and deletes rules
          that apply only to this folder. This cannot be undone.
        </p>
        {error ? <DialogError message={error} /> : null}
      </div>
      <div className="management-dialog-footer">
        <span />
        <div>
          <button
            className="secondary-button"
            type="button"
            data-dialog-initial-focus
            disabled={busy}
            onClick={onClose}
          >
            Keep folder
          </button>
          <button className="danger-button" type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" aria-hidden="true" size={15} />
            ) : (
              <Trash2 aria-hidden="true" size={15} />
            )}
            Delete folder
          </button>
        </div>
      </div>
    </form>
  );
}

function ContextManagementDialog({
  request,
  bootstrap,
  mutations,
  onClose,
  onRefresh,
  onUnsubscribe,
  showToast,
}: {
  request: ManagementRequest;
  bootstrap: BootstrapData;
  mutations: ReaderDataMutations;
  onClose: () => void;
  onRefresh: (feedId: number) => Promise<void>;
  onUnsubscribe: (feed: Feed) => Promise<boolean>;
  showToast: (message: string) => void;
}) {
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const closedRef = useRef(false);
  const feed =
    "feedId" in request
      ? bootstrap.feeds.find((candidate) => candidate.id === request.feedId)
      : undefined;
  const folder =
    "folderId" in request
      ? bootstrap.folders.find((candidate) => candidate.id === request.folderId)
      : "parentId" in request
        ? bootstrap.folders.find((candidate) => candidate.id === request.parentId)
        : undefined;

  const finishClose = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
    window.requestAnimationFrame(() => {
      const original = returnFocusRef.current;
      const feedSelector =
        "feedId" in request ? `[data-management-feed-id="${request.feedId}"]` : null;
      const folderId =
        "folderId" in request ? request.folderId : "parentId" in request ? request.parentId : null;
      const folderSelector = folderId === null ? null : `[data-management-folder-id="${folderId}"]`;
      const target =
        (original?.isConnected ? original : null) ??
        firstFocusable([
          ...(feedSelector ? [feedSelector] : []),
          ...(folderSelector ? [folderSelector] : []),
          ".menu-button",
          "[data-management-focus-fallback]",
        ]);
      target?.focus({ preventScroll: true });
    });
  }, [onClose, request]);

  const dialog = useAnimatedDialog(finishClose);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => {
      dialog.dialogRef.current?.querySelector<HTMLElement>("[data-dialog-initial-focus]")?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [dialog.dialogRef]);

  const close = dialog.close;
  const isRule = request.kind === "create-feed-rule" || request.kind === "create-folder-rule";
  const isWide = isRule || request.kind === "web-feed-selection";

  if (
    ("feedId" in request && !feed) ||
    (("folderId" in request || "parentId" in request) && !folder)
  ) {
    return null;
  }

  const title =
    request.kind === "feed-settings"
      ? (feed?.title ?? "Feed settings")
      : request.kind === "web-feed-selection"
        ? "Edit page selection"
        : request.kind === "rename-feed"
          ? "Rename feed"
          : request.kind === "move-feed"
            ? "Move to folder"
            : request.kind === "unsubscribe-feed"
              ? "Unsubscribe from this feed?"
              : request.kind === "create-folder"
                ? "Add folder"
                : request.kind === "folder-settings"
                  ? "Folder settings"
                  : request.kind === "delete-folder"
                    ? "Delete this folder?"
                    : request.kind === "add-feed-to-folder"
                      ? "Move feed to folder"
                      : request.kind === "add-folder"
                        ? "Add subfolder"
                        : "Create rule";
  const detail =
    request.kind === "feed-settings"
      ? "Feed details and refresh status"
      : request.kind === "web-feed-selection"
        ? (feed?.title ?? "Web feed")
        : request.kind === "create-folder"
          ? "Organize subscriptions"
          : (feed?.title ?? folder?.name ?? "Feed management");
  const icon =
    request.kind === "create-folder" ||
    request.kind === "folder-settings" ||
    request.kind === "delete-folder" ||
    request.kind === "add-feed-to-folder" ||
    request.kind === "add-folder" ? (
      request.kind === "delete-folder" ? (
        <Trash2 size={16} />
      ) : (
        <Folder size={16} />
      )
    ) : request.kind === "unsubscribe-feed" ? (
      <Trash2 size={16} />
    ) : request.kind === "web-feed-selection" ? (
      <MousePointer2 size={16} />
    ) : (
      <Rss size={16} />
    );

  return (
    <dialog
      ref={dialog.dialogRef}
      className={`management-dialog${isWide ? " is-wide" : ""}`}
      data-state={dialog.closing ? "closing" : "open"}
      inert={dialog.closing}
      aria-labelledby={isRule ? undefined : "management-dialog-title"}
      aria-label={isRule ? "Create rule" : undefined}
      onClose={dialog.handleClose}
      onCancel={dialog.handleCancel}
    >
      {isRule ? (
        <RuleForm
          bootstrap={bootstrap}
          preset={
            request.kind === "create-feed-rule"
              ? { feedId: request.feedId }
              : { folderId: request.folderId }
          }
          motionState="open"
          mutations={mutations}
          onCancel={close}
          onSaved={(rule) => {
            showToast(`Added ${rule.name}`);
            close();
          }}
          showToast={showToast}
        />
      ) : (
        <>
          <DialogHeading icon={icon} title={title} detail={detail} onClose={close} />
          {request.kind === "feed-settings" && feed ? (
            <FeedSettingsPanel
              feed={feed}
              mutations={mutations}
              manualRefreshEnabled={bootstrap.capabilities.manualRefresh}
              onClose={close}
              onRefresh={onRefresh}
              showToast={showToast}
            />
          ) : request.kind === "web-feed-selection" && feed ? (
            <WebFeedSelectionPanel
              feed={feed}
              mutations={mutations}
              onClose={close}
              showToast={showToast}
            />
          ) : request.kind === "rename-feed" && feed ? (
            <RenameFeedForm
              feed={feed}
              mutations={mutations}
              onClose={close}
              showToast={showToast}
            />
          ) : request.kind === "move-feed" && feed ? (
            <MoveFeedForm
              feed={feed}
              folders={bootstrap.folders}
              mutations={mutations}
              onClose={close}
              showToast={showToast}
            />
          ) : request.kind === "unsubscribe-feed" && feed ? (
            <UnsubscribeForm feed={feed} onClose={close} onUnsubscribe={onUnsubscribe} />
          ) : request.kind === "create-folder" ? (
            <div className="management-dialog-body">
              <FolderForm
                folders={bootstrap.folders}
                mutations={mutations}
                onCancel={close}
                onSaved={(savedFolder) => {
                  showToast(`Created ${savedFolder.name}`);
                  close();
                }}
                showToast={showToast}
              />
            </div>
          ) : request.kind === "folder-settings" && folder ? (
            <div className="management-dialog-body">
              <FolderForm
                folders={bootstrap.folders}
                initial={folder}
                mutations={mutations}
                onCancel={close}
                onSaved={(savedFolder) => {
                  showToast(`Saved ${savedFolder.name}`);
                  close();
                }}
                showToast={showToast}
              />
            </div>
          ) : request.kind === "delete-folder" && folder ? (
            <DeleteFolderForm
              folder={folder}
              mutations={mutations}
              onClose={close}
              showToast={showToast}
            />
          ) : request.kind === "add-feed-to-folder" && folder ? (
            <AddFeedToFolderForm
              folder={folder}
              feeds={bootstrap.feeds}
              mutations={mutations}
              onClose={close}
              showToast={showToast}
            />
          ) : request.kind === "add-folder" && folder ? (
            <div className="management-dialog-body">
              <FolderForm
                folders={bootstrap.folders}
                defaultParentId={folder.id}
                mutations={mutations}
                onCancel={close}
                onSaved={(savedFolder) => {
                  showToast(`Created ${savedFolder.name}`);
                  close();
                }}
                showToast={showToast}
              />
            </div>
          ) : null}
        </>
      )}
    </dialog>
  );
}

export default ContextManagementDialog;
