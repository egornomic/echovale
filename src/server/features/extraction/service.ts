import type Sqlite from "better-sqlite3";
import type { QuotaService } from "../../quota.js";
import type { RuleRepository } from "../rules/repository.js";
import type { ExtractionRecord } from "../shared.js";
import type { ExtractionRepository } from "./repository.js";

const MAX_EXTRACTED_ARTICLE_BYTES = 5 * 1_024 * 1_024;

export class ExtractionService {
  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly repository: ExtractionRepository,
    private readonly rules: RuleRepository,
    private readonly quotas: QuotaService,
  ) {}

  getPendingExtractions(limit = 100): ExtractionRecord[] {
    return this.repository.getPendingExtractions(limit);
  }

  getExtractionRecord(id: number): ExtractionRecord | null {
    return this.repository.getExtractionRecord(id);
  }

  markExtractionProcessing(id: number): boolean {
    return this.repository.markExtractionProcessing(id);
  }

  requestExtraction(userId: number, id: number): boolean {
    return this.sqlite.transaction(() => {
      const requested = this.repository.requestExtraction(userId, id);
      if (!requested) return false;
      this.quotas.consume("article_extraction", userId);
      this.quotas.assertArticleAccountsStorage(id, MAX_EXTRACTED_ARTICLE_BYTES);
      this.quotas.assertGlobalStorage(MAX_EXTRACTED_ARTICLE_BYTES);
      return true;
    })();
  }

  runExtraction<T>(task: () => Promise<T>): Promise<T> {
    return this.quotas.runArticleExtraction(task);
  }

  runOutbound<T>(task: () => Promise<T>): Promise<T> {
    return this.quotas.runOutbound(task);
  }

  completeExtraction(
    id: number,
    input: {
      contentHtml: string | null;
      imageUrl: string | null;
      contentSource: "article" | null;
      status: "complete" | "failed";
      error: string | null;
    },
  ): void {
    this.sqlite.transaction(() => {
      if (this.repository.completeExtraction(id, input)) {
        this.rules.recomputeRulesForArticle(id);
        const users = this.sqlite
          .prepare(
            `SELECT DISTINCT feeds.user_id AS userId
             FROM feed_articles
             JOIN feeds ON feeds.id = feed_articles.feed_id
             WHERE feed_articles.article_id = ?`,
          )
          .all(id) as Array<{ userId: number }>;
        for (const { userId } of users) this.quotas.assertAccountStorage(userId);
        this.quotas.assertGlobalStorage();
      }
    })();
  }
}
