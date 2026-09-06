import type Sqlite from "better-sqlite3";
import type { Feed, WebFeedConfig } from "../../../shared/types.js";
import type { DeploymentPolicy } from "../../deployment-policy.js";
import { InvalidRequestError, OperationForbiddenError } from "../../errors.js";
import type { QuotaService } from "../../quota.js";
import type { ArticleRepository } from "../articles/repository.js";
import type { FolderRepository } from "../folders/repository.js";
import type { RuleRepository } from "../rules/repository.js";
import type { FeedRecord, ParsedFeed } from "../shared.js";
import { FeedIngestionService, type SuccessfulFeedRefresh } from "./ingestion-service.js";
import type { FeedRepository, SourceSubscription } from "./repository.js";

export class FeedService {
  private readonly ingestion: FeedIngestionService;

  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly repository: FeedRepository,
    private readonly folders: FolderRepository,
    private readonly articles: ArticleRepository,
    private readonly rules: RuleRepository,
    private readonly deploymentPolicy: DeploymentPolicy,
    private readonly quotas: QuotaService,
  ) {
    this.ingestion = new FeedIngestionService(sqlite, repository, articles, rules, this.quotas);
  }

  listFeeds(userId: number): Feed[] {
    return this.repository.listFeeds(userId);
  }

  getFeed(userId: number, id: number): Feed | null {
    return this.repository.getFeed(userId, id);
  }

  assertCanCreateFeed(userId: number): void {
    const limit = this.deploymentPolicy.maxFeedsPerAccount;
    if (limit === null) return;
    const count = Number(
      this.sqlite.prepare("SELECT COUNT(*) FROM feeds WHERE user_id = ?").pluck().get(userId),
    );
    if (count >= limit) {
      throw new InvalidRequestError(`This account can subscribe to up to ${limit} feeds.`);
    }
  }

  refreshQueueLimit(): number | null {
    return this.deploymentPolicy.maxPendingRefreshes;
  }

  getManualRefreshFeedIds(userId: number, requestedIds?: number[]): number[] {
    if (!this.deploymentPolicy.manualRefresh) {
      throw new OperationForbiddenError("Manual refresh is unavailable.");
    }
    if (requestedIds) {
      const paused = requestedIds.some((id) => this.repository.getFeed(userId, id)?.paused);
      if (paused) {
        throw new InvalidRequestError("Resume paused feeds before refreshing them.");
      }
    }
    return this.repository.getUserRefreshFeedIds(userId, requestedIds);
  }

  runOutbound<T>(task: () => Promise<T>): Promise<T> {
    return this.quotas.runOutbound(task);
  }

  createFeed(
    userId: number,
    input: {
      feedUrl: string;
      title?: string;
      siteUrl?: string | null;
      folderId?: number | null;
      paused?: boolean;
    },
  ): Feed {
    return this.sqlite.transaction(() => {
      this.assertCanCreateFeed(userId);
      const feed = this.repository.createFeed(userId, input);
      if (!feed.paused) {
        this.ingestion.initializeSubscription(
          userId,
          feed.id,
          this.repository.sourceIdForFeed(feed.id),
        );
      }
      return this.repository.getFeed(userId, feed.id) as Feed;
    })();
  }

  createWebFeed(
    userId: number,
    input: {
      title: string;
      pageUrl: string;
      folderId: number | null;
      config: WebFeedConfig;
      parsed: ParsedFeed;
    },
  ): Feed {
    this.assertCanCreateFeed(userId);
    this.folders.assertFolderExists(userId, input.folderId);
    if (input.parsed.articles.length === 0) {
      throw new Error("This selection does not match any entries. Choose another entry group.");
    }
    const pageUrl = new URL(input.pageUrl).toString();
    const config = { ...input.config, pageUrl: new URL(input.config.pageUrl).toString() };
    if (config.pageUrl !== pageUrl) {
      throw new Error("This selection belongs to another page. Reload the page and choose again.");
    }

    return this.sqlite.transaction(() => {
      const feedId = this.repository.createWebFeedRecord(userId, {
        ...input,
        pageUrl,
        config,
      });
      this.ingestion.completeRefresh(this.repository.sourceIdForFeed(feedId), {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        parsed: input.parsed,
        webMatchCount: input.parsed.articles.length,
      });
      return this.repository.getFeed(userId, feedId) as Feed;
    })();
  }

  updateWebFeedSelection(
    userId: number,
    id: number,
    configInput: WebFeedConfig,
    parsed: ParsedFeed,
  ): Feed | null {
    const existing = this.repository.getFeed(userId, id);
    if (!existing) return null;
    if (existing.sourceKind !== "web") {
      throw new Error("Choose a web feed before editing a page selection.");
    }
    if (parsed.articles.length === 0) {
      throw new Error("This selection does not match any entries. Choose another entry group.");
    }
    const config = { ...configInput, pageUrl: new URL(configInput.pageUrl).toString() };

    return this.sqlite.transaction(() => {
      const sourceId = this.repository.updateWebFeedSelectionRecord(id, config, parsed);
      this.ingestion.completeRefresh(sourceId, {
        httpStatus: 200,
        etag: null,
        lastModified: null,
        parsed,
        webMatchCount: parsed.articles.length,
      });
      return this.repository.getFeed(userId, id);
    })();
  }

  updateFeed(
    userId: number,
    id: number,
    input: {
      title?: string;
      feedUrl?: string;
      siteUrl?: string | null;
      folderId?: number | null;
      paused?: boolean;
    },
  ): Feed | null {
    const existing = this.repository.getFeed(userId, id);
    if (!existing) return null;
    return this.sqlite.transaction(() => {
      const updated = this.repository.updateFeed(userId, id, input);
      if (updated && input.folderId !== undefined && input.folderId !== existing.folderId) {
        this.rules.recomputeRulesForFeedArticles(userId, id, this.articles.listFeedArticleIds(id));
      }
      return updated;
    })();
  }

  deleteFeed(userId: number, id: number): boolean {
    return this.repository.deleteFeed(userId, id);
  }

  getFeedRecord(id: number): FeedRecord | null {
    const sourceId = this.repository.sourceIdForFeed(id);
    return sourceId ? this.repository.getFeedRecord(sourceId) : null;
  }

  getWebFeedConfig(userId: number, id: number): WebFeedConfig | null {
    return this.repository.getWebFeedConfig(userId, id);
  }

  getRefreshCandidates(ids?: number[]): FeedRecord[] {
    return this.repository.getRefreshCandidates(ids);
  }

  getUserRefreshFeedIds(userId: number, requestedIds?: number[]): number[] {
    return this.repository.getUserRefreshFeedIds(userId, requestedIds);
  }

  sourceIdForFeed(feedId: number): number {
    return this.repository.sourceIdForFeed(feedId);
  }

  subscriptionNeedsRefresh(feedId: number): boolean {
    return this.repository.subscriptionNeedsRefresh(feedId);
  }

  getDueFeedIds(at?: string): number[] {
    return this.repository.getDueFeedIds(at);
  }

  markRefreshing(id: number): void {
    const sourceId = this.repository.sourceIdForFeed(id);
    if (sourceId) this.repository.markFeedRefreshing(sourceId);
  }

  markSourceRefreshing(sourceId: number): void {
    this.repository.markFeedRefreshing(sourceId);
  }

  listSourceSubscriptions(sourceId: number): SourceSubscription[] {
    return this.repository.listSourceSubscriptions(sourceId);
  }

  listDeliverableSourceSubscriptions(sourceId: number): SourceSubscription[] {
    return this.repository.listDeliverableSourceSubscriptions(sourceId);
  }

  completeRefresh(id: number, input: SuccessfulFeedRefresh): boolean {
    const sourceId = this.repository.sourceIdForFeed(id);
    return sourceId ? this.ingestion.completeRefresh(sourceId, input) : false;
  }

  completeSourceRefresh(sourceId: number, input: SuccessfulFeedRefresh): boolean {
    return this.ingestion.completeRefresh(sourceId, input);
  }

  failRefresh(id: number, input: Parameters<FeedRepository["markFeedFailure"]>[1]): void {
    const sourceId = this.repository.sourceIdForFeed(id);
    if (sourceId) this.repository.markFeedFailure(sourceId, input);
  }

  failSourceRefresh(
    sourceId: number,
    input: Parameters<FeedRepository["markFeedFailure"]>[1],
  ): void {
    this.repository.markFeedFailure(sourceId, input);
  }

  listOpmlFeeds(userId: number): Array<{
    title: string;
    feedUrl: string;
    siteUrl: string | null;
    folderId: number | null;
  }> {
    return this.repository.listOpmlFeeds(userId);
  }
}
