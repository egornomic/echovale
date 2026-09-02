import { fetchPublic } from "./public-network.js";
import type { QuotaService } from "./quota.js";

const CACHE_TTL_MS = 60_000;
const USER_AGENT = "feedfold/0.2 (+self-hosted feed reader)";

export interface XPostMedia {
  url: string;
  posterUrl: string | null;
  aspectRatio: number | null;
}

interface CachedXMedia {
  expiresAt: number;
  media: XPostMedia;
}

type PublicFetcher = (value: string, options?: RequestInit) => Promise<Response>;

export interface XVideoResponse {
  response: Response;
  cancel: () => void;
}

function trustedCdnUrl(value: unknown, hostname: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === hostname ? url.href : null;
  } catch {
    return null;
  }
}

export function xSyndicationToken(postId: string): string {
  if (!/^\d{1,30}$/.test(postId)) throw new Error("Invalid X post ID");
  return ((Number(postId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

export function parseXPostMedia(payload: unknown): XPostMedia {
  const root = payload as {
    mediaDetails?: unknown;
    video?: unknown;
  };
  const details = Array.isArray(root?.mediaDetails) ? root.mediaDetails : [];
  const detail = details.find(
    (item) =>
      (item as { type?: unknown })?.type === "video" ||
      (item as { type?: unknown })?.type === "animated_gif",
  ) as
    | {
        media_url_https?: unknown;
        video_info?: { aspect_ratio?: unknown; variants?: unknown };
      }
    | undefined;
  const legacyVideo = root?.video as
    | { poster?: unknown; aspectRatio?: unknown; variants?: unknown }
    | undefined;
  const variants = Array.isArray(detail?.video_info?.variants)
    ? detail.video_info.variants
    : Array.isArray(legacyVideo?.variants)
      ? legacyVideo.variants
      : [];
  const playable = variants
    .map(
      (variant) =>
        variant as {
          content_type?: unknown;
          type?: unknown;
          bitrate?: unknown;
          url?: unknown;
          src?: unknown;
        },
    )
    .filter((variant) => (variant.content_type ?? variant.type) === "video/mp4")
    .map((variant) => ({
      bitrate: typeof variant.bitrate === "number" ? variant.bitrate : 0,
      url: trustedCdnUrl(variant.url ?? variant.src, "video.twimg.com"),
    }))
    .filter((variant): variant is { bitrate: number; url: string } => Boolean(variant.url))
    .sort((left, right) => right.bitrate - left.bitrate)[0];
  if (!playable) throw new Error("X post did not expose a playable MP4");

  const ratio = detail?.video_info?.aspect_ratio ?? legacyVideo?.aspectRatio;
  const aspectRatio =
    Array.isArray(ratio) &&
    typeof ratio[0] === "number" &&
    typeof ratio[1] === "number" &&
    ratio[0] > 0 &&
    ratio[1] > 0
      ? ratio[0] / ratio[1]
      : null;
  return {
    url: playable.url,
    posterUrl: trustedCdnUrl(detail?.media_url_https ?? legacyVideo?.poster, "pbs.twimg.com"),
    aspectRatio,
  };
}

export class XMediaService {
  private readonly cache = new Map<string, CachedXMedia>();

  constructor(
    private readonly timeoutMs = 15_000,
    private readonly fetcher: PublicFetcher = fetchPublic,
    private readonly quotas?: QuotaService,
  ) {}

  async mediaForPost(postId: string): Promise<XPostMedia> {
    const cached = this.cache.get(postId);
    if (cached && cached.expiresAt > Date.now()) return cached.media;
    const token = xSyndicationToken(postId);
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${postId}&lang=en&token=${token}`;
    const fetchMedia = () =>
      this.fetcher(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    const response = this.quotas ? await this.quotas.runOutbound(fetchMedia) : await fetchMedia();
    if (!response.ok) throw new Error(`X syndication returned HTTP ${response.status}`);
    const media = parseXPostMedia(await response.json());
    this.cache.set(postId, { expiresAt: Date.now() + CACHE_TTL_MS, media });
    return media;
  }

  async videoResponse(media: XPostMedia, range?: string): Promise<XVideoResponse> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const armTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    };
    const cancel = () => {
      clearTimeout(timeout);
      controller.abort();
    };
    armTimeout();
    try {
      const fetchMedia = () =>
        this.fetcher(media.url, {
          headers: {
            Accept: "video/mp4",
            "User-Agent": USER_AGENT,
            ...(range ? { Range: range } : {}),
          },
          redirect: "follow",
          signal: controller.signal,
        });
      const response = this.quotas ? await this.quotas.runOutbound(fetchMedia) : await fetchMedia();
      if (!response.ok && response.status !== 416) {
        throw new Error(`X video returned HTTP ${response.status}`);
      }
      const body = response.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, stream) {
            armTimeout();
            stream.enqueue(chunk);
          },
          flush() {
            clearTimeout(timeout);
          },
        }),
      );
      return {
        response: body
          ? new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            })
          : response,
        cancel,
      };
    } catch (error) {
      cancel();
      throw error;
    }
  }
}
