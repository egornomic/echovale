import { JSDOM } from "jsdom";
import { extractHttpLinks } from "../../shared/article-links.js";
import type { AiArticleSourceKind } from "../../shared/types.js";
import type { AiArticleRecord } from "../features/shared.js";
import { AiError } from "./errors.js";

export const ARTICLE_TRANSLATION_PROMPT_VERSION = 2;
export const ARTICLE_TRANSLATION_MAX_OUTPUT_TOKENS = 32_000;

export interface PreparedArticleTranslation {
  input: string;
  sourceKind: AiArticleSourceKind;
  sourceHtml: string;
  segmentCount: number;
}

interface TranslationSegment {
  node: Text;
  prefix: string;
  text: string;
  suffix: string;
}

const UNTRANSLATED_ELEMENTS = new Set(["CODE", "KBD", "PRE", "SAMP", "VAR"]);
const URL_ONLY_PATTERN = /^(?:https?:\/\/|mailto:)[^\s]+$/iu;

function fragmentHtml(fragment: DocumentFragment): string {
  const container = fragment.ownerDocument.createElement("div");
  container.append(fragment);
  return container.innerHTML.trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlText(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function linkifiedParagraph(text: string): string {
  const links = extractHttpLinks(text);
  if (links.length === 0) return htmlText(text);

  const parts: string[] = [];
  let cursor = 0;
  for (const link of links) {
    parts.push(htmlText(text.slice(cursor, link.start)));
    parts.push(
      `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.text)}</a>`,
    );
    cursor = link.end;
  }
  parts.push(htmlText(text.slice(cursor)));
  return parts.join("");
}

function plainTextHtml(value: string): string {
  return value
    .split(/\n{2,}/u)
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => `<p>${linkifiedParagraph(paragraph)}</p>`)
    .join("");
}

function selectedSourceHtml(
  article: AiArticleRecord,
  sourceKind: AiArticleSourceKind,
): string | null {
  if (sourceKind === "full") return article.contentHtml;
  if (sourceKind === "feed") return article.feedContentHtml;
  return plainTextHtml(article.excerpt);
}

function isUntranslatedElement(element: Element): boolean {
  return UNTRANSLATED_ELEMENTS.has(element.tagName);
}

function translationSegments(root: ParentNode): TranslationSegment[] {
  const segments: TranslationSegment[] = [];

  const visit = (node: Node): void => {
    if (node.nodeType === node.TEXT_NODE) {
      const textNode = node as Text;
      const value = textNode.data;
      const first = value.search(/\S/u);
      if (first < 0) return;
      const last = value.search(/\s*$/u);
      const text = value.slice(first, last);
      if (!/\p{L}/u.test(text) || URL_ONLY_PATTERN.test(text)) return;
      segments.push({
        node: textNode,
        prefix: value.slice(0, first),
        text,
        suffix: value.slice(last),
      });
      return;
    }
    if (node.nodeType === node.ELEMENT_NODE && isUntranslatedElement(node as Element)) return;
    for (const child of node.childNodes) visit(child);
  };

  for (const child of root.childNodes) visit(child);
  return segments;
}

function promptHtml(sourceHtml: string): { html: string; segmentCount: number } {
  const fragment = JSDOM.fragment(sourceHtml);
  const segments = translationSegments(fragment);
  for (const [id, segment] of segments.entries()) {
    const marker = fragment.ownerDocument.createElement("span");
    marker.setAttribute("data-translation-id", String(id));
    marker.textContent = segment.text;
    segment.node.replaceWith(segment.prefix, marker, segment.suffix);
  }
  for (const element of fragment.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name !== "data-translation-id") element.removeAttribute(attribute.name);
    }
  }
  return { html: fragmentHtml(fragment), segmentCount: segments.length };
}

function invalidTranslationResponse(): AiError {
  return new AiError(
    "AI_RESPONSE_INVALID",
    502,
    "The AI provider returned an incomplete translation. Try the translation again.",
  );
}

function translatedSegments(value: string, count: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidTranslationResponse();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidTranslationResponse();
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== count) throw invalidTranslationResponse();
  return Array.from({ length: count }, (_, id) => {
    const translated = record[String(id)];
    if (typeof translated !== "string" || !translated.trim()) {
      throw invalidTranslationResponse();
    }
    return translated;
  });
}

export function prepareArticleTranslation(
  article: AiArticleRecord,
  targetLanguage: string,
  sourceKind: AiArticleSourceKind,
): PreparedArticleTranslation {
  const sourceHtml = selectedSourceHtml(article, sourceKind)?.trim();
  if (!sourceHtml) {
    throw new AiError(
      "ARTICLE_HAS_NO_TEXT",
      422,
      "This article view has no text to translate. Choose another view or open the source.",
    );
  }
  const prompt = promptHtml(sourceHtml);
  if (prompt.segmentCount === 0) {
    throw new AiError(
      "ARTICLE_HAS_NO_TEXT",
      422,
      "This article view has no text to translate. Choose another view or open the source.",
    );
  }
  return {
    sourceKind,
    sourceHtml,
    segmentCount: prompt.segmentCount,
    input: `Target language: ${targetLanguage}\n\nArticle HTML:\n${prompt.html}`,
  };
}

export function renderArticleTranslation(
  prepared: PreparedArticleTranslation,
  generatedText: string,
): string {
  const translated = translatedSegments(generatedText, prepared.segmentCount);
  const fragment = JSDOM.fragment(prepared.sourceHtml);
  const segments = translationSegments(fragment);
  if (segments.length !== prepared.segmentCount) throw invalidTranslationResponse();
  for (const [id, segment] of segments.entries()) {
    segment.node.data = `${segment.prefix}${translated[id]}${segment.suffix}`;
  }
  return fragmentHtml(fragment);
}
