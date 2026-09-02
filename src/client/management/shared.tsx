import { Download, LoaderCircle, Menu, Upload } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { api, appUrl, errorMessage } from "../api";
import type { ReaderDataMutations } from "../data-resource";
import { isDesktopApp } from "../desktop";
import "./common.css";

export function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatRelativeDate(value: string | null): string {
  if (!value) return "Never";
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
  if (Math.abs(seconds) < 60) return formatter.format(Math.round(seconds), "second");
  const minutes = seconds / 60;
  if (Math.abs(minutes) < 60) return formatter.format(Math.round(minutes), "minute");
  const hours = minutes / 60;
  if (Math.abs(hours) < 24) return formatter.format(Math.round(hours), "hour");
  const days = hours / 24;
  if (Math.abs(days) < 30) return formatter.format(Math.round(days), "day");
  const months = days / 30;
  if (Math.abs(months) < 12) return formatter.format(Math.round(months), "month");
  return formatter.format(Math.round(months / 12), "year");
}

export function formatRefreshInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

export function handleTabListKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
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

export function PageHeader({
  title,
  description,
  onMenu,
  actions,
}: {
  title: string;
  description: string;
  onMenu: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <button
        className="icon-button menu-button"
        type="button"
        onClick={onMenu}
        aria-label="Open navigation"
      >
        <Menu aria-hidden="true" size={19} />
      </button>
      <div className="page-header-copy">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}

export function ImportOpmlButton({
  menuItem = false,
  mutations,
  showToast,
}: {
  menuItem?: boolean;
  mutations: ReaderDataMutations;
  showToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const result = await mutations.importOpml(file);
      const notes = [`${result.imported} imported`, `${result.duplicates} duplicates`];
      if (result.failed.length > 0) notes.push(`${result.failed.length} failed`);
      showToast(`OPML imported: ${notes.join(", ")}`);
    } catch (error) {
      showToast(`Could not import OPML: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        hidden
        type="file"
        accept=".opml,.xml,text/xml,application/xml"
        onChange={(event) => void importFile(event)}
      />
      <button
        className="secondary-button"
        type="button"
        role={menuItem ? "menuitem" : undefined}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <LoaderCircle className="spin" aria-hidden="true" size={16} />
        ) : (
          <Upload aria-hidden="true" size={16} />
        )}
        {busy ? "Importing OPML" : "Import OPML"}
      </button>
    </>
  );
}

export function ExportOpmlLink({ menuItem = false }: { menuItem?: boolean } = {}) {
  const [busy, setBusy] = useState(false);
  if (isDesktopApp()) {
    const exportOpml = async () => {
      setBusy(true);
      try {
        await api.exportOpml();
      } catch (error) {
        window.alert(`Could not export OPML: ${errorMessage(error)}`);
      } finally {
        setBusy(false);
      }
    };
    return (
      <button
        className="secondary-button"
        type="button"
        role={menuItem ? "menuitem" : undefined}
        disabled={busy}
        onClick={() => void exportOpml()}
      >
        {busy ? (
          <LoaderCircle className="spin" aria-hidden="true" size={16} />
        ) : (
          <Download aria-hidden="true" size={16} />
        )}
        {busy ? "Exporting OPML" : "Export OPML"}
      </button>
    );
  }
  return (
    <a
      className="secondary-button"
      role={menuItem ? "menuitem" : undefined}
      href={appUrl("/api/opml/export")}
      download="feedfold-subscriptions.opml"
    >
      <Download aria-hidden="true" size={16} />
      Export OPML
    </a>
  );
}
