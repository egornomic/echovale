const X_HOST = "x.com";
const X_USERNAME = /^[a-zA-Z0-9_]{1,15}$/;
const X_TIMELINE_TABS = new Set(["media", "search", "with_replies"]);
const STATUS_ID = /^\d{1,30}$/;
const ANCHOR = /<a\b[^>]*\bhref=(['"])(.*?)\1[^>]*>[\s\S]*?<\/a>/gi;

function decodedAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#0*39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

export function xFeedUrl(value: string, instanceUrls: readonly string[] = []): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  if (url.host !== X_HOST && !instanceUrls.some((base) => new URL(base).host === url.host)) {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (!parts[0] || !X_USERNAME.test(parts[0])) return null;
  if (parts.length > 1 && parts.at(-1) === "rss") parts.pop();
  if (parts.length !== 1 && !(parts.length === 2 && X_TIMELINE_TABS.has(parts[1] ?? ""))) {
    return null;
  }
  url.protocol = "https:";
  url.host = X_HOST;
  url.port = "";
  url.pathname = `/${parts.join("/")}/rss`;
  url.hash = "";
  return url.toString();
}

export function xPostId(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(decodedAttribute(value));
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== X_HOST) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const statusIndex = parts.indexOf("status");
  const postId = statusIndex >= 0 ? parts[statusIndex + 1] : null;
  return postId && STATUS_ID.test(postId) ? postId : null;
}

function isVideoAnchor(anchor: string): boolean {
  if (!/<br\b[^>]*>\s*Video\s*<br\b[^>]*>/i.test(anchor)) return false;
  const text = anchor
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^Video$/i.test(text) && /<img\b/i.test(anchor);
}

export function xVideoPostId(
  articleUrl: string | null | undefined,
  feedContentHtml: string | null | undefined,
): string | null {
  if (feedContentHtml) {
    for (const match of feedContentHtml.matchAll(ANCHOR)) {
      const anchor = match[0];
      const postId = xPostId(match[2]);
      if (postId && isVideoAnchor(anchor)) return postId;
    }
  }
  return feedContentHtml && /(?:amplify|ext_tw)_video_thumb/i.test(feedContentHtml)
    ? xPostId(articleUrl)
    : null;
}

export function xVideoPlaceholderId(articleId: number): string {
  return `article-${articleId}-x-video`;
}

export function withXVideoPlaceholder(html: string, postId: string, articleId: number): string {
  const placeholder = `<div id="${xVideoPlaceholderId(articleId)}"></div>`;
  return html.replace(ANCHOR, (anchor, _quote: string, href: string) =>
    xPostId(href) === postId && isVideoAnchor(anchor) ? placeholder : anchor,
  );
}
