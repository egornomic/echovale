import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import sanitizeHtml from "sanitize-html";
import { cleanArticleHtml } from "./article-html.js";
import { firstSafeImageUrl } from "./article-image.js";
import type { ExtractionService } from "./features/extraction/service.js";
import type { ExtractionRecord } from "./features/shared.js";
import { fetchPublic } from "./public-network.js";

const MAX_ARTICLE_BYTES = 5 * 1024 * 1024;
const articleVirtualConsole = new VirtualConsole().forwardTo(console, {
  jsdomErrors: ["not-implemented", "resource-loading", "unhandled-exception"],
});

function containsText(html: string): boolean {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim().length > 0;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function cancelBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The extraction error remains factual even if the remote peer closes first.
  }
}

async function readHtmlResponse(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    await cancelBody(response);
    throw new Error(`The source returned ${contentType} instead of an HTML page.`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTICLE_BYTES) {
    await cancelBody(response);
    throw new Error("The source page is larger than the 5 MiB full-article limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_ARTICLE_BYTES) {
      await reader.cancel();
      throw new Error("The source page is larger than the 5 MiB full-article limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export type ExtractionOutcome = {
  contentHtml: string | null;
  imageUrl: string | null;
  contentSource: "article" | null;
  status: "complete" | "failed";
  error: string | null;
};

export async function extractArticle(
  record: ExtractionRecord,
  timeoutMs = 20_000,
  fetcher: typeof fetchPublic = fetchPublic,
): Promise<ExtractionOutcome> {
  if (record.url) {
    try {
      const response = await fetcher(record.url, {
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "User-Agent": "feedfold/0.1 (+self-hosted feed reader)",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`The source page returned HTTP ${response.status}.`);
      const html = await readHtmlResponse(response);
      const dom = new JSDOM(html, {
        url: response.url || record.url,
        virtualConsole: articleVirtualConsole,
      });
      try {
        const result = new Readability(dom.window.document).parse();
        if (!result?.content)
          throw new Error("The source page did not contain readable article text.");
        const contentHtml = cleanArticleHtml(result.content, response.url || record.url);
        if (!containsText(contentHtml))
          throw new Error("The extracted article did not contain text.");
        return {
          contentHtml,
          imageUrl: firstSafeImageUrl(contentHtml, response.url || record.url),
          contentSource: "article",
          status: "complete",
          error: null,
        };
      } finally {
        dom.window.close();
      }
    } catch (error) {
      return {
        contentHtml: null,
        imageUrl: null,
        contentSource: null,
        status: "failed",
        error: message(error),
      };
    }
  }

  return {
    contentHtml: null,
    imageUrl: null,
    contentSource: null,
    status: "failed",
    error: "This article has no source link.",
  };
}

export class ExtractionQueue {
  private readonly pending: number[] = [];
  private readonly enqueued = new Set<number>();
  private active = 0;
  private stopped = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly extractions: ExtractionService,
    private readonly concurrency = 2,
    private readonly timeoutMs = 20_000,
    private readonly fetcher: typeof fetchPublic = fetchPublic,
  ) {}

  start(): void {
    this.refill();
  }

  enqueue(articleIds: number[]): void {
    if (this.stopped) return;
    for (const articleId of articleIds) {
      if (this.enqueued.has(articleId)) continue;
      this.enqueued.add(articleId);
      this.pending.push(articleId);
    }
    this.pump();
  }

  prioritize(articleId: number): void {
    if (this.stopped) return;
    const queuedIndex = this.pending.indexOf(articleId);
    if (queuedIndex >= 0) {
      this.pending.splice(queuedIndex, 1);
    } else if (this.enqueued.has(articleId)) {
      return;
    } else {
      this.enqueued.add(articleId);
    }
    this.pending.unshift(articleId);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.pending.length > 0) {
      const articleId = this.pending.shift();
      if (articleId === undefined) break;
      this.active += 1;
      void this.process(articleId).finally(() => {
        this.active -= 1;
        this.enqueued.delete(articleId);
        this.refill();
        this.pump();
        this.resolveIdleIfNeeded();
      });
    }
    this.resolveIdleIfNeeded();
  }

  private async process(articleId: number): Promise<void> {
    const record = this.extractions.getExtractionRecord(articleId);
    if (!record || !this.extractions.markExtractionProcessing(articleId)) return;
    try {
      await this.extractions.runExtraction(async () => {
        const outcome = await extractArticle(record, this.timeoutMs, (url, options) =>
          this.extractions.runOutbound(() => this.fetcher(url, options)),
        );
        this.extractions.completeExtraction(articleId, outcome);
      });
    } catch (error) {
      this.extractions.completeExtraction(articleId, {
        contentHtml: null,
        imageUrl: null,
        contentSource: null,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private refill(): void {
    if (this.stopped) return;
    this.enqueue(this.extractions.getPendingExtractions(100).map((article) => article.id));
  }

  async waitForIdle(): Promise<void> {
    if (this.pending.length === 0 && this.active === 0) return;
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.length = 0;
    await this.waitForIdle();
  }

  private resolveIdleIfNeeded(): void {
    if (this.pending.length > 0 || this.active > 0) return;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}
