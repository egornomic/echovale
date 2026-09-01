export type ArticleState = "all" | "unread" | "read" | "starred";
export type FolderSortDirection = "newest" | "oldest";
export type ReadingMode = "magazine" | "expanded";
type ExtractionStatus = "pending" | "processing" | "complete" | "failed" | "feed";
export type FeedSourceKind = "published" | "web";
export type FeedHealthStatus = "healthy" | "failing" | "needs_attention";
export type FeedErrorKind =
  | "network"
  | "http"
  | "timeout"
  | "parse"
  | "inaccessible"
  | "access_blocked"
  | "javascript_timeout"
  | "unsupported_content"
  | "selection_broken";
export type RuleField = "title" | "author" | "summary" | "content" | "media" | "any";
export type RuleAction = "hide" | "keep" | "mark_read";
export type RuleConditionOperator = "and" | "or";
export type AiProvider = "gemini" | "openai" | "anthropic";
export type AiFeature = "article_summary";
export type AiArticleSourceKind = "full" | "feed" | "excerpt";
export const MARK_READ_AGE_DAYS = [1, 2, 3, 7, 14] as const;
export type MarkReadAgeDays = (typeof MARK_READ_AGE_DAYS)[number];
export const DUPLICATE_ARTICLE_WINDOW_DAYS = [1, 7, 30] as const;
export type DuplicateArticleWindowDays = (typeof DUPLICATE_ARTICLE_WINDOW_DAYS)[number];
export const FEED_POLL_INTERVAL_MINUTES = [5, 10, 20, 30, 60] as const;
export type FeedPollIntervalMinutes = (typeof FEED_POLL_INTERVAL_MINUTES)[number];

export function normalizeFeedPollInterval(minutes: number): FeedPollIntervalMinutes {
  return FEED_POLL_INTERVAL_MINUTES.find((interval) => interval >= minutes) ?? 60;
}

export interface AiModelOption {
  id: string;
  label: string;
}

interface AiProviderOption {
  id: AiProvider;
  label: string;
  configured: boolean;
  defaultModel: string;
  models: AiModelOption[];
}

export interface AiFeatureSetting {
  provider: AiProvider;
  model: string;
}

export interface AiSettings {
  credentialStorageAvailable: boolean;
  providers: AiProviderOption[];
  features: {
    articleSummary: AiFeatureSetting | null;
  };
}

export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiCustomPrompt {
  id: string;
  name: string;
  prompt: string;
}

interface AiGroundingSource {
  uri: string;
  title: string;
}

interface AiGroundingSupport {
  startIndex: number;
  endIndex: number;
  sourceIndices: number[];
}

export interface AiGrounding {
  sources: AiGroundingSource[];
  supports: AiGroundingSupport[];
  searchSuggestionsHtml: string | null;
}

export interface ArticleAiSummary {
  text: string;
  promptId: string | null;
  provider: AiProvider;
  model: string;
  sourceKind: AiArticleSourceKind;
  generatedAt: string;
  usage: AiUsage;
  grounding: AiGrounding | null;
}

export interface ArticleAiTranslation {
  html: string;
  language: string;
  provider: AiProvider;
  model: string;
  sourceKind: AiArticleSourceKind;
  generatedAt: string;
  usage: AiUsage;
}

export interface RuleCondition {
  field: RuleField;
  pattern: string;
}

export interface ArticleMedia {
  provider: "youtube";
  type: "video" | "short";
  videoId: string;
  channelId: string | null;
  embedUrl: string;
  thumbnailUrl: string;
  viewCount: number | null;
  rating: {
    average: number;
    count: number;
  } | null;
}

interface TelegramArticleMediaItem {
  kind: "image" | "video";
  sourceUrl: string;
  posterUrl: string | null;
  aspectRatio: number | null;
}

export interface TelegramArticleMedia {
  items: TelegramArticleMediaItem[];
}

export interface XArticleMedia {
  sourceUrl: string;
  posterUrl: string | null;
  aspectRatio: number | null;
}

export interface SessionUser {
  id: number;
  username: string;
}

export interface Folder {
  id: number;
  parentId: number | null;
  name: string;
  position: number;
  sortDirection: FolderSortDirection;
  unreadCount: number;
}

export interface Feed {
  id: number;
  folderId: number | null;
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  sourceKind: FeedSourceKind;
  healthStatus: FeedHealthStatus;
  lastErrorKind: FeedErrorKind | null;
  lastMatchCount: number | null;
  createdAt: string;
  pollIntervalMinutes: number;
  unreadCount: number;
  totalCount: number;
  paused: boolean;
  refreshing: boolean;
  lastPostAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  nextPollAt: string | null;
}

export interface FeedPreviewArticle {
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  summary: string;
  imageUrl: string | null;
}

export interface FeedPreview {
  feedUrl: string;
  title: string;
  siteUrl: string | null;
  totalArticles: number;
  articles: FeedPreviewArticle[];
}

interface PublishedFeedDiscovery {
  kind: "published";
  preview: FeedPreview;
}

export interface WebPageFeedDiscovery {
  kind: "web_page";
  pageUrl: string;
  title: string;
}

export type FeedDiscoveryResult = PublishedFeedDiscovery | WebPageFeedDiscovery;

export type WebFeedField = "title" | "link" | "date" | "author" | "summary" | "image";

export interface WebFeedSelectors {
  item: string;
  title: string;
  link: string;
  date: string | null;
  author: string | null;
  summary: string | null;
  image: string | null;
}

export interface WebFeedConfig {
  pageUrl: string;
  selectors: WebFeedSelectors;
}

export interface WebFeedCandidate {
  id: string;
  label: string;
  itemCount: number;
  availableFields: WebFeedField[];
  config: WebFeedConfig;
  articles: FeedPreviewArticle[];
}

export interface WebFeedAnalysis {
  pageUrl: string;
  title: string;
  snapshotId: string;
  messageToken: string;
  candidates: WebFeedCandidate[];
  suggestedCandidateIds: string[];
  selectedCandidateId: string | null;
  savedSelectionMatched: boolean;
}

export interface Article {
  id: number;
  feedId: number;
  feedTitle: string;
  feedSourceKind: FeedSourceKind;
  folderId: number | null;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  discoveredAt: string;
  summary: string;
  imageUrl: string | null;
  media: ArticleMedia | null;
  feedContentHtml: string | null;
  contentHtml: string | null;
  contentSource: "article" | "feed" | null;
  extractionStatus: ExtractionStatus;
  extractionError: string | null;
  aiSummary: ArticleAiSummary | null;
  isRead: boolean;
  isStarred: boolean;
}

export interface Rule {
  id: number;
  name: string;
  feedId: number | null;
  folderId: number | null;
  conditions: RuleCondition[];
  conditionOperator: RuleConditionOperator;
  action: RuleAction;
  enabled: boolean;
  matchedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  pollIntervalMinutes: number;
  duplicateArticleWindowDays: DuplicateArticleWindowDays;
  singleKeyShortcuts: boolean;
  markReadOnScroll: boolean;
  showYouTubeDescriptions: boolean;
  translationLanguage: string;
  summaryPrompt: string;
  translationPrompt: string;
  customPrompts: AiCustomPrompt[];
}

export interface BootstrapData {
  folders: Folder[];
  feeds: Feed[];
  settings: AppSettings;
  aiSettings: AiSettings;
  counts: {
    unread: number;
    starred: number;
    all: number;
  };
  capabilities: {
    manualRefresh: boolean;
  };
}

export interface ArticleQuery {
  state: ArticleState;
  feedId?: number;
  folderId?: number;
  search?: string;
  limit?: number;
  cursor?: string;
  anchorId?: number;
  includeContent?: boolean;
}

export interface MarkReadRequest {
  articleIds?: number[];
  feedId?: number;
  folderId?: number;
  olderThanDays?: MarkReadAgeDays;
}

export interface ArticlePage {
  articles: Article[];
  nextCursor: string | null;
  anchorIndex: number | null;
}

export interface ImportResult {
  imported: number;
  duplicates: number;
  failed: Array<{ title: string; url: string; error: string }>;
}

export interface RefreshResult {
  requested: number;
  refreshingFeedIds: number[];
}
