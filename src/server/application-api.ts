import { z } from "zod";
import { resourceId as id, inputs } from "../shared/api-inputs.js";
import type { DesktopRequest } from "../shared/desktop.js";
import { telegramPostIdentity } from "../shared/telegram.js";
import type { MarkReadRequest } from "../shared/types.js";
import { xVideoPostId } from "../shared/x.js";
import { accountActivityTouchBefore } from "./account-activity.js";
import type { AppDatabase } from "./database.js";
import type { ExtractionQueue } from "./extraction.js";
import type { AiService } from "./features/ai/service.js";
import { discoverFeed } from "./feed-discovery.js";
import type { FeedRefreshService } from "./refresh.js";
import type { TelegramMediaService } from "./telegram-media.js";
import type { WebFeedService } from "./web-feed.js";
import type { XMediaService } from "./x-media.js";

export const LOCAL_USER_ID = 1;
const LOCAL_USER = { id: "local", username: "On this Mac", hasPassword: false } as const;

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
  readonly #userId = LOCAL_USER_ID;

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
    const activityAt = new Date().toISOString();
    this.#database.auth.touchUserActivity(
      this.#userId,
      activityAt,
      accountActivityTouchBefore(activityAt),
    );
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
      case "removePassword":
      case "deleteAccount":
      case "passkeySignupOptions":
      case "completePasskeySignup":
      case "stepUpPassword":
      case "stepUpPasskeyOptions":
      case "stepUpPasskey":
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
          inputs.articles.parse(request.payload),
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
        const body = input(inputs.summarizeArticle.extend({ id }), request.payload);
        return notFound(
          await this.#ai.summarizeArticle(this.#userId, body.id, body.promptId, body.regenerate),
          "Article",
        );
      }
      case "translateArticle": {
        const body = input(inputs.translateArticle.extend({ id }), request.payload);
        return notFound(
          await this.#ai.translateArticle(this.#userId, body.id, body.sourceKind),
          "Article",
        );
      }
      case "updateArticleState": {
        const body = input(
          z.object({ id, state: inputs.updateArticleState }).strict(),
          request.payload,
        );
        return notFound(
          this.#database.articles.updateArticleState(this.#userId, body.id, body.state),
          "Article",
        );
      }
      case "markRead": {
        const body = inputs.markRead.parse(request.payload ?? {}) as MarkReadRequest;
        return { updated: this.#database.articles.markArticlesRead(this.#userId, body) };
      }
      case "refresh": {
        const body = inputs.refresh.parse(request.payload ?? {});
        return this.#refreshService.request(
          this.#database.feeds.getManualRefreshFeedIds(this.#userId, body.feedIds),
        );
      }
      case "discoverFeed": {
        const body = inputs.url.parse(request.payload);
        return discoverFeed(body.url, this.#feedDiscoveryTimeoutMs);
      }
      case "analyzeWebPage": {
        const body = inputs.url.parse(request.payload);
        return this.#webFeedService.analyze(String(this.#userId), body.url);
      }
      case "createFeed":
        return this.#createFeed(request.payload);
      case "feed": {
        const body = input(z.object({ id }).strict(), request.payload);
        return notFound(this.#database.feeds.getFeed(this.#userId, body.id), "Feed");
      }
      case "updateFeed": {
        const body = input(z.object({ id, input: inputs.updateFeed }).strict(), request.payload);
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
        const body = input(inputs.updateWebFeedSelection.extend({ id }), request.payload);
        const feed = notFound(this.#database.feeds.getFeed(this.#userId, body.id), "Feed");
        if (feed.sourceKind !== "web") {
          throw new ApplicationApiError(400, "Choose a web feed before editing a page selection.");
        }
        const config = body.config;
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
        const body = inputs.createFolder.parse(request.payload);
        return this.#database.folders.createFolder(this.#userId, body);
      }
      case "updateFolder": {
        const body = input(z.object({ id, input: inputs.updateFolder }).strict(), request.payload);
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
        const body = inputs.createRule.parse(request.payload);
        return this.#database.rules.createRule(this.#userId, body);
      }
      case "updateRule": {
        const body = input(z.object({ id, input: inputs.updateRule }).strict(), request.payload);
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
        const body = inputs.updateSettings.parse(request.payload);
        return this.#database.settings.updateSettings(this.#userId, body);
      }
      case "aiSettings":
        return this.#ai.getSettings(this.#userId);
      case "updateAiFeature": {
        const body = input(
          z
            .object({
              feature: inputs.aiFeature,
              input: inputs.updateAiFeature,
            })
            .strict(),
          request.payload,
        );
        return this.#ai.setFeatureSetting(
          this.#userId,
          body.feature,
          body.input.provider,
          body.input.model,
        );
      }
      case "saveAiProviderKey": {
        const body = input(
          inputs.saveAiProviderKey.extend({ provider: inputs.aiProvider }),
          request.payload,
        );
        return this.#ai.setApiKey(this.#userId, body.provider, body.apiKey);
      }
      case "deleteAiProviderKey": {
        const body = input(z.object({ provider: inputs.aiProvider }).strict(), request.payload);
        return this.#ai.deleteApiKey(this.#userId, body.provider);
      }
      case "importOpml": {
        const body = inputs.importOpml.parse(request.payload);
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
    const body = inputs.createFeed.parse(payload);
    if (body.sourceKind === "published") {
      const feed = this.#database.feeds.createFeed(this.#userId, body);
      if (!feed.paused && this.#database.feeds.subscriptionNeedsRefresh(feed.id)) {
        this.#refreshService.request([feed.id]);
      }
      return this.#database.feeds.getFeed(this.#userId, feed.id);
    }
    const config = body.webConfig;
    const extracted = await this.#webFeedService.extract(config);
    const feed = this.#database.feeds.createWebFeed(this.#userId, {
      title: body.title ?? extracted.parsed.title,
      pageUrl: body.feedUrl,
      folderId: body.folderId ?? null,
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
    const postId = article ? xVideoPostId(article.url, article.feedContentHtml) : null;
    if (!postId) throw new ApplicationApiError(404, "X video was not found.");
    try {
      return await this.#xMedia.mediaForPost(postId);
    } catch {
      throw new ApplicationApiError(502, "X video is temporarily unavailable. Try again.");
    }
  }

  #unsupported(operation: never): never {
    throw new ApplicationApiError(400, `Unsupported desktop operation: ${operation}`);
  }
}
