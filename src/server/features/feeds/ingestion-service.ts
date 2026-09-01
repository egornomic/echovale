import type Sqlite from "better-sqlite3";
import { cleanArticleHtml } from "../../article-html.js";
import type { ArticleRepository } from "../articles/repository.js";
import type { RuleRepository } from "../rules/repository.js";
import type { ParsedFeed } from "../shared.js";
import type { FeedRepository } from "./repository.js";

const INITIAL_ARTICLE_LIMIT = 10;

export interface SuccessfulFeedRefresh {
  httpStatus: number;
  etag: string | null;
  lastModified: string | null;
  scheduled?: boolean;
  parsed?: ParsedFeed;
  webMatchCount?: number;
  expectedSelectionRevision?: number;
}

export class FeedIngestionService {
  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly feeds: FeedRepository,
    private readonly articles: ArticleRepository,
    private readonly rules: RuleRepository,
  ) {}

  initializeSubscription(feedId: number, sourceId: number): boolean {
    return this.sqlite.transaction(() => {
      if (!this.feeds.sourceHasSuccessfulRefresh(sourceId)) return false;
      const delivered = this.articles.deliverSourceArticles(
        feedId,
        sourceId,
        undefined,
        INITIAL_ARTICLE_LIMIT,
      );
      this.feeds.markSubscriptionInitialized(feedId, new Date().toISOString());
      this.rules.recomputeRulesForArticles(delivered);
      return true;
    })();
  }

  completeRefresh(sourceId: number, input: SuccessfulFeedRefresh): boolean {
    const parsed = input.parsed
      ? {
          ...input.parsed,
          articles: input.parsed.articles.map((article) => ({
            ...article,
            feedContentHtml: article.feedContentHtml
              ? cleanArticleHtml(
                  article.feedContentHtml,
                  article.url ?? input.parsed?.siteUrl ?? undefined,
                )
              : null,
          })),
        }
      : undefined;

    return this.sqlite.transaction(() => {
      if (
        input.expectedSelectionRevision !== undefined &&
        !this.feeds.selectionRevisionMatches(sourceId, input.expectedSelectionRevision)
      ) {
        return false;
      }

      const changedArticleIds = new Set<number>();
      let insertedArticleCount = 0;
      const initialRefresh = this.feeds.isInitialSourceRefresh(sourceId);
      if (parsed) {
        this.feeds.updateFromParsedFeed(sourceId, parsed);
        const stored = this.articles.storeParsedFeedArticles(sourceId, parsed);
        insertedArticleCount = stored.insertedArticleCount;
        for (const articleId of stored.changedArticleIds) changedArticleIds.add(articleId);
      }
      const initializedAt = new Date().toISOString();
      for (const subscription of this.feeds.listSourceSubscriptions(sourceId)) {
        const delivered = this.articles.deliverSourceArticles(
          subscription.feedId,
          sourceId,
          parsed,
          subscription.initialized ? undefined : INITIAL_ARTICLE_LIMIT,
        );
        for (const articleId of delivered) changedArticleIds.add(articleId);
        this.feeds.markSubscriptionInitialized(subscription.feedId, initializedAt);
      }
      this.feeds.completeSuccessfulRefresh(sourceId, {
        ...input,
        scheduled: input.scheduled === true && !initialRefresh,
        insertedArticleCount,
      });
      this.rules.recomputeRulesForArticles(changedArticleIds);
      return true;
    })();
  }
}
