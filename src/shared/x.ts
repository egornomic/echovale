const NITTER_HOST = "nitter.net";
const STATUS_ID = /^\d{1,30}$/;
const ANCHOR = /<a\b[^>]*\bhref=(['"])(.*?)\1[^>]*>[\s\S]*?<\/a>/gi;

function decodedAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#0*39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

export function nitterPostId(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(decodedAttribute(value));
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== NITTER_HOST) return null;
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

export function nitterVideoPostId(
  articleUrl: string | null | undefined,
  feedContentHtml: string | null | undefined,
): string | null {
  if (feedContentHtml) {
    for (const match of feedContentHtml.matchAll(ANCHOR)) {
      const anchor = match[0];
      const postId = nitterPostId(match[2]);
      if (postId && isVideoAnchor(anchor)) return postId;
    }
  }
  return feedContentHtml && /(?:amplify|ext_tw)_video_thumb/i.test(feedContentHtml)
    ? nitterPostId(articleUrl)
    : null;
}

export function nitterVideoPlaceholderId(articleId: number): string {
  return `article-${articleId}-x-video`;
}

export function withNitterVideoPlaceholder(
  html: string,
  postId: string,
  articleId: number,
): string {
  const placeholder = `<div id="${nitterVideoPlaceholderId(articleId)}"></div>`;
  return html.replace(ANCHOR, (anchor, _quote: string, href: string) =>
    nitterPostId(href) === postId && isVideoAnchor(anchor) ? placeholder : anchor,
  );
}
