import { JSDOM } from "jsdom";
import { FEED_PREVIEW_ARTICLE_LIMIT } from "../shared/feed-preview.js";
import type { FeedDiscoveryResult, FeedErrorKind, FeedPreview } from "../shared/types.js";
import { xFeedUrl } from "../shared/x.js";
import type { ParsedFeed } from "./features/shared.js";
import { fetchFeed, githubFeedUrl } from "./feed-http.js";
import { parseAndNormalizeFeed } from "./feed-parser.js";
import { PublicNetworkError } from "./public-network.js";
import { parseAndNormalizeTelegramFeed, telegramChannelUrls } from "./telegram-feed.js";
import { fetchXFeed, nitterBaseUrls, XFeedError } from "./x-feed.js";

const USER_AGENT = "feedfold/0.1 (+self-hosted feed reader)";
const FEED_ACCEPT =
  "application/atom+xml,application/rss+xml,application/feed+json,application/json;q=0.9,application/xml;q=0.8,text/xml;q=0.8,text/html;q=0.7,*/*;q=0.5";
const FEED_MIME_TYPES = new Set([
  "application/atom+xml",
  "application/feed+json",
  "application/json",
  "application/rss+xml",
  "application/xml",
  "text/xml",
]);
const COMMON_FEED_PATHS = ["/feed", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"];

export class FeedDiscoveryError extends Error {
  constructor(
    message: string,
    readonly kind: FeedErrorKind,
  ) {
    super(message);
    this.name = "FeedDiscoveryError";
  }
}

function preview(parsed: ParsedFeed, feedUrl: string): FeedPreview {
  return {
    feedUrl,
    title: parsed.title,
    siteUrl: parsed.siteUrl,
    totalArticles: parsed.articles.length,
    articles: parsed.articles.slice(0, FEED_PREVIEW_ARTICLE_LIMIT).map((article) => ({
      title: article.title,
      url: article.url,
      author: article.author,
      publishedAt: article.publishedAt,
      summary: article.summary,
      imageUrl: article.imageUrl,
    })),
  };
}

function parsePreview(source: string, feedUrl: string): FeedPreview | null {
  try {
    return preview(parseAndNormalizeFeed(source, feedUrl), feedUrl);
  } catch {
    return null;
  }
}

function isFeedReference(value: string): boolean {
  return /(^|[^a-z])(rss|atom|feed)([^a-z]|$)/i.test(value) || /\.xml(?:[?#]|$)/i.test(value);
}

function resolvedHttpUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function feedCandidates(source: string, pageUrl: string): string[] {
  const candidates: string[] = [];
  const seen = new Set([new URL(pageUrl).toString()]);
  const add = (value: string | null): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };
  add(githubFeedUrl(pageUrl));
  const dom = new JSDOM(source, { url: pageUrl });
  try {
    for (const link of dom.window.document.querySelectorAll<HTMLLinkElement>(
      'link[rel~="alternate"][href]',
    )) {
      const type = link.type.split(";", 1)[0]?.trim().toLowerCase();
      if (!FEED_MIME_TYPES.has(type) && !isFeedReference(`${link.title} ${link.href}`)) continue;
      add(resolvedHttpUrl(link.getAttribute("href") ?? "", pageUrl));
    }
    for (const link of dom.window.document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const href = link.getAttribute("href") ?? "";
      if (!isFeedReference(`${link.textContent ?? ""} ${href}`)) continue;
      add(resolvedHttpUrl(href, pageUrl));
    }
  } finally {
    dom.window.close();
  }
  const origin = new URL(pageUrl).origin;
  for (const path of COMMON_FEED_PATHS) add(new URL(path, origin).toString());
  return candidates;
}

async function fetchSource(
  url: string,
  signal: AbortSignal,
  required: boolean,
  fetcher: typeof fetchFeed,
  runOutbound: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<{ source: string; url: string; contentType: string | null } | null> {
  let response: Response;
  try {
    response = await runOutbound(() =>
      fetcher(url, {
        headers: { Accept: FEED_ACCEPT, "User-Agent": USER_AGENT },
        redirect: "follow",
        signal,
      }),
    );
  } catch (error) {
    if (signal.aborted) {
      throw new FeedDiscoveryError("This address did not respond in time. Try again.", "timeout");
    }
    if (error instanceof PublicNetworkError) {
      if (required) throw new FeedDiscoveryError(error.message, error.kind);
      return null;
    }
    if (required) {
      throw new FeedDiscoveryError(
        "Could not reach this address. Check it, then try again.",
        "network",
      );
    }
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (required) {
      const inaccessible = response.status === 401 || response.status === 403;
      throw new FeedDiscoveryError(
        inaccessible
          ? "This page is not public. Use a page that does not require sign-in."
          : `This address returned HTTP ${response.status}.`,
        inaccessible ? "inaccessible" : "http",
      );
    }
    return null;
  }
  return {
    source: await response.text(),
    url: response.url || url,
    contentType: response.headers.get("content-type"),
  };
}

function pageTitle(source: string, pageUrl: string): string {
  const dom = new JSDOM(source, { url: pageUrl });
  try {
    return (
      dom.window.document.title.trim() || new URL(pageUrl).hostname.replace(/^www\./, "") || pageUrl
    );
  } finally {
    dom.window.close();
  }
}

function isHtmlPage(contentType: string | null, source: string): boolean {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml") return true;
  if (type && type !== "text/plain" && type !== "application/octet-stream") return false;
  return /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(source);
}

export async function discoverFeed(
  inputUrl: string,
  timeoutMs = 15_000,
  fetcher: typeof fetchFeed = fetchFeed,
  runOutbound: <T>(task: () => Promise<T>) => Promise<T> = (task) => task(),
): Promise<FeedDiscoveryResult> {
  const input = new URL(inputUrl).toString();
  const xUrl = xFeedUrl(input, nitterBaseUrls());
  if (xUrl) {
    try {
      return {
        kind: "published",
        preview: preview(await fetchXFeed(xUrl, timeoutMs, fetcher, runOutbound), xUrl),
      };
    } catch (error) {
      if (error instanceof XFeedError) throw new FeedDiscoveryError(error.message, error.kind);
      throw error;
    }
  }
  const url = input;
  const telegram = telegramChannelUrls(url);
  const signal = AbortSignal.timeout(timeoutMs);
  const page = await fetchSource(telegram?.previewUrl ?? url, signal, true, fetcher, runOutbound);
  if (!page)
    throw new FeedDiscoveryError(
      "Could not load this address. Check it, then try again.",
      "network",
    );
  if (telegram) {
    try {
      return {
        kind: "published",
        preview: preview(
          parseAndNormalizeTelegramFeed(page.source, telegram.channelUrl),
          telegram.channelUrl,
        ),
      };
    } catch {
      throw new FeedDiscoveryError(
        "Could not read a public Telegram channel at this address.",
        "parse",
      );
    }
  }
  const direct = parsePreview(page.source, page.url);
  if (direct) return { kind: "published", preview: direct };

  for (const candidate of feedCandidates(page.source, page.url)) {
    const result = await fetchSource(candidate, signal, false, fetcher, runOutbound);
    if (!result) continue;
    const found = parsePreview(result.source, result.url);
    if (found) return { kind: "published", preview: found };
  }

  if (!isHtmlPage(page.contentType, page.source)) {
    throw new FeedDiscoveryError(
      "This address is not an HTML page, RSS feed, Atom feed, or JSON Feed.",
      "unsupported_content",
    );
  }

  return {
    kind: "web_page",
    pageUrl: page.url,
    title: pageTitle(page.source, page.url),
  };
}
