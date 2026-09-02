import { randomUUID } from "node:crypto";
import type Sqlite from "better-sqlite3";
import type { DeploymentPolicy } from "./deployment-policy.js";

type DailyResource =
  | "article_extraction"
  | "feed_discovery"
  | "media_proxy"
  | "outbound_request"
  | "web_analysis";
type ConcurrentResource = "article_extraction" | "chromium" | "outbound_request";

const ARTICLE_BYTE_COLUMNS = `
  length(articles.external_id) + length(articles.title) +
  length(COALESCE(articles.url, '')) + length(COALESCE(articles.author, '')) +
  length(COALESCE(articles.summary, '')) +
  length(COALESCE(articles.feed_content_html, '')) +
  length(COALESCE(articles.content_html, '')) +
  length(COALESCE(articles.image_url, '')) + length(COALESCE(articles.media_json, ''))
`;

export class QuotaExceededError extends Error {
  readonly code = "quota_exceeded";
  readonly statusCode = 429;

  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function byteLimitLabel(bytes: number): string {
  return bytes >= 1_048_576 && bytes % 1_048_576 === 0
    ? `${bytes / 1_048_576} MiB`
    : `${bytes.toLocaleString("en-US")} bytes`;
}

export class QuotaService {
  constructor(
    private readonly sqlite: Sqlite.Database,
    private readonly policy: DeploymentPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {
    const byteLimit = policy.quotas.globalStoredBytes;
    if (byteLimit !== null) {
      const pageSize = Number(sqlite.pragma("page_size", { simple: true }));
      sqlite.pragma(`max_page_count = ${Math.max(1, Math.floor(byteLimit / pageSize))}`);
    }
  }

  private dailyLimit(resource: DailyResource): number | null {
    const quotas = this.policy.quotas;
    switch (resource) {
      case "feed_discovery":
        return quotas.feedDiscoveriesPerDay;
      case "web_analysis":
        return quotas.webAnalysesPerDay;
      case "article_extraction":
        return quotas.articleExtractionsPerDay;
      case "media_proxy":
        return quotas.mediaProxyRequestsPerDay;
      case "outbound_request":
        return quotas.outboundRequestsPerDay;
    }
  }

  private concurrentLimit(resource: ConcurrentResource): number | null {
    const quotas = this.policy.quotas;
    switch (resource) {
      case "chromium":
        return quotas.chromiumConcurrent;
      case "article_extraction":
        return quotas.articleExtractionsConcurrent;
      case "outbound_request":
        return quotas.outboundRequestsConcurrent;
    }
  }

  consume(resource: Exclude<DailyResource, "outbound_request">, userId: number): void {
    this.consumeDaily(resource, `user:${userId}`);
  }

  private consumeDaily(resource: DailyResource, scope: string): void {
    const limit = this.dailyLimit(resource);
    if (limit === null) return;
    const day = today(this.now());
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM quota_daily_usage WHERE day < date(?, '-2 days')").run(day);
      const used = Number(
        this.sqlite
          .prepare(
            "SELECT count FROM quota_daily_usage WHERE scope = ? AND resource = ? AND day = ?",
          )
          .pluck()
          .get(scope, resource, day) ?? 0,
      );
      if (used >= limit) {
        const labels: Record<DailyResource, string> = {
          article_extraction: "full-article extraction",
          feed_discovery: "feed discovery",
          media_proxy: "media loading",
          outbound_request: "outbound request",
          web_analysis: "web-page analysis",
        };
        throw new QuotaExceededError(
          resource === "outbound_request"
            ? "The server has reached today's outbound request limit. Try again tomorrow."
            : `This account has reached today's ${labels[resource]} limit. Try again tomorrow.`,
        );
      }
      this.sqlite
        .prepare(
          `INSERT INTO quota_daily_usage (scope, resource, day, count)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(scope, resource, day) DO UPDATE SET count = count + 1`,
        )
        .run(scope, resource, day);
    })();
  }

  private acquire(resource: ConcurrentResource, leaseMs: number): (() => void) | null {
    const limit = this.concurrentLimit(resource);
    if (limit === null) return () => {};
    const id = randomUUID();
    const at = this.now();
    const expiresAt = new Date(at.getTime() + leaseMs).toISOString();
    return this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM quota_leases WHERE expires_at <= ?").run(at.toISOString());
      const active = Number(
        this.sqlite
          .prepare("SELECT COUNT(*) FROM quota_leases WHERE resource = ?")
          .pluck()
          .get(resource),
      );
      if (active >= limit) return null;
      this.sqlite
        .prepare("INSERT INTO quota_leases (id, resource, expires_at) VALUES (?, ?, ?)")
        .run(id, resource, expiresAt);
      return () => {
        this.sqlite.prepare("DELETE FROM quota_leases WHERE id = ?").run(id);
      };
    })();
  }

  private async concurrent<T>(
    resource: ConcurrentResource,
    leaseMs: number,
    message: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const release = this.acquire(resource, leaseMs);
    if (!release) throw new QuotaExceededError(message);
    try {
      return await task();
    } finally {
      release();
    }
  }

  runChromium<T>(task: () => Promise<T>): Promise<T> {
    return this.concurrent(
      "chromium",
      120_000,
      "The server is already analyzing other web pages. Try again shortly.",
      task,
    );
  }

  runArticleExtraction<T>(task: () => Promise<T>): Promise<T> {
    return this.concurrent(
      "article_extraction",
      120_000,
      "The server is already extracting other articles. Try again shortly.",
      task,
    );
  }

  async runOutbound<T>(task: () => Promise<T>): Promise<T> {
    const release = this.startOutboundRequest();
    try {
      return await task();
    } finally {
      release();
    }
  }

  startOutboundRequest(): () => void {
    this.consumeDaily("outbound_request", "global");
    const release = this.acquire("outbound_request", 120_000);
    if (!release) {
      throw new QuotaExceededError(
        "The server is handling too many outbound requests. Try again shortly.",
      );
    }
    return release;
  }

  assertOpmlUpload(source: string, feedCount: number): void {
    const bytes = Buffer.byteLength(source, "utf8");
    const byteLimit = this.policy.quotas.opmlUploadBytes;
    if (byteLimit !== null && bytes > byteLimit) {
      throw new QuotaExceededError(
        `This OPML file is larger than the ${byteLimitLabel(byteLimit)} upload limit.`,
      );
    }
    const feedLimit = this.policy.quotas.opmlFeedsPerImport;
    if (feedLimit !== null && feedCount > feedLimit) {
      throw new QuotaExceededError(
        `An OPML file can import up to ${feedLimit} ${feedLimit === 1 ? "feed" : "feeds"}.`,
      );
    }
  }

  canRegisterAccount(): boolean {
    const limit = this.policy.quotas.registeredAccounts;
    if (limit === null) return true;
    const count = Number(
      this.sqlite
        .prepare("SELECT COUNT(*) FROM users WHERE username <> '__legacy_owner__'")
        .pluck()
        .get(),
    );
    return count < limit;
  }

  assertCanRegisterAccount(): void {
    if (!this.canRegisterAccount()) {
      throw new QuotaExceededError("This feedfold server is not accepting more accounts.");
    }
    this.assertGlobalStorage();
  }

  assertAccountStorage(userId: number, additionalArticles = 0, additionalBytes = 0): void {
    if (
      this.policy.quotas.articlesPerAccount === null &&
      this.policy.quotas.storedBytesPerAccount === null
    ) {
      return;
    }
    const row = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS articleCount, COALESCE(SUM(articleBytes), 0) AS storedBytes
         FROM (
           SELECT articles.id, ${ARTICLE_BYTE_COLUMNS} AS articleBytes
           FROM articles
           JOIN feed_articles ON feed_articles.article_id = articles.id
           JOIN feeds ON feeds.id = feed_articles.feed_id
           WHERE feeds.user_id = ?
           GROUP BY articles.id
         )`,
      )
      .get(userId) as { articleCount: number; storedBytes: number };
    const articleLimit = this.policy.quotas.articlesPerAccount;
    if (articleLimit !== null && Number(row.articleCount) + additionalArticles > articleLimit) {
      throw new QuotaExceededError(
        `This account has reached its ${articleLimit.toLocaleString("en-US")} article limit.`,
      );
    }
    const byteLimit = this.policy.quotas.storedBytesPerAccount;
    if (byteLimit !== null && Number(row.storedBytes) + additionalBytes > byteLimit) {
      throw new QuotaExceededError("This account has reached its stored-data limit.");
    }
  }

  assertSourceAccountsStorage(sourceId: number): void {
    if (
      this.policy.quotas.articlesPerAccount === null &&
      this.policy.quotas.storedBytesPerAccount === null
    ) {
      this.assertGlobalStorage();
      return;
    }
    const userIds = this.sqlite
      .prepare("SELECT DISTINCT user_id AS userId FROM feeds WHERE source_id = ?")
      .all(sourceId) as Array<{ userId: number }>;
    for (const { userId } of userIds) this.assertAccountStorage(userId);
    this.assertGlobalStorage();
  }

  assertArticleAccountsStorage(articleId: number, additionalBytes = 0): void {
    if (
      this.policy.quotas.articlesPerAccount === null &&
      this.policy.quotas.storedBytesPerAccount === null
    ) {
      return;
    }
    const userIds = this.sqlite
      .prepare(
        `SELECT DISTINCT feeds.user_id AS userId
         FROM feed_articles
         JOIN feeds ON feeds.id = feed_articles.feed_id
         WHERE feed_articles.article_id = ?`,
      )
      .all(articleId) as Array<{ userId: number }>;
    for (const { userId } of userIds) {
      this.assertAccountStorage(userId, 0, additionalBytes);
    }
  }

  assertGlobalStorage(additionalBytes = 0): void {
    const limit = this.policy.quotas.globalStoredBytes;
    if (limit === null) return;
    const pageCount = Number(this.sqlite.pragma("page_count", { simple: true }));
    const pageSize = Number(this.sqlite.pragma("page_size", { simple: true }));
    if (pageCount * pageSize + additionalBytes > limit) {
      throw new QuotaExceededError("This feedfold server has reached its storage limit.");
    }
  }
}
