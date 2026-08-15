import { JSDOM } from "jsdom";
import parseSrcset from "parse-srcset";
import sanitizeHtml from "sanitize-html";
import { isTelegramPostUrl } from "../shared/telegram.js";
import { nitterPostId } from "../shared/x.js";

const TABLE_SCROLL_CLASS = "article-table-scroll";
const QUOTE_FIGURE_CLASS = "article-quote";
const PROSE_QUOTE_CLASS = "article-prose-quote";
const PROSE_QUOTE_MARKED_CLASS = "article-prose-quote-marked";
const QUOTE_MARK_CLASS = "article-quote-mark";
const SCROLLABLE_TABLE_LABEL = "Scrollable table";
const CALLOUT_PREFIX_PATTERN =
  /^(?:\[\s*!\s*(?:note|tip|warning|important|caution)\s*\]|(?:a|side)\s+note\b|(?:note|tip|warning|important|caution|abstract|source|failsafe|disclaimer|reminder|update|takeaway|summary)\b|system\s+message\b|table\s+of\s+contents\b|bottom\s+line\b|tl\s*;\s*dr\b)/i;
const COMPLEX_QUOTE_CONTENT =
  "blockquote, pre, code, ul, ol, dl, table, img, picture, video, audio, iframe, h1, h2, h3, h4, h5, h6, div";

function fragmentHtml(fragment: DocumentFragment): string {
  const container = fragment.ownerDocument.createElement("div");
  container.append(fragment);
  return container.innerHTML.trim();
}

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    "article",
    "section",
    "header",
    "footer",
    "main",
    "aside",
    "nav",
    "div",
    "span",
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "code",
    "kbd",
    "samp",
    "var",
    "cite",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "sub",
    "sup",
    "mark",
    "small",
    "a",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "figure",
    "figcaption",
    "picture",
    "img",
    "video",
    "source",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "time",
  ],
  allowedAttributes: {
    div: ["class"],
    a: ["href", "title", "target", "rel"],
    img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
    video: [
      "src",
      "poster",
      "width",
      "height",
      "controls",
      "autoplay",
      "muted",
      "loop",
      "playsinline",
      "preload",
    ],
    source: ["src", "srcset", "type", "media", "sizes"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan", "scope"],
    time: ["datetime"],
  },
  allowedClasses: {
    div: [TABLE_SCROLL_CLASS],
    figure: [QUOTE_FIGURE_CLASS],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
    video: ["http", "https"],
    source: ["http", "https"],
  },
  allowProtocolRelative: false,
};

function stripGeneratedQuoteMarkers(html: string): string {
  if (!html.includes(QUOTE_MARK_CLASS)) return html;

  const fragment = JSDOM.fragment(html);
  for (const marker of fragment.querySelectorAll(`span.${QUOTE_MARK_CLASS}`)) {
    const isGeneratedMarker =
      marker.parentElement?.tagName === "BLOCKQUOTE" &&
      marker.parentElement.firstElementChild === marker &&
      marker.getAttribute("aria-hidden") === "true" &&
      marker.children.length === 0 &&
      marker.textContent === "“";
    if (isGeneratedMarker) marker.remove();
  }
  return fragmentHtml(fragment);
}

function enrichArticleStructure(html: string, baseUrl?: string): string {
  if (!/<(?:blockquote|table)\b/i.test(html)) return html;

  const fragment = JSDOM.fragment(html);
  const isTelegramArticle = baseUrl ? isTelegramPostUrl(baseUrl) : false;
  const isNitterArticle = nitterPostId(baseUrl) !== null;
  for (const blockquote of fragment.querySelectorAll("blockquote")) {
    for (const marker of blockquote.querySelectorAll(`:scope > span.${QUOTE_MARK_CLASS}`)) {
      marker.remove();
    }
    blockquote.classList.remove(PROSE_QUOTE_CLASS, PROSE_QUOTE_MARKED_CLASS);

    const text = (blockquote.textContent ?? "").replace(/\s+/g, " ").trim();
    const directChildren = [...blockquote.children];
    const hasParagraphStructure =
      directChildren.length > 0 && directChildren.every((child) => child.tagName === "P");
    const isQuotedTextOnly = directChildren.length === 0 && /^[“"]/.test(text);
    const nitterQuoteSource = isNitterArticle
      ? blockquote.querySelector(":scope > footer cite a[href]")?.getAttribute("href")
      : null;
    const isNitterQuote = nitterPostId(nitterQuoteSource) !== null;
    const isProseQuote =
      text.length > 0 &&
      (hasParagraphStructure || isQuotedTextOnly || isTelegramArticle || isNitterQuote) &&
      (isNitterQuote || !blockquote.querySelector(COMPLEX_QUOTE_CONTENT)) &&
      !CALLOUT_PREFIX_PATTERN.test(text);
    if (isProseQuote) {
      blockquote.classList.add(PROSE_QUOTE_CLASS);
      if (!/^[“"]/.test(text)) {
        blockquote.classList.add(PROSE_QUOTE_MARKED_CLASS);
        const marker = fragment.ownerDocument.createElement("span");
        marker.className = QUOTE_MARK_CLASS;
        marker.setAttribute("aria-hidden", "true");
        marker.textContent = "“";
        blockquote.prepend(marker);
      }
    }

    const attribution = blockquote.nextElementSibling;
    if (
      attribution?.tagName !== "P" ||
      !/^[—–]\s+/.test(attribution.textContent?.trimStart() ?? "")
    ) {
      continue;
    }

    const figure = fragment.ownerDocument.createElement("figure");
    figure.className = QUOTE_FIGURE_CLASS;
    const caption = fragment.ownerDocument.createElement("figcaption");
    while (attribution.firstChild) caption.append(attribution.firstChild);
    blockquote.before(figure);
    figure.append(blockquote, caption);
    attribution.remove();
  }

  for (const table of fragment.querySelectorAll("table")) {
    const rows = [...table.querySelectorAll("tr")]
      .filter((row) => row.closest("table") === table)
      .map((row) => [...row.children].filter((cell) => /^(?:TH|TD)$/.test(cell.tagName)));
    if (!rows.some((row) => row.length > 1)) continue;

    const caption = [...table.children].find((child) => child.tagName === "CAPTION");
    const hasTableHeading =
      [...table.querySelectorAll("th")].some((heading) => heading.closest("table") === table) ||
      Boolean(caption);
    const cells = rows.flat();
    const imageCellCount = cells.filter((cell) => cell.querySelector("img, picture")).length;
    const columnCount = Math.max(...rows.map((row) => row.length));
    const hasEmptyColumn = Array.from({ length: columnCount }, (_, index) =>
      rows.every((row) => !row[index]?.textContent?.trim()),
    ).some(Boolean);
    const linkedOrMediaOnlyCellCount = cells.filter((cell) => {
      const remainingContent = cell.cloneNode(true) as Element;
      for (const element of remainingContent.querySelectorAll("a, img, picture")) element.remove();
      return !remainingContent.textContent?.trim();
    }).length;
    const isHeaderlessDataTable =
      rows.length > 1 &&
      !table.querySelector("pre, code") &&
      !hasEmptyColumn &&
      Boolean(table.textContent?.trim()) &&
      imageCellCount < cells.length / 2 &&
      linkedOrMediaOnlyCellCount <= cells.length / 2;
    if (!hasTableHeading && !isHeaderlessDataTable) continue;

    const ancestorTable = table.parentElement?.closest("table");
    if (ancestorTable?.parentElement?.classList.contains(TABLE_SCROLL_CLASS)) continue;

    let wrapper = table.parentElement;
    if (!wrapper?.classList.contains(TABLE_SCROLL_CLASS)) {
      wrapper = fragment.ownerDocument.createElement("div");
      wrapper.className = TABLE_SCROLL_CLASS;
      table.before(wrapper);
      wrapper.append(table);
    }
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", caption?.textContent?.trim() || SCROLLABLE_TABLE_LABEL);
  }

  return fragmentHtml(fragment);
}

function absoluteUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function absoluteSrcset(value: string, baseUrl: string): string {
  return parseSrcset(value)
    .map(
      (candidate) =>
        absoluteUrl(candidate.url, baseUrl) +
        (candidate.w ? ` ${candidate.w}w` : "") +
        (candidate.h ? ` ${candidate.h}h` : "") +
        (candidate.d ? ` ${candidate.d}x` : ""),
    )
    .join(", ");
}

export function removeStoredSrcsetsWithFallback(html: string): string {
  if (!/\bsrcset\s*=/i.test(html)) return html;

  const fragment = JSDOM.fragment(html);
  let changed = false;
  for (const image of fragment.querySelectorAll("img[src][srcset]")) {
    image.removeAttribute("srcset");
    changed = true;
  }
  for (const picture of fragment.querySelectorAll("picture")) {
    if (!picture.querySelector("img[src]")) continue;
    for (const source of picture.querySelectorAll("source[srcset]")) {
      source.remove();
      changed = true;
    }
  }

  return changed ? fragmentHtml(fragment) : html;
}

export function cleanArticleHtml(html: string, baseUrl?: string): string {
  const transformTags: sanitizeHtml.IOptions["transformTags"] = baseUrl
    ? {
        a: (tagName, attributes) => ({
          tagName,
          attribs: {
            ...attributes,
            ...(attributes.href
              ? {
                  href: absoluteUrl(attributes.href, baseUrl),
                  target: "_blank",
                  rel: "noopener noreferrer",
                }
              : {}),
          },
        }),
        img: (tagName, attributes) => ({
          tagName,
          attribs: {
            ...attributes,
            ...(attributes.src ? { src: absoluteUrl(attributes.src, baseUrl) } : {}),
            ...(attributes.srcset ? { srcset: absoluteSrcset(attributes.srcset, baseUrl) } : {}),
          },
        }),
        video: (tagName, attributes) => ({
          tagName,
          attribs: {
            ...attributes,
            ...(attributes.src ? { src: absoluteUrl(attributes.src, baseUrl) } : {}),
            ...(attributes.poster ? { poster: absoluteUrl(attributes.poster, baseUrl) } : {}),
          },
        }),
        source: (tagName, attributes) => ({
          tagName,
          attribs: {
            ...attributes,
            ...(attributes.src ? { src: absoluteUrl(attributes.src, baseUrl) } : {}),
            ...(attributes.srcset ? { srcset: absoluteSrcset(attributes.srcset, baseUrl) } : {}),
          },
        }),
      }
    : undefined;
  const sanitized = sanitizeHtml(stripGeneratedQuoteMarkers(html), {
    ...sanitizeOptions,
    transformTags,
  }).trim();
  return enrichArticleStructure(sanitized, baseUrl);
}
