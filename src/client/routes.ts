import type { ArticleState } from "../shared/types.js";

export interface ReaderRoute {
  kind: "reader";
  scope: "all" | "feed" | "folder";
  scopeId: number | null;
  state: ArticleState;
  search: string;
}

interface ArticleRoute {
  kind: "article";
  articleId: number;
}

interface AddFeedRoute {
  kind: "add-feed";
  sourceUrl: string;
}

interface ManagementRoute {
  kind: "feeds" | "rules";
}

export type SettingsCategory = "appearance" | "reading" | "feeds" | "ai" | "account";

interface SettingsRoute {
  kind: "settings";
  category: SettingsCategory;
}

export type AppRoute = ReaderRoute | ArticleRoute | AddFeedRoute | ManagementRoute | SettingsRoute;

export const DEFAULT_READER_ROUTE: ReaderRoute = {
  kind: "reader",
  scope: "all",
  scopeId: null,
  state: "unread",
  search: "",
};

function normalizedBasePath(basePath: string): string {
  const withLeadingSlash = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return withLeadingSlash === "/" ? "" : withLeadingSlash.replace(/\/+$/, "");
}

function positiveId(segment: string | undefined): number | null {
  if (!segment || !/^\d+$/.test(segment)) return null;
  const id = Number(segment);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function articleState(segment: string | undefined): ArticleState | null {
  if (segment === "saved") return "starred";
  if (segment === "unread" || segment === "all" || segment === "read") return segment;
  return null;
}

function articleStateSegment(state: ArticleState): string {
  return state === "starred" ? "saved" : state;
}

function readerRoute(
  scope: ReaderRoute["scope"],
  scopeId: number | null,
  state: ArticleState,
  search: string,
): ReaderRoute {
  return { kind: "reader", scope, scopeId, state, search: search.trim() };
}

export function parseAppRoute(pathname: string, search: string, basePath: string): AppRoute {
  const base = normalizedBasePath(basePath);
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return DEFAULT_READER_ROUTE;

  const relativePath = pathname.slice(base.length).replace(/^\/+|\/+$/g, "");
  const segments = relativePath ? relativePath.split("/") : [];
  const query = new URLSearchParams(search).get("q")?.trim() ?? "";

  if (segments[0] === "feeds" && segments[1] === "add" && segments.length === 2) {
    return { kind: "add-feed", sourceUrl: "" };
  }

  if (segments[0] === "feeds" && segments[1] === "add" && segments.length >= 3) {
    try {
      const sourceUrl = decodeURIComponent(segments.slice(2).join("/"));
      if (sourceUrl) return { kind: "add-feed", sourceUrl };
    } catch {
      return DEFAULT_READER_ROUTE;
    }
  }

  if (segments[0] === "settings") {
    if (segments.length === 1) return { kind: "settings", category: "appearance" };
    const category = segments[1];
    if (
      segments.length === 2 &&
      (category === "appearance" ||
        category === "reading" ||
        category === "feeds" ||
        category === "ai" ||
        category === "account")
    ) {
      return { kind: "settings", category };
    }
  }

  if (segments.length === 1) {
    const [page] = segments;
    if (page === "feeds" || page === "rules") return { kind: page };
  }

  if (segments[0] === "articles" && segments.length === 2) {
    const state = articleState(segments[1]);
    if (state) return readerRoute("all", null, state, query);
    const id = positiveId(segments[1]);
    if (id !== null) return { kind: "article", articleId: id };
  }

  if ((segments[0] === "feeds" || segments[0] === "folders") && segments.length === 3) {
    const id = positiveId(segments[1]);
    const state = articleState(segments[2]);
    if (id !== null && state) {
      return readerRoute(segments[0] === "feeds" ? "feed" : "folder", id, state, query);
    }
  }

  return DEFAULT_READER_ROUTE;
}

export function appRoutePath(route: AppRoute): string {
  if (route.kind === "article") return `/articles/${route.articleId}`;
  if (route.kind === "add-feed") {
    return route.sourceUrl ? `/feeds/add/${encodeURIComponent(route.sourceUrl)}` : "/feeds/add";
  }
  if (route.kind === "settings") {
    return route.category === "appearance" ? "/settings" : `/settings/${route.category}`;
  }
  if (route.kind !== "reader") return `/${route.kind}`;

  const stateSegment = articleStateSegment(route.state);
  const path =
    route.scope === "all"
      ? `/articles/${stateSegment}`
      : `/${route.scope === "feed" ? "feeds" : "folders"}/${route.scopeId}/${stateSegment}`;
  const query = new URLSearchParams();
  if (route.search.trim()) query.set("q", route.search.trim());
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export function routeAfterFeedDeletion(
  currentRoute: AppRoute,
  readerRoute: ReaderRoute,
  feedId: number,
): ReaderRoute | null {
  const nextRoute =
    readerRoute.scope === "feed" && readerRoute.scopeId === feedId
      ? { ...readerRoute, scope: "all" as const, scopeId: null }
      : readerRoute;
  if (currentRoute.kind === "article") return nextRoute;
  return currentRoute.kind === "reader" && appRoutePath(currentRoute) !== appRoutePath(nextRoute)
    ? nextRoute
    : null;
}

export function appRouteUrl(route: AppRoute, basePath: string): string {
  return `${normalizedBasePath(basePath)}${appRoutePath(route)}`;
}
