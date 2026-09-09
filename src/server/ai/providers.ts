import type { AiGrounding, AiProvider, AiUsage } from "../../shared/types.js";
import { AiError } from "./errors.js";
import type { AiGenerationResult, AiProviderAdapter } from "./types.js";

const EMPTY_USAGE: AiUsage = { inputTokens: null, outputTokens: null };

export interface AiProviderEndpoints {
  gemini?: string;
  openai?: string;
  anthropic?: string;
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerError(provider: string, status: number, body: unknown): AiError {
  const details = record(record(body)?.error);
  if (status === 401) {
    return new AiError(
      "AI_KEY_REJECTED",
      502,
      `${provider} rejected the saved API key. Update it in Settings.`,
    );
  }
  if (
    provider === "Google Gemini" &&
    status === 400 &&
    details?.status === "INVALID_ARGUMENT" &&
    typeof details.message === "string" &&
    details.message.includes("API key not valid")
  ) {
    return new AiError(
      "AI_KEY_REJECTED",
      502,
      `${provider} rejected the saved API key. Update it in Settings.`,
    );
  }
  if (
    provider === "Google Gemini" &&
    status === 400 &&
    details?.status === "FAILED_PRECONDITION" &&
    details.message === "User location is not supported for the API use."
  ) {
    return new AiError(
      "AI_REGION_UNSUPPORTED",
      422,
      "Google Gemini does not support the network location used by feedfold. Check the network or VPN on the device running feedfold, or choose another AI provider in Settings.",
    );
  }
  if (status === 429) {
    return new AiError(
      "AI_RATE_LIMITED",
      429,
      `${provider} is rate limiting requests. Try again shortly.`,
    );
  }
  if (status === 400 || status === 403 || status === 404 || status === 422) {
    return new AiError(
      "AI_MODEL_UNAVAILABLE",
      422,
      `The selected ${provider} model could not process this article. Check the model ID in Settings.`,
    );
  }
  return new AiError(
    "AI_PROVIDER_FAILED",
    502,
    `${provider} could not complete this request. Try again.`,
  );
}

async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new AiError(
        "AI_PROVIDER_TIMEOUT",
        504,
        `${provider} did not respond in time. Try again.`,
      );
    }
    throw new AiError("AI_PROVIDER_FAILED", 502, `${provider} could not be reached. Try again.`);
  }
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw providerError(provider, response.status, body);
  }
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AiError(
      "AI_PROVIDER_FAILED",
      502,
      `${provider} returned an unreadable response. Try again.`,
    );
  }
}

function requireText(provider: string, values: string[], refused = false): string {
  if (refused) {
    throw new AiError("AI_RESPONSE_REFUSED", 422, `${provider} could not process this article.`);
  }
  const text = values.join("").trim();
  if (text) return text;
  throw new AiError(
    "AI_PROVIDER_FAILED",
    502,
    `${provider} returned an empty response. Try again.`,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function addGroundingSource(
  sources: AiGrounding["sources"],
  sourceIndices: Map<string, number>,
  uriValue: unknown,
  titleValue: unknown,
): number | null {
  if (typeof uriValue !== "string" || typeof titleValue !== "string") return null;
  try {
    const uri = new URL(uriValue);
    if (uri.protocol !== "http:" && uri.protocol !== "https:") return null;
  } catch {
    return null;
  }
  const existing = sourceIndices.get(uriValue);
  if (existing !== undefined) return existing;
  const index = sources.length;
  sources.push({ uri: uriValue, title: titleValue });
  sourceIndices.set(uriValue, index);
  return index;
}

function citationGrounding(
  sources: AiGrounding["sources"],
  supports: AiGrounding["supports"],
): AiGrounding | null {
  return sources.length > 0 && supports.length > 0
    ? { sources, supports, searchSuggestionsHtml: null }
    : null;
}

function groundedSegmentRange(
  segment: Record<string, unknown>,
  text: string,
): { startIndex: number; endIndex: number } | null {
  if (
    typeof segment.startIndex !== "number" ||
    typeof segment.endIndex !== "number" ||
    !Number.isInteger(segment.startIndex) ||
    !Number.isInteger(segment.endIndex) ||
    segment.startIndex < 0 ||
    segment.endIndex <= segment.startIndex
  ) {
    return null;
  }
  let startIndex = segment.startIndex;
  let endIndex = segment.endIndex;
  if (
    typeof segment.text === "string" &&
    segment.text.length > 0 &&
    text.slice(startIndex, endIndex) !== segment.text
  ) {
    let nearestIndex = -1;
    for (
      let matchIndex = text.indexOf(segment.text);
      matchIndex >= 0;
      matchIndex = text.indexOf(segment.text, matchIndex + 1)
    ) {
      if (
        nearestIndex < 0 ||
        Math.abs(matchIndex - startIndex) < Math.abs(nearestIndex - startIndex)
      ) {
        nearestIndex = matchIndex;
      }
    }
    if (nearestIndex >= 0) {
      startIndex = nearestIndex;
      endIndex = startIndex + segment.text.length;
    }
  }
  return endIndex <= text.length ? { startIndex, endIndex } : null;
}

function geminiGrounding(value: unknown, text: string): AiGrounding | null {
  const metadata = record(value);
  if (!metadata) return null;
  const queries = Array.isArray(metadata.webSearchQueries) ? metadata.webSearchQueries : [];
  const searchEntryPoint = record(metadata.searchEntryPoint);
  const searchSuggestionsHtml = searchEntryPoint?.renderedContent;
  if (queries.length === 0 && typeof searchSuggestionsHtml !== "string") return null;
  if (typeof searchSuggestionsHtml !== "string" || !searchSuggestionsHtml.trim()) {
    throw new AiError(
      "AI_PROVIDER_FAILED",
      502,
      "Google Gemini omitted the required Search Suggestions. Try again.",
    );
  }

  const sources = [] as AiGrounding["sources"];
  const sourceIndices = new Map<number, number>();
  const chunks = Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : [];
  for (const [chunkIndex, chunkValue] of chunks.entries()) {
    const web = record(record(chunkValue)?.web);
    if (typeof web?.uri !== "string" || typeof web.title !== "string") continue;
    try {
      const uri = new URL(web.uri);
      if (uri.protocol !== "http:" && uri.protocol !== "https:") continue;
      sourceIndices.set(chunkIndex, sources.length);
      sources.push({ uri: web.uri, title: web.title });
    } catch {}
  }

  const supports = [] as AiGrounding["supports"];
  const groundingSupports = Array.isArray(metadata.groundingSupports)
    ? metadata.groundingSupports
    : [];
  for (const supportValue of groundingSupports) {
    const support = record(supportValue);
    const segment = record(support?.segment);
    if (!segment) continue;
    const range = groundedSegmentRange(segment, text);
    if (!range) continue;
    const indices = Array.isArray(support?.groundingChunkIndices)
      ? support.groundingChunkIndices
          .map((index) => (typeof index === "number" ? sourceIndices.get(index) : undefined))
          .filter((index): index is number => index !== undefined)
      : [];
    if (indices.length === 0) continue;
    supports.push({
      ...range,
      sourceIndices: [...new Set(indices)],
    });
  }

  return { sources, supports, searchSuggestionsHtml };
}

function geminiAdapter(baseUrl: string): AiProviderAdapter {
  const label = "Google Gemini";
  return {
    id: "gemini",
    label,
    defaultModel: "gemini-3.6-flash",
    models: [{ id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" }],
    async generateText(request): Promise<AiGenerationResult> {
      const requestParts: Array<Record<string, unknown>> = [];
      if (request.videoUrl) {
        requestParts.push({
          fileData: { fileUri: request.videoUrl, mimeType: "video/*" },
        });
      }
      requestParts.push({ text: request.input });
      const response = await postJson(
        label,
        endpoint(baseUrl, `/models/${encodeURIComponent(request.model)}:generateContent`),
        { "x-goog-api-key": request.apiKey },
        {
          store: false,
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: "user", parts: requestParts }],
          generationConfig: {
            // Gemini counts reasoning against the output budget, too.
            maxOutputTokens: Math.max(request.maxOutputTokens, 8_192),
            thinkingConfig: { thinkingLevel: "low" },
          },
          ...(request.webSearch ? { tools: [{ google_search: {} }] } : {}),
        },
        request.signal,
      );
      const promptFeedback = response.promptFeedback as Record<string, unknown> | undefined;
      if (typeof promptFeedback?.blockReason === "string") {
        throw new AiError("AI_RESPONSE_REFUSED", 422, `${label} could not process this article.`);
      }
      const candidates = Array.isArray(response.candidates) ? response.candidates : [];
      const first = candidates[0] as Record<string, unknown> | undefined;
      const finishReason = first?.finishReason;
      const refused =
        typeof finishReason === "string" &&
        ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY"].includes(finishReason);
      if (refused) {
        throw new AiError("AI_RESPONSE_REFUSED", 422, `${label} could not process this article.`);
      }
      if (finishReason !== "STOP") {
        throw new AiError(
          "AI_PROVIDER_FAILED",
          502,
          `${label} did not finish processing this article. Try again.`,
        );
      }
      const content = first?.content as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const values = parts.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const text = (part as Record<string, unknown>).text;
        return typeof text === "string" ? [text] : [];
      });
      const text = requireText(label, values);
      const usage = response.usageMetadata as Record<string, unknown> | undefined;
      return {
        text,
        usage: usage
          ? {
              inputTokens: tokenCount(usage.promptTokenCount),
              outputTokens: tokenCount(usage.candidatesTokenCount),
            }
          : EMPTY_USAGE,
        grounding: request.webSearch ? geminiGrounding(first?.groundingMetadata, text) : null,
      };
    },
  };
}

function openAiAdapter(baseUrl: string): AiProviderAdapter {
  const label = "OpenAI";
  return {
    id: "openai",
    label,
    defaultModel: "gpt-5.6-luna",
    models: [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
    async generateText(request): Promise<AiGenerationResult> {
      const response = await postJson(
        label,
        endpoint(baseUrl, "/responses"),
        { Authorization: `Bearer ${request.apiKey}` },
        {
          model: request.model,
          instructions: request.system,
          input: request.input,
          max_output_tokens: request.maxOutputTokens,
          reasoning: { effort: request.webSearch ? "low" : "none" },
          text: { verbosity: "low" },
          store: false,
          ...(request.webSearch
            ? {
                tools: [{ type: "web_search", search_context_size: "medium" }],
                tool_choice: "required",
                max_tool_calls: 5,
              }
            : {}),
        },
        request.signal,
      );
      if (response.status !== "completed") {
        const details = response.incomplete_details as Record<string, unknown> | undefined;
        if (details?.reason === "content_filter") {
          throw new AiError("AI_RESPONSE_REFUSED", 422, `${label} could not process this article.`);
        }
        throw new AiError(
          "AI_PROVIDER_FAILED",
          502,
          `${label} did not finish processing this article. Try again.`,
        );
      }
      const output = Array.isArray(response.output) ? response.output : [];
      let refused = false;
      const values: string[] = [];
      let textLength = 0;
      const sources: AiGrounding["sources"] = [];
      const sourceIndices = new Map<string, number>();
      const supports: AiGrounding["supports"] = [];
      for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const content = (item as Record<string, unknown>).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const block = part as Record<string, unknown>;
          if (block.type === "refusal") refused = true;
          if (block.type === "output_text" && typeof block.text === "string") {
            values.push(block.text);
            const annotations = Array.isArray(block.annotations) ? block.annotations : [];
            for (const annotationValue of annotations) {
              const annotation = record(annotationValue);
              if (annotation?.type !== "url_citation") continue;
              const sourceIndex = addGroundingSource(
                sources,
                sourceIndices,
                annotation.url,
                annotation.title,
              );
              if (
                sourceIndex === null ||
                typeof annotation.start_index !== "number" ||
                typeof annotation.end_index !== "number" ||
                !Number.isInteger(annotation.start_index) ||
                !Number.isInteger(annotation.end_index) ||
                annotation.start_index < 0 ||
                annotation.end_index <= annotation.start_index ||
                annotation.end_index > block.text.length
              ) {
                continue;
              }
              supports.push({
                startIndex: textLength + annotation.start_index,
                endIndex: textLength + annotation.end_index,
                sourceIndices: [sourceIndex],
              });
            }
            textLength += block.text.length;
          }
        }
      }
      const usage = response.usage as Record<string, unknown> | undefined;
      return {
        text: requireText(label, values, refused),
        usage: usage
          ? {
              inputTokens: tokenCount(usage.input_tokens),
              outputTokens: tokenCount(usage.output_tokens),
            }
          : EMPTY_USAGE,
        grounding: request.webSearch ? citationGrounding(sources, supports) : null,
      };
    },
  };
}

function anthropicAdapter(baseUrl: string): AiProviderAdapter {
  const label = "Anthropic";
  return {
    id: "anthropic",
    label,
    defaultModel: "claude-haiku-4-5",
    models: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
    async generateText(request): Promise<AiGenerationResult> {
      const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
        { role: "user", content: request.input },
      ];
      const responses: Array<Record<string, unknown>> = [];
      let response: Record<string, unknown>;
      do {
        response = await postJson(
          label,
          endpoint(baseUrl, "/messages"),
          {
            "x-api-key": request.apiKey,
            "anthropic-version": "2023-06-01",
          },
          {
            model: request.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages,
            ...(request.webSearch
              ? {
                  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
                }
              : {}),
          },
          request.signal,
        );
        responses.push(response);
        if (response.stop_reason === "pause_turn") {
          const pausedContent = Array.isArray(response.content) ? response.content : [];
          messages.push({ role: "assistant", content: pausedContent });
        }
      } while (response.stop_reason === "pause_turn");
      if (response.stop_reason === "refusal") {
        throw new AiError("AI_RESPONSE_REFUSED", 422, `${label} could not process this article.`);
      }
      if (response.stop_reason !== "end_turn") {
        throw new AiError(
          "AI_PROVIDER_FAILED",
          502,
          `${label} did not finish processing this article. Try again.`,
        );
      }
      const content = Array.isArray(response.content) ? response.content : [];
      const values: string[] = [];
      let textLength = 0;
      const sources: AiGrounding["sources"] = [];
      const sourceIndices = new Map<string, number>();
      const supports: AiGrounding["supports"] = [];
      for (const part of content) {
        const block = record(part);
        if (block?.type !== "text" || typeof block.text !== "string") continue;
        values.push(block.text);
        const citedSources = new Set<number>();
        const citations = Array.isArray(block.citations) ? block.citations : [];
        for (const citationValue of citations) {
          const citation = record(citationValue);
          if (citation?.type !== "web_search_result_location") continue;
          const sourceIndex = addGroundingSource(
            sources,
            sourceIndices,
            citation.url,
            citation.title,
          );
          if (sourceIndex !== null) citedSources.add(sourceIndex);
        }
        if (block.text.length > 0 && citedSources.size > 0) {
          supports.push({
            startIndex: textLength,
            endIndex: textLength + block.text.length,
            sourceIndices: [...citedSources],
          });
        }
        textLength += block.text.length;
      }
      const usageValues = responses.map((item) => record(item.usage));
      const totalTokens = (key: string): number | null => {
        const values = usageValues.map((usage) => tokenCount(usage?.[key]));
        return values.every((value) => value === null)
          ? null
          : values.reduce<number>((total, value) => total + (value ?? 0), 0);
      };
      return {
        text: requireText(label, values),
        usage: {
          inputTokens: totalTokens("input_tokens"),
          outputTokens: totalTokens("output_tokens"),
        },
        grounding: request.webSearch ? citationGrounding(sources, supports) : null,
      };
    },
  };
}

export function createAiProviders(
  endpoints: AiProviderEndpoints = {},
): ReadonlyMap<AiProvider, AiProviderAdapter> {
  const providers: AiProviderAdapter[] = [
    geminiAdapter(endpoints.gemini ?? "https://generativelanguage.googleapis.com/v1beta"),
    openAiAdapter(endpoints.openai ?? "https://api.openai.com/v1"),
    anthropicAdapter(endpoints.anthropic ?? "https://api.anthropic.com/v1"),
  ];
  return new Map(providers.map((provider) => [provider.id, provider]));
}
