import { createHash } from "node:crypto";
import {
  DEFAULT_ARTICLE_SUMMARY_PROMPT,
  DEFAULT_ARTICLE_TRANSLATION_PROMPT,
} from "../../../shared/ai-prompts.js";
import type {
  AiArticleSourceKind,
  AiFeature,
  AiFeatureSetting,
  AiProvider,
  AiSettings,
  ArticleAiSummary,
  ArticleAiTranslation,
} from "../../../shared/types.js";
import {
  ARTICLE_GROUNDED_MAX_OUTPUT_TOKENS,
  ARTICLE_SUMMARY_MAX_OUTPUT_TOKENS,
  ARTICLE_SUMMARY_PROMPT_VERSION,
  articleSummaryNeedsWebSearch,
  articleSummarySystemPrompt,
  prepareArticleSummary,
  prepareYouTubeVideoSummary,
} from "../../ai/article-summary.js";
import {
  ARTICLE_TRANSLATION_MAX_OUTPUT_TOKENS,
  ARTICLE_TRANSLATION_PROMPT_VERSION,
  prepareArticleTranslation,
  renderArticleTranslation,
} from "../../ai/article-translation.js";
import type { CredentialCipherLike } from "../../ai/credential-cipher.js";
import { AiError } from "../../ai/errors.js";
import { createAiProviders } from "../../ai/providers.js";
import type { AiGenerationResult, AiProviderAdapter } from "../../ai/types.js";
import type { AppDatabase } from "../../database.js";
import type { StoredArticleAiSummary, StoredArticleAiTranslation } from "../shared.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const VIDEO_REQUEST_TIMEOUT_MS = 240_000;

function promptVersion(prompt: string, defaultPrompt: string, defaultVersion: number): number {
  if (prompt === defaultPrompt) return defaultVersion;
  const digest = createHash("sha256").update(`${defaultVersion}\0${prompt}`).digest();
  return -digest.readUIntBE(0, 6) - 1;
}

function youtubeSummaryVersion(prompt: string): number {
  const digest = createHash("sha256").update(`youtube-video-summary-v1\0${prompt}`).digest();
  return -digest.readUIntBE(0, 6) - 1;
}

export interface AiServiceOptions {
  credentialCipher: CredentialCipherLike | null;
  currentDate?: () => Date;
  providers?: ReadonlyMap<AiProvider, AiProviderAdapter>;
  requestTimeoutMs?: number;
}

interface FeatureGenerationRequest {
  system: string;
  input: string;
  videoUrl?: string;
  maxOutputTokens: number;
  webSearch: boolean;
}

interface FeatureGenerationResult extends AiGenerationResult {
  provider: AiProvider;
  model: string;
}

function publicSummary(summary: StoredArticleAiSummary): ArticleAiSummary {
  return {
    text: summary.text,
    promptId: summary.promptId,
    provider: summary.provider,
    model: summary.model,
    sourceKind: summary.sourceKind,
    generatedAt: summary.generatedAt,
    usage: summary.usage,
    grounding: summary.grounding,
  };
}

function publicTranslation(translation: StoredArticleAiTranslation): ArticleAiTranslation {
  return {
    html: translation.html,
    language: translation.language,
    provider: translation.provider,
    model: translation.model,
    sourceKind: translation.sourceKind,
    generatedAt: translation.generatedAt,
    usage: translation.usage,
  };
}

export class AiService {
  private readonly providers: ReadonlyMap<AiProvider, AiProviderAdapter>;
  private readonly currentDate: () => Date;
  private readonly summariesInFlight = new Map<string, Promise<ArticleAiSummary | null>>();
  private readonly translationsInFlight = new Map<string, Promise<ArticleAiTranslation | null>>();

  constructor(
    private readonly database: AppDatabase,
    private readonly options: AiServiceOptions,
  ) {
    this.providers = options.providers ?? createAiProviders();
    this.currentDate = options.currentDate ?? (() => new Date());
  }

  getSettings(userId: number): AiSettings {
    const configured = new Set(this.database.ai.listConfiguredAiProviders(userId));
    const articleSummary = this.validFeatureSetting(
      this.database.ai.getAiFeatureSetting(userId, "article_summary"),
    );
    return {
      credentialStorageAvailable: this.options.credentialCipher !== null,
      providers: [...this.providers.values()].map((provider) => ({
        id: provider.id,
        label: provider.label,
        configured: configured.has(provider.id),
        defaultModel: provider.defaultModel,
        models: provider.models.map((model) => ({ ...model })),
      })),
      features: { articleSummary },
    };
  }

  setFeatureSetting(
    userId: number,
    feature: AiFeature,
    providerId: AiProvider,
    model?: string,
  ): AiSettings {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AiError("AI_NOT_CONFIGURED", 422, "Choose an AI provider in Settings.");
    }
    const selectedModel = model?.trim() || provider.defaultModel;
    this.database.ai.setAiFeatureSetting(userId, feature, {
      provider: providerId,
      model: selectedModel,
    });
    return this.getSettings(userId);
  }

  setApiKey(userId: number, provider: AiProvider, apiKey: string): AiSettings {
    const cipher = this.options.credentialCipher;
    if (!cipher) {
      throw new AiError(
        "AI_CREDENTIAL_STORAGE_UNAVAILABLE",
        503,
        "API key storage is unavailable. Set AI_CREDENTIALS_KEY on the server, then restart feedfold.",
      );
    }
    const encrypted = cipher.encrypt(userId, provider, apiKey.trim());
    this.database.ai.setEncryptedAiCredential(userId, provider, encrypted);
    return this.getSettings(userId);
  }

  deleteApiKey(userId: number, provider: AiProvider): AiSettings {
    this.database.ai.deleteAiCredential(userId, provider);
    return this.getSettings(userId);
  }

  async generateText(
    userId: number,
    feature: AiFeature,
    request: FeatureGenerationRequest,
  ): Promise<FeatureGenerationResult> {
    const setting = this.validFeatureSetting(this.database.ai.getAiFeatureSetting(userId, feature));
    if (!setting) {
      throw new AiError(
        "AI_NOT_CONFIGURED",
        422,
        "Choose an AI provider and model in Settings, then try again.",
      );
    }
    return this.generateWithProvider(userId, setting.provider, setting.model, request);
  }

  private async generateWithProvider(
    userId: number,
    providerId: AiProvider,
    model: string,
    request: FeatureGenerationRequest,
    missingKeyMessage?: string,
  ): Promise<FeatureGenerationResult> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new AiError("AI_NOT_CONFIGURED", 422, "Choose an AI provider in Settings.");
    }
    const encryptedKey = this.database.ai.getEncryptedAiCredential(userId, providerId);
    if (!encryptedKey) {
      throw new AiError(
        "AI_KEY_MISSING",
        422,
        missingKeyMessage ?? `Add an API key for ${provider.label} in Settings, then try again.`,
      );
    }
    const cipher = this.options.credentialCipher;
    if (!cipher) {
      throw new AiError(
        "AI_CREDENTIAL_STORAGE_UNAVAILABLE",
        503,
        "The server cannot decrypt saved API keys. Set AI_CREDENTIALS_KEY, then restart feedfold.",
      );
    }
    const result = await this.database.quotas.runOutbound(() =>
      provider.generateText({
        apiKey: cipher.decrypt(userId, providerId, encryptedKey),
        model,
        ...request,
        signal: AbortSignal.timeout(
          this.options.requestTimeoutMs ??
            (request.videoUrl ? VIDEO_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS),
        ),
      }),
    );
    return { ...result, provider: providerId, model };
  }

  private generateYouTubeSummary(
    userId: number,
    setting: AiFeatureSetting | null,
    request: FeatureGenerationRequest,
  ): Promise<FeatureGenerationResult> {
    const gemini = this.providers.get("gemini");
    if (!gemini) {
      throw new AiError("AI_NOT_CONFIGURED", 422, "Google Gemini is unavailable.");
    }
    const model = setting?.provider === "gemini" ? setting.model : gemini.defaultModel;
    return this.generateWithProvider(
      userId,
      "gemini",
      model,
      request,
      "Add a Google Gemini API key in Settings to summarize YouTube videos.",
    );
  }

  async summarizeArticle(
    userId: number,
    articleId: number,
    customPromptId: string | null,
    regenerate = false,
  ): Promise<ArticleAiSummary | null> {
    const { summaryPrompt, customPrompts } = this.database.settings.getSettings(userId);
    const customPrompt = customPromptId
      ? customPrompts.find((prompt) => prompt.id === customPromptId)
      : null;
    if (customPromptId && !customPrompt) {
      throw new AiError(
        "CUSTOM_PROMPT_NOT_FOUND",
        404,
        "This custom prompt no longer exists. Choose another AI action.",
      );
    }
    const prompt = customPrompt?.prompt ?? summaryPrompt;
    const version = promptVersion(
      prompt,
      DEFAULT_ARTICLE_SUMMARY_PROMPT,
      ARTICLE_SUMMARY_PROMPT_VERSION,
    );
    const key = `${userId}:${articleId}:${customPromptId ?? "default"}:${version}`;
    const running = this.summariesInFlight.get(key);
    if (running) return running;
    const summary = this.createArticleSummary(
      userId,
      articleId,
      regenerate,
      prompt,
      customPromptId,
      version,
    ).finally(() => {
      this.summariesInFlight.delete(key);
    });
    this.summariesInFlight.set(key, summary);
    return summary;
  }

  translateArticle(
    userId: number,
    articleId: number,
    sourceKind: AiArticleSourceKind,
  ): Promise<ArticleAiTranslation | null> {
    const { translationLanguage: language, translationPrompt } =
      this.database.settings.getSettings(userId);
    const version = promptVersion(
      translationPrompt,
      DEFAULT_ARTICLE_TRANSLATION_PROMPT,
      ARTICLE_TRANSLATION_PROMPT_VERSION,
    );
    const key = `${userId}:${articleId}:${sourceKind}:${language.toLocaleLowerCase()}:${version}`;
    const running = this.translationsInFlight.get(key);
    if (running) return running;
    const translation = this.createArticleTranslation(
      userId,
      articleId,
      sourceKind,
      language,
      translationPrompt,
      version,
    ).finally(() => {
      this.translationsInFlight.delete(key);
    });
    this.translationsInFlight.set(key, translation);
    return translation;
  }

  private async createArticleSummary(
    userId: number,
    articleId: number,
    regenerate: boolean,
    prompt: string,
    promptId: string | null,
    version: number,
  ): Promise<ArticleAiSummary | null> {
    const article = this.database.ai.getArticleForAi(userId, articleId);
    if (!article) return null;
    const setting = this.validFeatureSetting(
      this.database.ai.getAiFeatureSetting(userId, "article_summary"),
    );
    const videoUrl = article.media?.provider === "youtube" ? article.url : null;
    const summaryVersion = videoUrl ? youtubeSummaryVersion(prompt) : version;
    const useWebSearch =
      articleSummaryNeedsWebSearch(prompt) && (videoUrl !== null || setting !== null);
    if (
      !useWebSearch &&
      !regenerate &&
      article.currentSummary?.promptVersion === summaryVersion &&
      article.currentSummary.promptId === promptId
    ) {
      return publicSummary(article.currentSummary);
    }
    const prepared = videoUrl
      ? prepareYouTubeVideoSummary(article)
      : prepareArticleSummary(article);
    const request = {
      system: articleSummarySystemPrompt(
        prompt,
        this.currentDate(),
        useWebSearch,
        videoUrl ? "youtube_video" : "article",
      ),
      input: prepared.input,
      ...(videoUrl ? { videoUrl } : {}),
      maxOutputTokens: useWebSearch
        ? ARTICLE_GROUNDED_MAX_OUTPUT_TOKENS
        : ARTICLE_SUMMARY_MAX_OUTPUT_TOKENS,
      webSearch: useWebSearch,
    };
    const generated = videoUrl
      ? await this.generateYouTubeSummary(userId, setting, request)
      : await this.generateText(userId, "article_summary", request);
    if (useWebSearch) {
      return {
        text: generated.text,
        promptId,
        provider: generated.provider,
        model: generated.model,
        sourceKind: prepared.sourceKind,
        generatedAt: this.currentDate().toISOString(),
        usage: generated.usage,
        grounding: generated.grounding,
      };
    }
    const saved = this.database.ai.saveArticleAiSummary(userId, articleId, article.revision, {
      promptVersion: summaryVersion,
      promptId,
      sourceKind: prepared.sourceKind,
      provider: generated.provider,
      model: generated.model,
      text: generated.text,
      usage: generated.usage,
    });
    if (!saved) {
      throw new AiError(
        "ARTICLE_CHANGED",
        409,
        "The article changed while it was being summarized. Try again.",
      );
    }
    return publicSummary(saved);
  }

  private async createArticleTranslation(
    userId: number,
    articleId: number,
    sourceKind: AiArticleSourceKind,
    language: string,
    prompt: string,
    version: number,
  ): Promise<ArticleAiTranslation | null> {
    const article = this.database.ai.getArticleForAi(userId, articleId);
    if (!article) return null;
    const current = this.database.ai.getArticleAiTranslation(
      userId,
      articleId,
      language,
      sourceKind,
    );
    if (current?.promptVersion === version) {
      return publicTranslation(current);
    }
    const prepared = prepareArticleTranslation(article, language, sourceKind);
    const generated = await this.generateText(userId, "article_summary", {
      system: prompt,
      input: prepared.input,
      maxOutputTokens: ARTICLE_TRANSLATION_MAX_OUTPUT_TOKENS,
      webSearch: false,
    });
    const html = renderArticleTranslation(prepared, generated.text);
    const saved = this.database.ai.saveArticleAiTranslation(userId, articleId, article.revision, {
      promptVersion: version,
      language,
      sourceKind: prepared.sourceKind,
      provider: generated.provider,
      model: generated.model,
      html,
      usage: generated.usage,
    });
    if (!saved) {
      throw new AiError(
        "ARTICLE_CHANGED",
        409,
        "The article changed while it was being translated. Try again.",
      );
    }
    return publicTranslation(saved);
  }

  private validFeatureSetting(setting: AiFeatureSetting | null): AiFeatureSetting | null {
    if (!setting) return null;
    if (!this.providers.has(setting.provider) || !setting.model.trim()) return null;
    return setting;
  }
}
