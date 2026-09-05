import { createHash } from "node:crypto";
import { parseFeed } from "feedsmith";
import sanitizeHtml from "sanitize-html";
import { xFeedUrl } from "../shared/x.js";
import { firstSafeImageUrl } from "./article-image.js";
import { youtubeMediaFromUrl } from "./article-media.js";
import type { ParsedArticle, ParsedFeed } from "./features/shared.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nestedString(value: unknown, key: string): string | null {
  return string(record(value)[key]);
}

function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const candidate of value) {
    const result = string(candidate);
    if (result) return result;
  }
  return null;
}

function url(value: unknown, baseUrl: string): string | null {
  const candidate = string(value);
  if (!candidate) return null;
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

function date(value: unknown): string | null {
  const candidate = string(value);
  if (!candidate) return null;
  const timestamp = Date.parse(candidate);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decodeTextEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function structuredPlainText(value: string | null): string {
  if (!value) return "";
  const text = sanitizeHtml(
    value.replace(/<br\b[^>]*>/gi, "\n").replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, "\n\n"),
    { allowedTags: [], allowedAttributes: {} },
  )
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return decodeTextEntities(text);
}

export function plainText(value: string | null): string {
  return structuredPlainText(value).replace(/\s+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fallbackId(parts: Array<string | null>): string {
  return `hash:${createHash("sha256").update(parts.filter(Boolean).join("\u0000")).digest("hex")}`;
}

function authorNames(value: unknown): string | null {
  const names = records(value)
    .map((author) => string(author.name))
    .filter((name): name is string => name !== null);
  return names.length ? names.join(", ") : null;
}

function normalizeRss(feed: UnknownRecord, feedUrl: string): ParsedFeed {
  const title = string(feed.title) ?? feedUrl;
  const siteUrl = url(feed.link, feedUrl);
  const titlesArePostText = xFeedUrl(feedUrl) !== null;
  const articles = records(feed.items).map((item): ParsedArticle => {
    const dc = record(item.dc);
    const content = record(item.content);
    const itemUrl = url(item.link, siteUrl ?? feedUrl);
    const publishedAt = date(item.pubDate) ?? date(firstString(dc.dates)) ?? date(dc.date);
    const feedContentHtml =
      string(content.encoded) ??
      string(item.description) ??
      firstString(dc.descriptions) ??
      string(dc.description);
    const summaryHtml =
      string(item.description) ??
      firstString(dc.descriptions) ??
      string(dc.description) ??
      feedContentHtml;
    const guid = nestedString(item.guid, "value");
    const itemTitle = titlesArePostText ? "" : (string(item.title) ?? "");
    const rawAuthors = Array.isArray(item.authors) ? item.authors : [];
    const authors = rawAuthors
      .map((author) => (typeof author === "string" ? string(author) : nestedString(author, "name")))
      .filter((author): author is string => author !== null);
    const author = authors.join(", ") || firstString(dc.creators) || string(dc.creator);
    return {
      externalId: guid ?? itemUrl ?? fallbackId([itemTitle, publishedAt, summaryHtml]),
      title: itemTitle,
      url: itemUrl,
      author,
      publishedAt,
      summary: plainText(summaryHtml).slice(0, 1_000),
      imageUrl: firstSafeImageUrl(feedContentHtml, itemUrl ?? siteUrl ?? feedUrl),
      feedContentHtml,
    };
  });
  return { title, siteUrl, articles };
}

function preferredAtomLink(links: unknown, baseUrl: string): string | null {
  const candidates = records(links);
  const preferred =
    candidates.find(
      (link) => string(link.rel) === "alternate" && !string(link.type)?.includes("xml"),
    ) ??
    candidates.find((link) => !string(link.rel) || string(link.rel) === "alternate") ??
    candidates[0];
  return preferred ? url(preferred.href, baseUrl) : null;
}

function normalizeAtom(feed: UnknownRecord, feedUrl: string): ParsedFeed {
  const title = string(feed.title) ?? feedUrl;
  const siteUrl = preferredAtomLink(feed.links, feedUrl);
  const feedAuthors = authorNames(feed.authors);
  const articles = records(feed.entries).map((entry): ParsedArticle => {
    const itemUrl = preferredAtomLink(entry.links, siteUrl ?? feedUrl);
    const publishedAt = date(entry.published) ?? date(entry.updated);
    const mediaGroup = record(record(entry.media).group);
    const mediaDescription = nestedString(mediaGroup.description, "value");
    const feedContentHtml = string(entry.content) ?? string(entry.summary);
    const summaryHtml = string(entry.summary) ?? mediaDescription ?? feedContentHtml;
    const itemTitle = string(entry.title) ?? nestedString(mediaGroup.title, "value") ?? "";
    const thumbnail = records(mediaGroup.thumbnails)[0];
    const community = record(mediaGroup.community);
    const rating = record(community.starRating);
    const media = youtubeMediaFromUrl(itemUrl, {
      videoId: nestedString(entry.yt, "videoId"),
      channelId: nestedString(entry.yt, "channelId"),
      thumbnailUrl: thumbnail ? url(thumbnail.url, itemUrl ?? siteUrl ?? feedUrl) : null,
      viewCount: number(record(community.statistics).views),
      ratingAverage: number(rating.average),
      ratingCount: number(rating.count),
    });
    return {
      externalId: string(entry.id) ?? itemUrl ?? fallbackId([itemTitle, publishedAt, summaryHtml]),
      title: itemTitle,
      url: itemUrl,
      author: authorNames(entry.authors) ?? feedAuthors,
      publishedAt,
      summary: plainText(summaryHtml).slice(0, 1_000),
      imageUrl:
        media?.thumbnailUrl ?? firstSafeImageUrl(feedContentHtml, itemUrl ?? siteUrl ?? feedUrl),
      media,
      feedContentHtml,
    };
  });
  return { title, siteUrl, articles };
}

function normalizeJson(feed: UnknownRecord, feedUrl: string): ParsedFeed {
  const title = string(feed.title) ?? feedUrl;
  const siteUrl = url(feed.home_page_url, feedUrl);
  const feedAuthors = authorNames(feed.authors);
  const articles = records(feed.items).map((item): ParsedArticle => {
    const itemUrl = url(item.url, siteUrl ?? feedUrl) ?? url(item.external_url, siteUrl ?? feedUrl);
    const publishedAt = date(item.date_published) ?? date(item.date_modified);
    const contentText = string(item.content_text);
    const contentHtml = string(item.content_html);
    const feedContentHtml =
      contentHtml ??
      (contentText ? `<p>${escapeHtml(contentText).replaceAll("\n", "<br>")}</p>` : null);
    const summary = string(item.summary) ?? contentText ?? contentHtml;
    const itemTitle = string(item.title) ?? "";
    return {
      externalId: string(item.id) ?? itemUrl ?? fallbackId([itemTitle, publishedAt, summary]),
      title: itemTitle,
      url: itemUrl,
      author: authorNames(item.authors) ?? feedAuthors,
      publishedAt,
      summary: plainText(summary).slice(0, 1_000),
      imageUrl: firstSafeImageUrl(feedContentHtml, itemUrl ?? siteUrl ?? feedUrl),
      feedContentHtml,
    };
  });
  return { title, siteUrl, articles };
}

function normalizeRdf(feed: UnknownRecord, feedUrl: string): ParsedFeed {
  const title = string(feed.title) ?? feedUrl;
  const siteUrl = url(feed.link, feedUrl);
  const articles = records(feed.items).map((item): ParsedArticle => {
    const dc = record(item.dc);
    const content = record(item.content);
    const itemUrl = url(item.link, siteUrl ?? feedUrl);
    const feedContentHtml =
      string(content.encoded) ??
      string(item.description) ??
      firstString(dc.descriptions) ??
      string(dc.description);
    const summaryHtml =
      string(item.description) ??
      firstString(dc.descriptions) ??
      string(dc.description) ??
      feedContentHtml;
    const publishedAt = date(firstString(dc.dates)) ?? date(dc.date);
    const itemTitle = string(item.title) ?? "";
    return {
      externalId:
        nestedString(item.rdf, "about") ??
        itemUrl ??
        fallbackId([itemTitle, publishedAt, summaryHtml]),
      title: itemTitle,
      url: itemUrl,
      author: firstString(dc.creators) ?? string(dc.creator),
      publishedAt,
      summary: plainText(summaryHtml).slice(0, 1_000),
      imageUrl: firstSafeImageUrl(feedContentHtml, itemUrl ?? siteUrl ?? feedUrl),
      feedContentHtml,
    };
  });
  return { title, siteUrl, articles };
}

export function parseAndNormalizeWordPressPosts(
  source: string,
  feedUrl: string,
  feedTitle: string,
): ParsedFeed {
  const siteUrl = new URL(feedUrl).origin;
  const articles = records(JSON.parse(source)).map((post): ParsedArticle => {
    const itemUrl = url(post.link, siteUrl);
    const excerptHtml = nestedString(post.excerpt, "rendered");
    const feedContentHtml = nestedString(post.content, "rendered") ?? excerptHtml;
    const summaryHtml = excerptHtml ?? feedContentHtml;
    const dateGmt = string(post.date_gmt);
    const publishedAt = date(dateGmt ? `${dateGmt}Z` : null) ?? date(post.date);
    const itemTitle = plainText(nestedString(post.title, "rendered"));
    return {
      externalId:
        nestedString(post.guid, "rendered") ??
        itemUrl ??
        fallbackId([itemTitle, publishedAt, summaryHtml]),
      title: itemTitle,
      url: itemUrl,
      author: null,
      publishedAt,
      summary: plainText(summaryHtml).slice(0, 1_000),
      imageUrl: firstSafeImageUrl(feedContentHtml, itemUrl ?? siteUrl),
      feedContentHtml,
    };
  });
  return { title: feedTitle, siteUrl, articles };
}

export function parseAndNormalizeFeed(source: string, feedUrl: string): ParsedFeed {
  const parsed = parseFeed(source);
  const feed = record(parsed.feed);
  if (parsed.format === "rss") return normalizeRss(feed, feedUrl);
  if (parsed.format === "atom") return normalizeAtom(feed, feedUrl);
  if (parsed.format === "json") return normalizeJson(feed, feedUrl);
  return normalizeRdf(feed, feedUrl);
}
