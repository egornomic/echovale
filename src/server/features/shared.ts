import { telegramPostIdentity } from "../../shared/telegram.js";
import type {
  AiArticleSourceKind,
  AiProvider,
  Article,
  ArticleAiSummary,
  ArticleAiTranslation,
  ArticleMedia,
  Feed,
  FeedErrorKind,
  FeedHealthStatus,
  FeedPollIntervalMinutes,
  FeedSourceKind,
  Folder,
  FolderSortDirection,
  Rule,
  RuleAction,
  RuleCondition,
  RuleConditionOperator,
  WebFeedConfig,
} from "../../shared/types.js";
import { InvalidRequestError } from "../errors.js";

interface FeedRecordBase {
  id: number;
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  etag: string | null;
  lastModified: string | null;
  pollIntervalMinutes: FeedPollIntervalMinutes;
}

export type FeedRecord =
  | (FeedRecordBase & {
      sourceKind: "published";
      webConfig: null;
      selectionRevision: null;
      lastMatchCount: null;
    })
  | (FeedRecordBase & {
      sourceKind: "web";
      webConfig: WebFeedConfig;
      selectionRevision: number;
      lastMatchCount: number;
    });

export interface ParsedArticle {
  externalId: string;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  summary: string;
  imageUrl: string | null;
  media?: ArticleMedia | null;
  feedContentHtml: string | null;
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  articles: ParsedArticle[];
}

export interface ExtractionRecord {
  id: number;
  url: string | null;
}

export interface AiArticleRecord {
  id: number;
  revision: number;
  title: string;
  url: string | null;
  author: string | null;
  media: ArticleMedia | null;
  contentHtml: string | null;
  feedContentHtml: string | null;
  excerpt: string;
  currentSummary: StoredArticleAiSummary | null;
}

export interface StoredArticleAiSummary extends ArticleAiSummary {
  sourceRevision: number;
  promptVersion: number;
}

export interface StoredArticleAiTranslation extends ArticleAiTranslation {
  sourceRevision: number;
  promptVersion: number;
}

export type Row = Record<string, unknown>;

export const WEB_FEED_POLL_INTERVAL_MINUTES = 60;
export const feedPollIntervalSql = "feed_sources.poll_interval_minutes";

export function now(): string {
  return new Date().toISOString();
}

interface ArticleCursorBoundary {
  sortAt: string;
  id: number;
  consumed: number;
}

export type ArticleCursor = Map<string, ArticleCursorBoundary>;

export function decodeArticleCursor(cursor: string): ArticleCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value)) throw new Error("Invalid cursor fields");
    const boundaries: ArticleCursor = new Map();
    for (const boundary of value) {
      if (
        !Array.isArray(boundary) ||
        boundary.length !== 4 ||
        typeof boundary[0] !== "string" ||
        typeof boundary[1] !== "string" ||
        typeof boundary[2] !== "number" ||
        !Number.isInteger(boundary[2]) ||
        typeof boundary[3] !== "number" ||
        !Number.isInteger(boundary[3]) ||
        boundary[3] < 0
      ) {
        throw new Error("Invalid cursor fields");
      }
      boundaries.set(boundary[0], {
        sortAt: boundary[1],
        id: boundary[2],
        consumed: boundary[3],
      });
    }
    return boundaries;
  } catch {
    throw new InvalidRequestError("This article page has expired. Reload the list.");
  }
}

export function encodeArticleCursor(cursor: ArticleCursor): string {
  return Buffer.from(
    JSON.stringify(
      [...cursor].map(([bucket, boundary]) => [
        bucket,
        boundary.sortAt,
        boundary.id,
        boundary.consumed,
      ]),
    ),
  ).toString("base64url");
}

export function toBoolean(value: unknown): boolean {
  return value === 1;
}

export function parseArticleMedia(value: unknown): ArticleMedia | null {
  return value === null ? null : (JSON.parse(String(value)) as ArticleMedia);
}

export function mapFolder(row: Row): Folder {
  return {
    id: Number(row.id),
    parentId: row.parentId === null ? null : Number(row.parentId),
    name: String(row.name),
    position: Number(row.position),
    sortDirection: row.sortDirection as FolderSortDirection,
    unreadCount: Number(row.unreadCount),
  };
}

export function mapFeed(row: Row): Feed {
  return {
    id: Number(row.id),
    folderId: row.folderId === null ? null : Number(row.folderId),
    title: String(row.title),
    feedUrl: String(row.feedUrl),
    siteUrl: row.siteUrl === null ? null : String(row.siteUrl),
    sourceKind: row.sourceKind as FeedSourceKind,
    healthStatus: row.healthStatus as FeedHealthStatus,
    lastErrorKind: row.lastErrorKind === null ? null : (row.lastErrorKind as FeedErrorKind),
    lastMatchCount: row.lastMatchCount === null ? null : Number(row.lastMatchCount),
    createdAt: String(row.createdAt),
    pollIntervalMinutes: Number(row.pollIntervalMinutes),
    unreadCount: Number(row.unreadCount),
    totalCount: Number(row.totalCount),
    paused: toBoolean(row.paused),
    refreshing: toBoolean(row.refreshing),
    lastPostAt: row.lastPostAt === null ? null : String(row.lastPostAt),
    lastAttemptAt: row.lastAttemptAt === null ? null : String(row.lastAttemptAt),
    lastSuccessAt: row.lastSuccessAt === null ? null : String(row.lastSuccessAt),
    lastHttpStatus: row.lastHttpStatus === null ? null : Number(row.lastHttpStatus),
    lastError: row.lastError === null ? null : String(row.lastError),
    nextPollAt: row.nextPollAt === null ? null : String(row.nextPollAt),
  };
}

export function mapFeedRecord(row: Row): FeedRecord {
  const base: FeedRecordBase = {
    id: Number(row.id),
    title: String(row.title),
    feedUrl: String(row.feedUrl),
    siteUrl: row.siteUrl === null ? null : String(row.siteUrl),
    etag: row.etag === null ? null : String(row.etag),
    lastModified: row.lastModified === null ? null : String(row.lastModified),
    pollIntervalMinutes: Number(row.pollIntervalMinutes) as FeedPollIntervalMinutes,
  };
  const sourceKind = row.sourceKind as FeedSourceKind;
  if (sourceKind === "published") {
    if (row.webConfigJson !== null) {
      throw new Error(`Published feed ${base.id} unexpectedly has a web feed configuration`);
    }
    return {
      ...base,
      sourceKind,
      webConfig: null,
      selectionRevision: null,
      lastMatchCount: null,
    };
  }
  if (sourceKind !== "web" || row.webConfigJson === null) {
    throw new Error(`Web feed ${base.id} is missing its page selection`);
  }
  return {
    ...base,
    sourceKind,
    webConfig: JSON.parse(String(row.webConfigJson)) as WebFeedConfig,
    selectionRevision: Number(row.selectionRevision),
    lastMatchCount: Number(row.lastMatchCount),
  };
}

export const feedRecordColumns = `feed_sources.id, feed_sources.title,
  feed_sources.feed_url AS feedUrl, feed_sources.site_url AS siteUrl,
  feed_sources.source_kind AS sourceKind,
  feed_sources.etag, feed_sources.last_modified AS lastModified,
  ${feedPollIntervalSql} AS pollIntervalMinutes,
  source_web_feed_configs.config_json AS webConfigJson,
  source_web_feed_configs.selection_revision AS selectionRevision,
  source_web_feed_configs.last_match_count AS lastMatchCount`;

export function mapArticle(row: Row): Article {
  const id = Number(row.id);
  const url = row.url === null ? null : String(row.url);
  return {
    id,
    feedId: Number(row.feedId),
    feedTitle: String(row.feedTitle),
    feedSourceKind: row.feedSourceKind as FeedSourceKind,
    folderId: row.folderId === null ? null : Number(row.folderId),
    title: String(row.title),
    url,
    author: row.author === null ? null : String(row.author),
    publishedAt: row.publishedAt === null ? null : String(row.publishedAt),
    discoveredAt: String(row.discoveredAt),
    summary: String(row.summary),
    imageUrl:
      row.imageUrl === null
        ? null
        : telegramPostIdentity(url)
          ? `/api/articles/${id}/telegram-media-preview`
          : String(row.imageUrl),
    media: parseArticleMedia(row.mediaJson),
    feedContentHtml: row.feedContentHtml === null ? null : String(row.feedContentHtml),
    contentHtml: row.contentHtml === null ? null : String(row.contentHtml),
    contentSource:
      row.contentSource === "article" || row.contentSource === "feed" ? row.contentSource : null,
    extractionStatus: row.extractionStatus as Article["extractionStatus"],
    extractionError: row.extractionError === null ? null : String(row.extractionError),
    aiSummary: mapArticleAiSummary(row),
    isRead: toBoolean(row.isRead),
    isStarred: toBoolean(row.isStarred),
  };
}

function mapArticleAiSummary(row: Row): ArticleAiSummary | null {
  if (row.aiSummaryText === null || row.aiSummaryText === undefined) return null;
  return {
    text: String(row.aiSummaryText),
    promptId: row.aiSummaryPromptId === null ? null : String(row.aiSummaryPromptId),
    provider: row.aiSummaryProvider as AiProvider,
    model: String(row.aiSummaryModel),
    sourceKind: row.aiSummarySourceKind as AiArticleSourceKind,
    generatedAt: String(row.aiSummaryGeneratedAt),
    usage: {
      inputTokens: row.aiSummaryInputTokens === null ? null : Number(row.aiSummaryInputTokens),
      outputTokens: row.aiSummaryOutputTokens === null ? null : Number(row.aiSummaryOutputTokens),
    },
    grounding: null,
  };
}

export function mapStoredArticleAiSummary(row: Row): StoredArticleAiSummary | null {
  const summary = mapArticleAiSummary(row);
  if (!summary) return null;
  return {
    ...summary,
    sourceRevision: Number(row.aiSummarySourceRevision),
    promptVersion: Number(row.aiSummaryPromptVersion),
  };
}

export function mapStoredArticleAiTranslation(row: Row): StoredArticleAiTranslation | null {
  if (row.aiTranslationHtml === null || row.aiTranslationHtml === undefined) return null;
  return {
    html: String(row.aiTranslationHtml),
    language: String(row.aiTranslationLanguage),
    provider: row.aiTranslationProvider as AiProvider,
    model: String(row.aiTranslationModel),
    sourceKind: row.aiTranslationSourceKind as AiArticleSourceKind,
    sourceRevision: Number(row.aiTranslationSourceRevision),
    promptVersion: Number(row.aiTranslationPromptVersion),
    generatedAt: String(row.aiTranslationGeneratedAt),
    usage: {
      inputTokens:
        row.aiTranslationInputTokens === null ? null : Number(row.aiTranslationInputTokens),
      outputTokens:
        row.aiTranslationOutputTokens === null ? null : Number(row.aiTranslationOutputTokens),
    },
  };
}

export function mapRule(row: Row): Rule {
  return {
    id: Number(row.id),
    name: String(row.name),
    feedId: row.feedId === null ? null : Number(row.feedId),
    folderId: row.folderId === null ? null : Number(row.folderId),
    conditions: JSON.parse(String(row.conditionsJson)) as RuleCondition[],
    conditionOperator: row.conditionOperator as RuleConditionOperator,
    action: row.action as RuleAction,
    enabled: toBoolean(row.enabled),
    matchedCount: Number(row.matchedCount),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export const visibleClause = `NOT EXISTS (
  SELECT 1
  FROM article_rule_matches arm
  JOIN rules hidden_rule ON hidden_rule.id = arm.rule_id
  WHERE arm.article_id = articles.id
    AND arm.feed_id = feeds.id
    AND hidden_rule.enabled = 1
    AND hidden_rule.action = 'hide'
)
AND (
  NOT EXISTS (
    SELECT 1
    FROM rules keep_rule
    WHERE keep_rule.user_id = feeds.user_id
      AND keep_rule.enabled = 1
      AND keep_rule.action = 'keep'
      AND (keep_rule.feed_id IS NULL OR keep_rule.feed_id = feeds.id)
      AND (
        keep_rule.folder_id IS NULL
        OR EXISTS (
          WITH RECURSIVE folder_tree(id) AS (
            SELECT id
            FROM folders
            WHERE id = keep_rule.folder_id AND user_id = keep_rule.user_id
            UNION ALL
            SELECT folders.id
            FROM folders
            JOIN folder_tree ON folders.parent_id = folder_tree.id
            WHERE folders.user_id = keep_rule.user_id
          )
          SELECT 1 FROM folder_tree WHERE id = feeds.folder_id
        )
      )
  )
  OR EXISTS (
    SELECT 1
    FROM article_rule_matches keep_match
    JOIN rules matched_keep_rule ON matched_keep_rule.id = keep_match.rule_id
    WHERE keep_match.article_id = articles.id
      AND keep_match.feed_id = feeds.id
      AND matched_keep_rule.enabled = 1
      AND matched_keep_rule.action = 'keep'
  )
)`;
