import { fetchFeed } from "./feed-http.js";
import type { QuotaService } from "./quota.js";
import {
  parseTelegramPostMedia,
  type TelegramPostMedia,
  telegramPostEmbedUrl,
} from "./telegram-feed.js";

const USER_AGENT = "feedfold/0.1 (+self-hosted feed reader)";
const CACHE_TTL_MS = 60_000;

interface CachedTelegramMedia {
  expiresAt: number;
  items: TelegramPostMedia[];
}

export class TelegramMediaService {
  private readonly cache = new Map<string, CachedTelegramMedia>();

  constructor(
    private readonly timeoutMs = 15_000,
    private readonly fetcher: typeof fetchFeed = fetchFeed,
    private readonly quotas?: QuotaService,
  ) {}

  async mediaForPost(postUrl: string): Promise<TelegramPostMedia[]> {
    const cached = this.cache.get(postUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.items;

    const embedUrl = telegramPostEmbedUrl(postUrl);
    if (!embedUrl) throw new Error("Invalid Telegram post URL");
    const fetchMedia = () =>
      this.fetcher(embedUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    const response = this.quotas ? await this.quotas.runOutbound(fetchMedia) : await fetchMedia();
    if (!response.ok) throw new Error(`Telegram post returned HTTP ${response.status}`);

    const items = parseTelegramPostMedia(await response.text(), postUrl);
    this.cache.set(postUrl, { expiresAt: Date.now() + CACHE_TTL_MS, items });
    return items;
  }
}
