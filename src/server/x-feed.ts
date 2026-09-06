import { JSDOM } from "jsdom";
import type { FeedErrorKind } from "../shared/types.js";
import { xFeedUrl, xPostId } from "../shared/x.js";
import type { ParsedFeed } from "./features/shared.js";
import { fetchFeed } from "./feed-http.js";
import { parseAndNormalizeFeed } from "./feed-parser.js";
import { QuotaExceededError } from "./quota.js";

const DEFAULT_NITTER_BASE_URLS: [string, ...string[]] = [
  "https://nitter.xitter.cc",
  "https://nitter.meowing.monster",
  "https://nitter.jaydenha.uk",
];

export function nitterBaseUrls(value = process.env.NITTER_BASE_URLS): [string, ...string[]] {
  if (!value?.trim()) return [...DEFAULT_NITTER_BASE_URLS];
  return [
    ...new Set(
      value.split(",").map((entry) => {
        const message =
          "NITTER_BASE_URLS must contain comma-separated HTTP(S) origins without paths or credentials.";
        if (!URL.canParse(entry.trim())) throw new Error(message);
        const url = new URL(entry.trim());
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        ) {
          throw new Error(message);
        }
        return url.origin;
      }),
    ),
  ] as [string, ...string[]];
}

export function nitterTimelineUrl(feedUrl: string, baseUrl: string): string {
  const url = new URL(feedUrl);
  return new URL(`${url.pathname}${url.search}`, baseUrl).toString();
}

export function xContentUrl(value: string | null, instanceUrl: string): string | null {
  if (!value || !URL.canParse(value, instanceUrl)) return value;
  const url = new URL(value, instanceUrl);
  if (url.host !== new URL(instanceUrl).host) return url.toString();
  if (url.pathname.startsWith("/pic/")) {
    const path = decodeURIComponent(url.pathname.slice("/pic/".length));
    if (
      /^(?:media|card_img|profile_images|amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\//.test(
        path,
      )
    ) {
      return `https://pbs.twimg.com/${path}${url.search}`;
    }
    if (/^(?:video|pbs)\.twimg\.com\//.test(path)) return `https://${path}${url.search}`;
    return url.toString();
  }
  const canonical = new URL(`${url.pathname}${url.search}${url.hash}`, "https://x.com");
  return xPostId(canonical.toString()) || xFeedUrl(canonical.toString())
    ? canonical.toString()
    : url.toString();
}

export function xContentHtml(html: string | null, instanceUrl: string): string | null {
  if (!html) return html;
  const dom = new JSDOM(html);
  try {
    for (const element of dom.window.document.querySelectorAll("[href], [src], [poster]")) {
      for (const attribute of ["href", "src", "poster"]) {
        const value = element.getAttribute(attribute);
        if (value) element.setAttribute(attribute, xContentUrl(value, instanceUrl) ?? value);
      }
    }
    return dom.window.document.body.innerHTML;
  } finally {
    dom.window.close();
  }
}

export function normalizeXFeed(parsed: ParsedFeed, instanceUrl: string): ParsedFeed {
  return {
    ...parsed,
    siteUrl: xContentUrl(parsed.siteUrl, instanceUrl),
    articles: parsed.articles.map((article) => ({
      ...article,
      url: xContentUrl(article.url, instanceUrl),
      imageUrl: xContentUrl(article.imageUrl, instanceUrl),
      feedContentHtml: xContentHtml(article.feedContentHtml, instanceUrl),
    })),
  };
}

export class XFeedError extends Error {
  constructor(
    message: string,
    readonly kind: FeedErrorKind,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "XFeedError";
  }
}

export async function fetchXFeed(
  feedUrl: string,
  timeoutMs = 15_000,
  fetcher: typeof fetchFeed = fetchFeed,
  runOutbound: <T>(task: () => Promise<T>) => Promise<T> = (task) => task(),
  baseUrls = nitterBaseUrls(),
): Promise<ParsedFeed> {
  const failures: string[] = [];
  let kind: FeedErrorKind = "network";
  let status: number | null = null;
  for (const baseUrl of baseUrls) {
    const signal = AbortSignal.timeout(timeoutMs);
    status = null;
    kind = "network";
    try {
      const response = await runOutbound(() =>
        fetcher(nitterTimelineUrl(feedUrl, baseUrl), {
          headers: {
            Accept: "application/rss+xml",
            "User-Agent": "feedfold/0.1 (+self-hosted feed reader)",
          },
          redirect: "follow",
          signal,
        }),
      );
      status = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        kind = response.status === 401 || response.status === 403 ? "access_blocked" : "http";
        throw new Error(`HTTP ${response.status}`);
      }
      const source = await response.text();
      kind = "parse";
      const parsed = normalizeXFeed(
        parseAndNormalizeFeed(source, feedUrl),
        response.url || baseUrl,
      );
      if (parsed.articles.some((article) => !xPostId(article.url))) {
        throw new Error("RSS contains a notice instead of X posts");
      }
      return parsed;
    } catch (error) {
      if (error instanceof QuotaExceededError) throw error;
      if (signal.aborted) kind = "timeout";
      failures.push(
        `${new URL(baseUrl).host}: ${signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new XFeedError(
    `Could not load X RSS from any configured instance. ${failures.join("; ")}`,
    kind,
    status,
  );
}
