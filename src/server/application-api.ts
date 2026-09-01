import { z } from "zod";
import { AI_PROMPT_MAX_LENGTH } from "../shared/ai-prompts.js";
import type { DesktopRequest } from "../shared/desktop.js";
import { telegramPostIdentity } from "../shared/telegram.js";
import {
  type AiArticleSourceKind,
  type AiFeature,
  type AiProvider,
  type ArticleQuery,
  DUPLICATE_ARTICLE_WINDOW_DAYS,
  type DuplicateArticleWindowDays,
  FEED_POLL_INTERVAL_MINUTES,
  type FeedPollIntervalMinutes,
  MARK_READ_AGE_DAYS,
  type MarkReadAgeDays,
  type MarkReadRequest,
  type WebFeedConfig,
} from "../shared/types.js";
import { nitterVideoPostId } from "../shared/x.js";
import type { AppDatabase } from "./database.js";
import type { ExtractionQueue } from "./extraction.js";
import type { AiService } from "./features/ai/service.js";
import { discoverFeed } from "./feed-discovery.js";
import type { FeedRefreshService } from "./refresh.js";
import type { TelegramMediaService } from "./telegram-media.js";
import type { WebFeedService } from "./web-feed.js";
import type { XMediaService } from "./x-media.js";

export const LOCAL_USER_ID = 1;
const LOCAL_USER = { id: LOCAL_USER_ID, username: "On this Mac" } as const;

const id = z.number().int().positive();
const nullableId = id.nullable();
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "Enter a URL that begins with http:// or https://.");
const selector = z.string().trim().min(1).max(2_000);
const webFeedConfig = z
  .object({
    pageUrl: httpUrl,
    selectors: z
      .object({
        item: selector,
        title: selector,
        link: selector,
        date: selector.nullable(),
        author: selector.nullable(),
        summary: selector.nullable(),
        image: selector.nullable(),
      })
      .strict(),
  })
  .strict();
const articleQuery = z
  .object({
    state: z.enum(["all", "unread", "read", "starred"]).default("unread"),
    feedId: id.optional(),
    folderId: id.optional(),
    search: z.string().trim().max(300).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().min(1).max(50_000).optional(),
    anchorId: id.optional(),
    includeContent: z.boolean().optional(),
  })
  .strict();
const markReadAgeDays = z
  .number()
  .int()
  .refine(
    (value) => MARK_READ_AGE_DAYS.includes(value as MarkReadAgeDays),
    "Choose one of the available age thresholds.",
  );
const ruleCondition = z
  .object({
    field: z.enum(["title", "author", "summary", "content", "media", "any"]),
    pattern: z.string().trim().min(1).max(500),
  })
  .strict();
const ruleFields = z
  .object({
    name: z.string().trim().min(1).max(200),
    feedId: nullableId,
    folderId: nullableId,
    conditions: z.array(ruleCondition).min(1),
    conditionOperator: z.enum(["and", "or"]),
    action: z.enum(["hide", "keep", "mark_read"]),
    enabled: z.boolean(),
  })
  .strict();
const duplicateArticleWindowDays = z.custom<DuplicateArticleWindowDays>(
  (value) =>
    typeof value === "number" &&
    DUPLICATE_ARTICLE_WINDOW_DAYS.includes(value as DuplicateArticleWindowDays),
  "Choose 1, 7, or 30 days.",
);
const feedPollIntervalMinutes = z.custom<FeedPollIntervalMinutes>(
  (value) =>
    typeof value === "number" &&
    FEED_POLL_INTERVAL_MINUTES.includes(value as FeedPollIntervalMinutes),
  "Choose 5, 10, 20, 30, or 60 minutes.",
);

export class ApplicationApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApplicationApiError";
  }
}

function notFound<T>(value: T | null | undefined, resource: string): T {
  if (value === null || value === undefined) {
    throw new ApplicationApiError(404, `${resource} was not found.`);
  }
  return value;
}

function input<T>(schema: z.ZodType<T>, payload: unknown): T {
  return schema.parse(payload);
}

export interface ApplicationApiServices {
  database: AppDatabase;
  extractionQueue: ExtractionQueue;
  refreshService: FeedRefreshService;
  webFeedService: WebFeedService;
  aiService: AiService;
  telegramMediaService: TelegramMediaService;
  xMediaService: XMediaService;
  feedDiscoveryTimeoutMs?: number;
}

/**
 * The single-user application boundary used by local desktop transports.
 * It intentionally has no HTTP, cookies, or account lifecycle.
 */
export class ApplicationApi {
  readonly #database: AppDatabase;
  readonly #extractionQueue: ExtractionQueue;
  readonly #refreshService: FeedRefreshService;
  readonly #webFeedService: WebFeedService;
  readonly #ai: AiService;
  readonly #telegramMedia: TelegramMediaService;
  readonly #xMedia: XMediaService;
  readonly #feedDiscoveryTimeoutMs: number | undefined;
  readonly #userId = LOCAL_USER.id;

  constructor(services: ApplicationApiServices) {
    this.#database = services.database;
    this.#extractionQueue = services.extractionQueue;
    this.#refreshService = services.refreshService;
    this.#webFeedService = services.webFeedService;
    this.#ai = services.aiService;
    this.#telegramMedia = services.telegramMediaService;
    this.#xMedia = services.xMediaService;
    this.#feedDiscoveryTimeoutMs = services.feedDiscoveryTimeoutMs;
  }

  async invoke(request: DesktopRequest): Promise<unknown> {
    switch (request.operation) {
      case "session":
      case "login":
      case "register":
        return { user: LOCAL_USER };
      case "logout":
        return undefined;
      case "authConfig":
        return { registrationAvailable: false, passkeysAvailable: false };
      case "passkeys":
        return { passkeys: [] };
      case "changePassword":
      case "passkeyRegistrationOptions":
      case "registerPasskey":
      case "renamePasskey":
      case "deletePasskey":
      case "passkeyAuthenticationOptions":
      case "passkeyLogin":
        throw new ApplicationApiError(400, "Account authentication is managed by macOS.");
      case "bootstrap":
        return {
          ...this.#database.bootstrap.getBootstrap(this.#userId),
          aiSettings: this.#ai.getSettings(this.#userId),
        };
      case "articles":
        return this.#database.articles.listArticlePage(
          this.#userId,
          input(articleQuery, request.payload) as ArticleQuery,
        );
      case "article": {
        const body = input(z.object({ id }).strict(), request.payload);
        return notFound(this.#database.articles.getArticle(this.#userId, body.id), "Article");
      }
      case "telegramArticleMedia": {
        const body = input(z.object({ id }).strict(), request.payload);
        const items = await this.#telegramItems(body.id);
        return {
          items: items.map((item) => ({
            kind: item.kind,
            sourceUrl: item.url,
            posterUrl: item.kind === "video" ? item.posterUrl : null,
            aspectRatio: item.aspectRatio,
          })),
        };
      }
      case "xArticleMedia": {
        const body = input(z.object({ id }).strict(), request.payload);
        const media = await this.#xMediaForArticle(body.id);
        return {
          sourceUrl: media.url,
          posterUrl: media.posterUrl,
          aspectRatio: media.aspectRatio,
        };
      }
      case "loadFullContent": {
        const body = input(z.object({ id }).strict(), request.payload);
        notFound(this.#database.articles.getArticle(this.#userId, body.id), "Article");
        if (this.#database.extractions.requestExtraction(this.#userId, body.id)) {
          this.#extractionQueue.prioritize(body.id);
        }
        return this.#database.articles.getArticle(this.#userId, body.id);
      }
      case "summarizeArticle": {
        const body = input(
          z.object({ id, promptId: z.uuid().nullable(), regenerate: z.boolean() }).strict(),
          request.payload,
        );
        return notFound(
          await this.#ai.summarizeArticle(this.#userId, body.id, body.promptId, body.regenerate),
          "Article",
        );
      }
      case "translateArticle": {
        const body = input(
          z.object({ id, sourceKind: z.enum(["full", "feed", "excerpt"]) }).strict(),
          request.payload,
        );
        return notFound(
          await this.#ai.translateArticle(
            this.#userId,
            body.id,
            body.sourceKind as AiArticleSourceKind,
          ),
          "Article",
        );
      }
      case "updateArticleState": {
        const body = input(
          z
            .object({
              id,
              state: z
                .object({ isRead: z.boolean().optional(), isStarred: z.boolean().optional() })
                .strict(),
            })
            .strict()
            .refine(
              ({ state }) => state.isRead !== undefined || state.isStarred !== undefined,
              "Choose whether to update read state or saved state.",
            ),
          request.payload,
        );
        return notFound(
          this.#database.articles.updateArticleState(this.#userId, body.id, body.state),
          "Article",
        );
      }
      case "markRead": {
        const body = input(
          z
            .object({
              articleIds: z.array(id).max(1_000).optional(),
              feedId: id.optional(),
              folderId: id.optional(),
              olderThanDays: markReadAgeDays.optional(),
            })
            .strict(),
          request.payload ?? {},
        ) as MarkReadRequest;
        return { updated: this.#database.articles.markArticlesRead(this.#userId, body) };
      }
      case "refresh": {
        const body = input(
          z.object({ feedIds: z.array(id).max(1_000).optional() }).strict(),
          request.payload ?? {},
        );
        return this.#refreshService.request(
          this.#database.feeds.getUserRefreshFeedIds(this.#userId, body.feedIds),
        );
      }
      case "discoverFeed": {
        const body = input(z.object({ url: httpUrl }).strict(), request.payload);
        return discoverFeed(body.url, this.#feedDiscoveryTimeoutMs);
      }
      case "analyzeWebPage": {
        const body = input(z.object({ url: httpUrl }).strict(), request.payload);
        return this.#webFeedService.analyze(String(this.#userId), body.url);
      }
      case "createFeed":
        return this.#createFeed(request.payload);
      case "feed": {
        const body = input(z.object({ id }).strict(), request.payload);
        return notFound(this.#database.feeds.getFeed(this.#userId, body.id), "Feed");
      }
      case "updateFeed": {
        const body = input(
          z
            .object({
              id,
              input: z
                .object({
                  title: z.string().trim().min(1).max(300).optional(),
                  feedUrl: httpUrl.optional(),
                  siteUrl: httpUrl.nullable().optional(),
                  folderId: nullableId.optional(),
                  paused: z.boolean().optional(),
                })
                .strict(),
            })
            .strict(),
          request.payload,
        );
        return notFound(this.#database.feeds.updateFeed(this.#userId, body.id, body.input), "Feed");
      }
      case "deleteFeed": {
        const body = input(z.object({ id }).strict(), request.payload);
        if (!this.#database.feeds.deleteFeed(this.#userId, body.id)) {
          throw new ApplicationApiError(404, "Feed was not found.");
        }
        return undefined;
      }
      case "analyzeWebFeed": {
        const body = input(z.object({ id }).strict(), request.payload);
        const feed = notFound(this.#database.feeds.getFeed(this.#userId, body.id), "Feed");
        if (feed.sourceKind !== "web") {
          throw new ApplicationApiError(400, "Choose a web feed before editing a page selection.");
        }
        const config = notFound(
          this.#database.feeds.getWebFeedConfig(this.#userId, body.id),
          "Page selection",
        );
        return this.#webFeedService.analyze(String(this.#userId), config.pageUrl, config);
      }
      case "updateWebFeedSelection": {
        const body = input(z.object({ id, config: webFeedConfig }).strict(), request.payload);
        const feed = notFound(this.#database.feeds.getFeed(this.#userId, body.id), "Feed");
        if (feed.sourceKind !== "web") {
          throw new ApplicationApiError(400, "Choose a web feed before editing a page selection.");
        }
        const config = body.config as WebFeedConfig;
        const extracted = await this.#webFeedService.extract(config);
        const updated = notFound(
          this.#database.feeds.updateWebFeedSelection(
            this.#userId,
            body.id,
            config,
            extracted.parsed,
          ),
          "Feed",
        );
        this.#refreshService.notifyDataChanged(this.#userId);
        return updated;
      }
      case "createFolder": {
        const body = input(
          z
            .object({
              name: z.string().trim().min(1).max(200),
              parentId: nullableId,
              sortDirection: z.enum(["newest", "oldest"]),
            })
            .strict(),
          request.payload,
        );
        return this.#database.folders.createFolder(this.#userId, body);
      }
      case "updateFolder": {
        const body = input(
          z
            .object({
              id,
              input: z
                .object({
                  name: z.string().trim().min(1).max(200).optional(),
                  parentId: nullableId.optional(),
                  sortDirection: z.enum(["newest", "oldest"]).optional(),
                })
                .strict(),
            })
            .strict(),
          request.payload,
        );
        return notFound(
          this.#database.folders.updateFolder(this.#userId, body.id, body.input),
          "Folder",
        );
      }
      case "deleteFolder": {
        const body = input(z.object({ id }).strict(), request.payload);
        if (!this.#database.folders.deleteFolder(this.#userId, body.id)) {
          throw new ApplicationApiError(404, "Folder was not found.");
        }
        return undefined;
      }
      case "rules":
        return { rules: this.#database.rules.listRules(this.#userId) };
      case "createRule": {
        const body = input(ruleFields, request.payload);
        this.#assertSingleRuleScope(body.feedId, body.folderId);
        return this.#database.rules.createRule(this.#userId, body);
      }
      case "updateRule": {
        const body = input(z.object({ id, input: ruleFields.partial() }).strict(), request.payload);
        const existing = notFound(this.#database.rules.getRule(this.#userId, body.id), "Rule");
        this.#assertSingleRuleScope(
          body.input.feedId === undefined ? existing.feedId : body.input.feedId,
          body.input.folderId === undefined ? existing.folderId : body.input.folderId,
        );
        return notFound(this.#database.rules.updateRule(this.#userId, body.id, body.input), "Rule");
      }
      case "deleteRule": {
        const body = input(z.object({ id }).strict(), request.payload);
        if (!this.#database.rules.deleteRule(this.#userId, body.id)) {
          throw new ApplicationApiError(404, "Rule was not found.");
        }
        return undefined;
      }
      case "updateSettings": {
        const body = input(
          z
            .object({
              pollIntervalMinutes: feedPollIntervalMinutes.optional(),
              duplicateArticleWindowDays: duplicateArticleWindowDays.optional(),
              singleKeyShortcuts: z.boolean().optional(),
              markReadOnScroll: z.boolean().optional(),
              showYouTubeDescriptions: z.boolean().optional(),
              translationLanguage: z.string().trim().min(1).max(80).optional(),
              summaryPrompt: z.string().trim().min(1).max(AI_PROMPT_MAX_LENGTH).optional(),
              translationPrompt: z.string().trim().min(1).max(AI_PROMPT_MAX_LENGTH).optional(),
              customPrompts: z
                .array(
                  z
                    .object({
                      id: z.uuid(),
                      name: z.string().trim().min(1).max(80),
                      prompt: z.string().trim().min(1).max(AI_PROMPT_MAX_LENGTH),
                    })
                    .strict(),
                )
                .optional(),
            })
            .strict(),
          request.payload,
        );
        return this.#database.settings.updateSettings(this.#userId, body);
      }
      case "aiSettings":
        return this.#ai.getSettings(this.#userId);
      case "updateAiFeature": {
        const body = input(
          z
            .object({
              feature: z.literal("article_summary"),
              input: z
                .object({
                  provider: z.enum(["gemini", "openai", "anthropic"]),
                  model: z.string().trim().min(1).max(200).optional(),
                })
                .strict(),
            })
            .strict(),
          request.payload,
        );
        return this.#ai.setFeatureSetting(
          this.#userId,
          body.feature as AiFeature,
          body.input.provider as AiProvider,
          body.input.model,
        );
      }
      case "saveAiProviderKey": {
        const body = input(
          z
            .object({
              provider: z.enum(["gemini", "openai", "anthropic"]),
              apiKey: z.string().trim().min(1).max(10_000),
            })
            .strict(),
          request.payload,
        );
        return this.#ai.setApiKey(this.#userId, body.provider as AiProvider, body.apiKey);
      }
      case "deleteAiProviderKey": {
        const body = input(
          z.object({ provider: z.enum(["gemini", "openai", "anthropic"]) }).strict(),
          request.payload,
        );
        return this.#ai.deleteApiKey(this.#userId, body.provider as AiProvider);
      }
      case "importOpml": {
        const body = input(z.object({ opml: z.string().min(1) }).strict(), request.payload);
        try {
          const { feedIds, ...result } = this.#database.opml.import(this.#userId, body.opml);
          this.#refreshService.request(feedIds);
          return result;
        } catch (error) {
          throw new ApplicationApiError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      case "exportOpml":
        return this.#database.opml.export(this.#userId);
      default:
        return this.#unsupported(request.operation);
    }
  }

  snapshot(id: string): string {
    return this.#webFeedService.snapshot(String(this.#userId), id);
  }

  async telegramPreviewUrl(articleId: number): Promise<string> {
    const first = (await this.#telegramItems(articleId))[0];
    return notFound(first?.posterUrl ?? first?.url, "Telegram media");
  }

  async #createFeed(payload: unknown): Promise<unknown> {
    const body = input(
      z.discriminatedUnion("sourceKind", [
        z
          .object({
            sourceKind: z.literal("published"),
            title: z.string().trim().min(1).max(300).optional(),
            feedUrl: httpUrl,
            siteUrl: httpUrl.nullable().optional(),
            folderId: nullableId,
          })
          .strict(),
        z
          .object({
            sourceKind: z.literal("web"),
            title: z.string().trim().min(1).max(300).optional(),
            feedUrl: httpUrl,
            siteUrl: httpUrl.nullable().optional(),
            folderId: nullableId,
            webConfig: webFeedConfig,
          })
          .strict(),
      ]),
      payload,
    );
    if (body.sourceKind === "published") {
      const feed = this.#database.feeds.createFeed(this.#userId, body);
      if (!feed.paused) this.#refreshService.request([feed.id]);
      return this.#database.feeds.getFeed(this.#userId, feed.id);
    }
    const config = body.webConfig as WebFeedConfig;
    const extracted = await this.#webFeedService.extract(config);
    const feed = this.#database.feeds.createWebFeed(this.#userId, {
      title: body.title ?? extracted.parsed.title,
      pageUrl: body.feedUrl,
      folderId: body.folderId,
      config,
      parsed: extracted.parsed,
    });
    this.#refreshService.notifyDataChanged(this.#userId);
    return feed;
  }

  async #telegramItems(articleId: number) {
    const article = this.#database.articles.getArticle(this.#userId, articleId);
    if (!article?.url || !telegramPostIdentity(article.url)) {
      throw new ApplicationApiError(404, "Telegram media was not found.");
    }
    try {
      return await this.#telegramMedia.mediaForPost(article.url);
    } catch {
      throw new ApplicationApiError(502, "Telegram media is temporarily unavailable. Try again.");
    }
  }

  async #xMediaForArticle(articleId: number) {
    const article = this.#database.articles.getArticle(this.#userId, articleId);
    const postId = article ? nitterVideoPostId(article.url, article.feedContentHtml) : null;
    if (!postId) throw new ApplicationApiError(404, "X video was not found.");
    try {
      return await this.#xMedia.mediaForPost(postId);
    } catch {
      throw new ApplicationApiError(502, "X video is temporarily unavailable. Try again.");
    }
  }

  #assertSingleRuleScope(feedId: number | null, folderId: number | null): void {
    if (feedId && folderId) {
      throw new ApplicationApiError(400, "Choose either one feed or one folder for this rule.");
    }
  }

  #unsupported(operation: never): never {
    throw new ApplicationApiError(400, `Unsupported desktop operation: ${operation}`);
  }
}
