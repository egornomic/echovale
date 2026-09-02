import { randomBytes, randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import type { WebFeedAnalysis, WebFeedConfig } from "../shared/types.js";
import type { ParsedFeed } from "./features/shared.js";
import type { QuotaService } from "./quota.js";
import {
  WebFeedBrowserLoader,
  type WebFeedBrowserLoaderOptions,
  webFeedContentRequestError,
} from "./web-feed-browser.js";
import {
  analyzeWebFeedDocument,
  extractWebFeedSelection,
  suggestedWebFeedCandidateIds,
} from "./web-feed-dom.js";
import { WebFeedError } from "./web-feed-error.js";
import { createWebFeedSnapshot } from "./web-feed-snapshot.js";

export { isBlockedNetworkAddress } from "./public-network.js";
export { WebFeedError } from "./web-feed-error.js";

const DEFAULT_SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
const MAX_SNAPSHOTS = 100;

export interface WebFeedServiceOptions extends WebFeedBrowserLoaderOptions {
  snapshotTtlMs?: number;
  now?: () => number;
}

export interface WebFeedExtraction {
  parsed: ParsedFeed;
  matchCount: number;
  httpStatus: number | null;
}

interface StoredSnapshot {
  userId: string;
  html: string;
  expiresAt: number;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export class WebFeedService {
  readonly #loader: WebFeedBrowserLoader;
  readonly #snapshotTtlMs: number;
  readonly #now: () => number;
  readonly #snapshots = new Map<string, StoredSnapshot>();
  readonly #quotas: QuotaService | undefined;

  constructor(options: WebFeedServiceOptions = {}) {
    this.#loader = new WebFeedBrowserLoader(options);
    this.#snapshotTtlMs = finitePositive(options.snapshotTtlMs, DEFAULT_SNAPSHOT_TTL_MS);
    this.#now = options.now ?? Date.now;
    this.#quotas = options.quotas;
  }

  async analyze(
    userId: string,
    inputUrl: string,
    savedConfig: WebFeedConfig | null = null,
  ): Promise<WebFeedAnalysis> {
    this.#quotas?.consume("web_analysis", Number(userId));
    const load = () => this.#loader.load(inputUrl, savedConfig);
    const loaded = this.#quotas ? await this.#quotas.runChromium(load) : await load();
    const dom = new JSDOM(loaded.html, { url: loaded.pageUrl });
    try {
      const { document } = dom.window;
      const documentAnalysis = analyzeWebFeedDocument(document, loaded.pageUrl, savedConfig);
      const candidates = await this.#loader.publicCandidates(documentAnalysis.candidates);
      const savedSelectionMatched =
        documentAnalysis.savedCandidateId !== null &&
        candidates.some(({ candidate }) => candidate.id === documentAnalysis.savedCandidateId);
      const selectedCandidateId = savedSelectionMatched ? documentAnalysis.savedCandidateId : null;
      if (savedConfig && !savedSelectionMatched) {
        const loadingError = webFeedContentRequestError(loaded);
        if (loadingError) throw loadingError;
      }
      const suggestedCandidateIds = suggestedWebFeedCandidateIds(candidates);
      if (candidates.length === 0 && !savedConfig) {
        const loadingError = webFeedContentRequestError(loaded);
        if (loadingError) throw loadingError;
        if (!loaded.domContentLoaded) {
          throw new WebFeedError(
            "This page did not finish loading before feedfold could find its entries. Try again.",
            "javascript_timeout",
            loaded.httpStatus,
          );
        }
        throw new WebFeedError(
          "feedfold could not find a repeated group of linked entries on this page. Choose another page.",
          "unsupported_content",
          loaded.httpStatus,
        );
      }

      const messageToken = randomBytes(24).toString("base64url");
      const snapshotId = randomUUID();
      this.#pruneSnapshots();
      while (this.#snapshots.size >= MAX_SNAPSHOTS) {
        const oldest = this.#snapshots.keys().next().value;
        if (typeof oldest !== "string") break;
        this.#snapshots.delete(oldest);
      }
      this.#snapshots.set(snapshotId, {
        userId,
        html: createWebFeedSnapshot(document, candidates, messageToken),
        expiresAt: this.#now() + this.#snapshotTtlMs,
      });
      return {
        pageUrl: loaded.pageUrl,
        title: loaded.title,
        snapshotId,
        messageToken,
        candidates: candidates.map(({ candidate }) => candidate),
        suggestedCandidateIds,
        selectedCandidateId,
        savedSelectionMatched,
      };
    } finally {
      dom.window.close();
    }
  }

  async extract(config: WebFeedConfig): Promise<WebFeedExtraction> {
    const load = () => this.#loader.load(config.pageUrl, config);
    const loaded = this.#quotas ? await this.#quotas.runChromium(load) : await load();
    const dom = new JSDOM(loaded.html, { url: loaded.pageUrl });
    try {
      const extracted = extractWebFeedSelection(
        dom.window.document,
        loaded.pageUrl,
        config.selectors,
      );
      if (extracted.articles.length === 0) {
        const loadingError = webFeedContentRequestError(loaded);
        if (loadingError) throw loadingError;
        if (!loaded.domContentLoaded) {
          throw new WebFeedError(
            "This page did not finish loading before feedfold could apply the saved selection. Try again.",
            "javascript_timeout",
            loaded.httpStatus,
          );
        }
        throw new WebFeedError(
          "This page has changed, so the saved selection no longer finds entries. Edit the page selection to repair the feed.",
          "selection_broken",
          loaded.httpStatus,
        );
      }
      await this.#loader.validateArticleUrls(
        extracted.articles.flatMap((article) => (article.url ? [article.url] : [])),
      );
      return {
        parsed: {
          title: loaded.title,
          siteUrl: loaded.pageUrl,
          articles: extracted.articles,
        },
        matchCount: extracted.articles.length,
        httpStatus: loaded.httpStatus,
      };
    } finally {
      dom.window.close();
    }
  }

  snapshot(userId: string, snapshotId: string): string {
    this.#pruneSnapshots();
    const snapshot = this.#snapshots.get(snapshotId);
    if (!snapshot || snapshot.userId !== userId) {
      throw new WebFeedError(
        "This page preview has expired. Reload the page, then choose the entries again.",
        "inaccessible",
      );
    }
    return snapshot.html;
  }

  async close(): Promise<void> {
    this.#snapshots.clear();
    await this.#loader.close();
  }

  #pruneSnapshots(): void {
    const now = this.#now();
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.expiresAt <= now) this.#snapshots.delete(id);
    }
  }
}
