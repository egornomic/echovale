import { useEffect, useState } from "react";
import type { ReadingMode } from "../shared/types.js";

export type Theme = "auto" | "dark" | "light";
type ResolvedTheme = Exclude<Theme, "auto">;

export const ARTICLE_FONT_MIN = 16;
export const ARTICLE_FONT_MAX = 23;
const ARTICLE_FONT_DEFAULT = 18;

function storedValue<T extends string>(key: string, fallback: T): T {
  const value = window.localStorage.getItem(key);
  return (value as T | null) ?? fallback;
}

function storedNumber(key: string, fallback: number): number {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? value : fallback;
}

function storedBoolean(key: string, fallback: boolean): boolean {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return fallback;
  return stored === "true";
}

function accountStorageKey(userId: string, setting: string): string {
  return `feedfold-account-${userId}-${setting}`;
}

export function clearReaderPreferences(userId: string): void {
  for (const setting of [
    "reading-mode",
    "theme",
    "article-font-size",
    "desktop-sidebar-collapsed",
  ]) {
    window.localStorage.removeItem(accountStorageKey(userId, setting));
  }
}

export function resolveTheme(theme: Theme, prefersLight: boolean): ResolvedTheme {
  if (theme !== "auto") return theme;
  return prefersLight ? "light" : "dark";
}

export function useReaderPreferences(userId: string) {
  const [readingMode, setReadingMode] = useState<ReadingMode>(() =>
    storedValue<ReadingMode>(accountStorageKey(userId, "reading-mode"), "magazine"),
  );
  const [theme, setTheme] = useState<Theme>(() =>
    storedValue<Theme>(accountStorageKey(userId, "theme"), "dark"),
  );
  const [articleFontSize, setArticleFontSize] = useState(() =>
    Math.min(
      ARTICLE_FONT_MAX,
      Math.max(
        ARTICLE_FONT_MIN,
        storedNumber(accountStorageKey(userId, "article-font-size"), ARTICLE_FONT_DEFAULT),
      ),
    ),
  );
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(() =>
    storedBoolean(accountStorageKey(userId, "desktop-sidebar-collapsed"), false),
  );

  useEffect(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: light)");
    const applyTheme = () => {
      document.documentElement.dataset.theme = resolveTheme(theme, colorScheme.matches);
    };

    applyTheme();
    window.localStorage.setItem(accountStorageKey(userId, "theme"), theme);

    if (theme !== "auto") return;
    colorScheme.addEventListener("change", applyTheme);
    return () => colorScheme.removeEventListener("change", applyTheme);
  }, [theme, userId]);

  useEffect(() => {
    document.documentElement.style.setProperty("--article-font-size", `${articleFontSize}px`);
    window.localStorage.setItem(
      accountStorageKey(userId, "article-font-size"),
      String(articleFontSize),
    );
  }, [articleFontSize, userId]);

  useEffect(() => {
    window.localStorage.setItem(accountStorageKey(userId, "reading-mode"), readingMode);
  }, [readingMode, userId]);

  useEffect(() => {
    window.localStorage.setItem(
      accountStorageKey(userId, "desktop-sidebar-collapsed"),
      String(desktopSidebarCollapsed),
    );
  }, [desktopSidebarCollapsed, userId]);

  return {
    readingMode,
    setReadingMode,
    theme,
    setTheme,
    articleFontSize,
    setArticleFontSize,
    desktopSidebarCollapsed,
    setDesktopSidebarCollapsed,
  };
}
