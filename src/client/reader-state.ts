import type {
  AppSettings,
  Article,
  ArticleQuery,
  ArticleState,
  BootstrapData,
  Folder,
  ReadingMode,
} from "../shared/types.js";
import { folderPath } from "./folder-hierarchy.js";
import type { ReaderRoute } from "./routes.js";

const FILTER_RULE_NAME_TEXT_LIMIT = 72;

export interface ArticleSettingsInvalidation {
  resetTranslationState: boolean;
  invalidatedSummaryPromptIds: ReadonlySet<string | null>;
}

export interface AppendedArticles {
  articles: Article[];
  appended: Article[];
}

export interface ArticlePageBatch {
  candidates: Article[];
  nextCursor: string | null;
}

export function appendUnseenArticles(articles: Article[], candidates: Article[]): AppendedArticles {
  const ids = new Set(articles.map((article) => article.id));
  const appended = candidates.filter((article) => {
    if (ids.has(article.id)) return false;
    ids.add(article.id);
    return true;
  });
  return {
    articles: appended.length === 0 ? articles : [...articles, ...appended],
    appended,
  };
}

export function articlesWithUpdatedState(articles: Article[], candidates: Article[]): Article[] {
  const updatedById = new Map(candidates.map((article) => [article.id, article]));
  return articles.map((article) => {
    const updated = updatedById.get(article.id);
    return updated ? { ...article, isRead: updated.isRead, isStarred: updated.isStarred } : article;
  });
}

export async function firstUnseenArticlePage(
  articles: Article[],
  cursor: string,
  loadPage: (cursor: string) => Promise<ArticlePageBatch | undefined>,
): Promise<ArticlePageBatch & { appended: Article[] }> {
  let nextCursor: string | null = cursor;
  while (nextCursor) {
    const page = await loadPage(nextCursor);
    if (!page) return { candidates: [], nextCursor, appended: [] };
    const appended = appendUnseenArticles(articles, page.candidates).appended;
    if (appended.length > 0 || page.nextCursor === null) return { ...page, appended };
    nextCursor = page.nextCursor;
  }
  return { candidates: [], nextCursor: null, appended: [] };
}

export function readerRouteForSelection(
  state: ArticleState,
  feedId: number | null,
  folderId: number | null,
  search: string,
): ReaderRoute {
  if (feedId !== null) {
    return { kind: "reader", scope: "feed", scopeId: feedId, state, search };
  }
  if (folderId !== null) {
    return { kind: "reader", scope: "folder", scopeId: folderId, state, search };
  }
  return { kind: "reader", scope: "all", scopeId: null, state, search };
}

export function articleQueryForReaderRoute(
  route: ReaderRoute,
  options: {
    limit: number;
    includeContent: boolean;
    cursor?: string;
    anchorId?: number;
  },
): ArticleQuery {
  return {
    state: route.state,
    ...(route.scope === "feed" && route.scopeId !== null ? { feedId: route.scopeId } : {}),
    ...(route.scope === "folder" && route.scopeId !== null ? { folderId: route.scopeId } : {}),
    ...(route.search ? { search: route.search } : {}),
    ...options,
  };
}

export function fullContentIdsAfterReload(
  readingMode: ReadingMode,
  articles: Article[],
  refreshedActiveArticleId: number | null,
): Set<number> {
  return new Set(
    readingMode === "expanded"
      ? articles.map((article) => article.id)
      : refreshedActiveArticleId === null
        ? []
        : [refreshedActiveArticleId],
  );
}

export function shouldAutoMarkRoutedArticleRead(
  article: Article,
  routedArticleId: number | null,
  manuallyUnreadArticleIds: ReadonlySet<number>,
): boolean {
  return (
    article.id === routedArticleId && !article.isRead && !manuallyUnreadArticleIds.has(article.id)
  );
}

export function filterRuleName(text: string): string {
  const label =
    text.length > FILTER_RULE_NAME_TEXT_LIMIT
      ? `${text.slice(0, FILTER_RULE_NAME_TEXT_LIMIT - 1).trimEnd()}…`
      : text;
  return `Filter: ${label}`;
}

export function readerScopeLabel(
  bootstrap: BootstrapData,
  feedId: number | null,
  folderId: number | null,
  state: ArticleState,
): string {
  if (feedId !== null) return bootstrap.feeds.find((feed) => feed.id === feedId)?.title ?? "Feed";
  if (folderId !== null) {
    return bootstrap.folders.find((folder) => folder.id === folderId)?.name ?? "Folder";
  }
  if (state === "read") return "Read";
  if (state === "starred") return "Saved";
  return "Feed";
}

export function readerScopeUnreadCount(
  bootstrap: BootstrapData,
  feedId: number | null,
  folderId: number | null,
): number {
  if (feedId !== null) {
    return bootstrap.feeds.find((feed) => feed.id === feedId)?.unreadCount ?? 0;
  }
  if (folderId !== null) {
    return bootstrap.folders.find((folder) => folder.id === folderId)?.unreadCount ?? 0;
  }
  return bootstrap.counts.unread;
}

function folderTreeIds(folders: Folder[], rootId: number): Set<number> {
  const ids = new Set([rootId]);
  let foundChild = true;
  while (foundChild) {
    foundChild = false;
    for (const folder of folders) {
      if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        foundChild = true;
      }
    }
  }
  return ids;
}

export function refreshFeedIds(
  bootstrap: BootstrapData,
  feedId: number | null,
  folderId: number | null,
): number[] | undefined {
  if (feedId !== null) return [feedId];
  if (folderId === null) return undefined;
  const folderIds = folderTreeIds(bootstrap.folders, folderId);
  return bootstrap.feeds
    .filter((feed) => feed.folderId !== null && folderIds.has(feed.folderId))
    .map((feed) => feed.id);
}

export function articleSettingsInvalidation(
  previous: AppSettings,
  next: AppSettings,
): ArticleSettingsInvalidation {
  const invalidatedSummaryPromptIds = new Set<string | null>();
  if (previous.summaryPrompt !== next.summaryPrompt) invalidatedSummaryPromptIds.add(null);

  const nextCustomPrompts = new Map(next.customPrompts.map((prompt) => [prompt.id, prompt.prompt]));
  for (const prompt of previous.customPrompts) {
    if (nextCustomPrompts.get(prompt.id) !== prompt.prompt) {
      invalidatedSummaryPromptIds.add(prompt.id);
    }
  }

  return {
    resetTranslationState:
      previous.translationLanguage !== next.translationLanguage ||
      previous.translationPrompt !== next.translationPrompt,
    invalidatedSummaryPromptIds,
  };
}

export function invalidateArticleSummaries(
  articles: Article[],
  promptIds: ReadonlySet<string | null>,
): Article[] {
  if (promptIds.size === 0) return articles;
  return articles.map((article) =>
    article.aiSummary && promptIds.has(article.aiSummary.promptId)
      ? { ...article, aiSummary: null }
      : article,
  );
}

export function updateBootstrapCounts(
  bootstrap: BootstrapData,
  article: Article,
  unreadDelta: number,
  starredDelta: number,
): BootstrapData {
  const affectedFolderIds = new Set(
    folderPath(article.folderId, bootstrap.folders).map((folder) => folder.id),
  );
  return {
    ...bootstrap,
    counts: {
      ...bootstrap.counts,
      unread: Math.max(0, bootstrap.counts.unread + unreadDelta),
      starred: Math.max(0, bootstrap.counts.starred + starredDelta),
    },
    feeds: bootstrap.feeds.map((feed) =>
      feed.id === article.feedId
        ? { ...feed, unreadCount: Math.max(0, feed.unreadCount + unreadDelta) }
        : feed,
    ),
    folders: bootstrap.folders.map((folder) =>
      affectedFolderIds.has(folder.id)
        ? { ...folder, unreadCount: Math.max(0, folder.unreadCount + unreadDelta) }
        : folder,
    ),
  };
}
