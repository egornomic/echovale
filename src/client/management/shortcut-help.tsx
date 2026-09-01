import { AlertTriangle, Keyboard, X } from "lucide-react";
import { useAnimatedDialog } from "../motion";
import { Kbd } from "./shared";
import "./shortcut-help.css";

const shortcuts = [
  ["J / →", "Next article"],
  ["K / ←", "Previous article"],
  ["Space", "Scroll one article page"],
  ["U", "Toggle read state"],
  ["S", "Save or remove from Saved"],
  ["C", "Copy the active article link"],
  ["O", "Open active article source"],
  ["W", "Toggle feed text and full article"],
  ["M", "Open or create a summary"],
  ["T", "Toggle article translation"],
  ["R", "Refresh the current view"],
  ["Shift R", "Refresh all feeds"],
  ["[", "Decrease article text size"],
  ["]", "Increase article text size"],
  ["1", "Magazine view"],
  ["2", "Expanded view"],
  ["?", "Show shortcut reference"],
] as const;

const refreshShortcutKeys = new Set(["R", "Shift R"]);

export function ShortcutReference({
  compact = false,
  manualRefreshEnabled = true,
}: {
  compact?: boolean;
  manualRefreshEnabled?: boolean;
}) {
  const visibleShortcuts = manualRefreshEnabled
    ? shortcuts
    : shortcuts.filter(([key]) => !refreshShortcutKeys.has(key));
  return (
    <div className={`shortcut-reference${compact ? " is-compact" : ""}`}>
      <dl>
        {visibleShortcuts.map(([key, label]) => (
          <div key={key}>
            <dt>
              <Kbd>{key}</Kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
      <div className="shortcut-groups">
        <h3>Go to</h3>
        <dl>
          <div>
            <dt>
              <Kbd>g u</Kbd>
            </dt>
            <dd>Unread</dd>
          </div>
          <div>
            <dt>
              <Kbd>g s</Kbd>
            </dt>
            <dd>Saved</dd>
          </div>
          <div>
            <dt>
              <Kbd>g a</Kbd>
            </dt>
            <dd>All articles</dd>
          </div>
          <div>
            <dt>
              <Kbd>g f</Kbd>
            </dt>
            <dd>Manage feeds</dd>
          </div>
          <div>
            <dt>
              <Kbd>g r</Kbd>
            </dt>
            <dd>Rules</dd>
          </div>
          <div>
            <dt>
              <Kbd>g ,</Kbd>
            </dt>
            <dd>Settings</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function ShortcutHelp({
  enabled,
  manualRefreshEnabled,
  onClose,
}: {
  enabled: boolean;
  manualRefreshEnabled: boolean;
  onClose: () => void;
}) {
  const dialog = useAnimatedDialog(onClose);

  return (
    <dialog
      ref={dialog.dialogRef}
      className="shortcut-dialog"
      data-state={dialog.closing ? "closing" : "open"}
      inert={dialog.closing}
      onClose={dialog.handleClose}
      onCancel={dialog.handleCancel}
      aria-labelledby="shortcut-dialog-title"
    >
      <div className="dialog-heading">
        <div>
          <span className="dialog-icon" aria-hidden="true">
            <Keyboard size={18} />
          </span>
          <h2 id="shortcut-dialog-title">Keyboard shortcuts</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={dialog.close}
          aria-label="Close shortcuts"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      {!enabled ? (
        <div className="shortcuts-disabled">
          <AlertTriangle aria-hidden="true" size={16} />
          <span>
            Single-key shortcuts are off. Turn them on in Settings; Tab navigation still works.
          </span>
        </div>
      ) : null}
      <ShortcutReference manualRefreshEnabled={manualRefreshEnabled} />
      <div className="dialog-footer">
        <p>Single-key shortcuts pause while you type in a form field.</p>
        <button className="primary-button" type="button" onClick={dialog.close}>
          Close
        </button>
      </div>
    </dialog>
  );
}

export default ShortcutHelp;
