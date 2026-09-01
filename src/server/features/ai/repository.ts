import type Sqlite from "better-sqlite3";
import type {
  AiArticleSourceKind,
  AiFeature,
  AiFeatureSetting,
  AiProvider,
  AiUsage,
} from "../../../shared/types.js";
import {
  type AiArticleRecord,
  mapStoredArticleAiSummary,
  mapStoredArticleAiTranslation,
  now,
  parseArticleMedia,
  type Row,
  type StoredArticleAiSummary,
  type StoredArticleAiTranslation,
} from "../shared.js";

export class AiRepository {
  constructor(private readonly sqlite: Sqlite.Database) {}

  getAiFeatureSetting(userId: number, feature: AiFeature): AiFeatureSetting | null {
    const row = this.sqlite
      .prepare(
        `SELECT provider, model
         FROM ai_feature_settings
         WHERE user_id = ? AND feature = ?`,
      )
      .get(userId, feature) as Row | undefined;
    if (!row) return null;
    return { provider: row.provider as AiProvider, model: String(row.model) };
  }

  setAiFeatureSetting(
    userId: number,
    feature: AiFeature,
    setting: AiFeatureSetting,
  ): AiFeatureSetting {
    this.sqlite
      .prepare(
        `INSERT INTO ai_feature_settings (user_id, feature, provider, model, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, feature) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(userId, feature, setting.provider, setting.model, now());
    return this.getAiFeatureSetting(userId, feature) as AiFeatureSetting;
  }

  listConfiguredAiProviders(userId: number): AiProvider[] {
    return (
      this.sqlite
        .prepare("SELECT provider FROM ai_credentials WHERE user_id = ? ORDER BY provider")
        .all(userId) as Array<{ provider: AiProvider }>
    ).map((row) => row.provider);
  }

  getEncryptedAiCredential(userId: number, provider: AiProvider): string | null {
    const row = this.sqlite
      .prepare(
        `SELECT encrypted_api_key AS encryptedApiKey
         FROM ai_credentials WHERE user_id = ? AND provider = ?`,
      )
      .get(userId, provider) as { encryptedApiKey: string } | undefined;
    return row?.encryptedApiKey ?? null;
  }

  setEncryptedAiCredential(userId: number, provider: AiProvider, encryptedApiKey: string): void {
    const timestamp = now();
    this.sqlite
      .prepare(
        `INSERT INTO ai_credentials (
           user_id, provider, encrypted_api_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           encrypted_api_key = excluded.encrypted_api_key,
           updated_at = excluded.updated_at`,
      )
      .run(userId, provider, encryptedApiKey, timestamp, timestamp);
  }

  deleteAiCredential(userId: number, provider: AiProvider): boolean {
    return (
      this.sqlite
        .prepare("DELETE FROM ai_credentials WHERE user_id = ? AND provider = ?")
        .run(userId, provider).changes > 0
    );
  }

  deleteDefaultArticleSummaries(userId: number): void {
    this.sqlite
      .prepare(
        `DELETE FROM article_ai_summaries
         WHERE prompt_id IS NULL AND user_id = ?`,
      )
      .run(userId);
  }

  deleteCustomPromptArticleSummaries(userId: number, promptIds: Iterable<string>): void {
    const deleteSummaries = this.sqlite.prepare(
      `DELETE FROM article_ai_summaries
       WHERE prompt_id = ? AND user_id = ?`,
    );
    for (const promptId of promptIds) deleteSummaries.run(promptId, userId);
  }

  deleteArticleTranslations(userId: number): void {
    this.sqlite
      .prepare(
        `DELETE FROM article_ai_translations
         WHERE user_id = ?`,
      )
      .run(userId);
  }

  getArticleForAi(userId: number, id: number): AiArticleRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT articles.id,
                articles.content_revision AS revision,
                articles.title,
                articles.url,
                articles.author,
                articles.media_json AS mediaJson,
                articles.content_html AS contentHtml,
                articles.feed_content_html AS feedContentHtml,
                articles.summary AS excerpt,
                article_ai_summaries.source_revision AS aiSummarySourceRevision,
                article_ai_summaries.prompt_version AS aiSummaryPromptVersion,
                article_ai_summaries.prompt_id AS aiSummaryPromptId,
                article_ai_summaries.source_kind AS aiSummarySourceKind,
                article_ai_summaries.provider AS aiSummaryProvider,
                article_ai_summaries.model AS aiSummaryModel,
                article_ai_summaries.summary_text AS aiSummaryText,
                article_ai_summaries.input_tokens AS aiSummaryInputTokens,
                article_ai_summaries.output_tokens AS aiSummaryOutputTokens,
                article_ai_summaries.generated_at AS aiSummaryGeneratedAt
         FROM articles
         LEFT JOIN article_ai_summaries
           ON article_ai_summaries.article_id = articles.id
          AND article_ai_summaries.user_id = ?
          AND article_ai_summaries.source_revision = articles.content_revision
         WHERE articles.id = ?
           AND EXISTS (
             SELECT 1 FROM feed_articles
             JOIN feeds ON feeds.id = feed_articles.feed_id
             WHERE feed_articles.article_id = articles.id AND feeds.user_id = ?
           )`,
      )
      .get(userId, id, userId) as Row | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      revision: Number(row.revision),
      title: String(row.title),
      url: row.url === null ? null : String(row.url),
      author: row.author === null ? null : String(row.author),
      media: parseArticleMedia(row.mediaJson),
      contentHtml: row.contentHtml === null ? null : String(row.contentHtml),
      feedContentHtml: row.feedContentHtml === null ? null : String(row.feedContentHtml),
      excerpt: String(row.excerpt),
      currentSummary: mapStoredArticleAiSummary(row),
    };
  }

  getArticleAiSummary(userId: number, id: number): StoredArticleAiSummary | null {
    const row = this.sqlite
      .prepare(
        `SELECT article_ai_summaries.source_revision AS aiSummarySourceRevision,
                article_ai_summaries.prompt_version AS aiSummaryPromptVersion,
                article_ai_summaries.prompt_id AS aiSummaryPromptId,
                article_ai_summaries.source_kind AS aiSummarySourceKind,
                article_ai_summaries.provider AS aiSummaryProvider,
                article_ai_summaries.model AS aiSummaryModel,
                article_ai_summaries.summary_text AS aiSummaryText,
                article_ai_summaries.input_tokens AS aiSummaryInputTokens,
                article_ai_summaries.output_tokens AS aiSummaryOutputTokens,
                article_ai_summaries.generated_at AS aiSummaryGeneratedAt
         FROM article_ai_summaries
         JOIN articles ON articles.id = article_ai_summaries.article_id
         WHERE article_ai_summaries.article_id = ?
           AND article_ai_summaries.user_id = ?
           AND article_ai_summaries.source_revision = articles.content_revision
           AND EXISTS (
             SELECT 1 FROM feed_articles
             JOIN feeds ON feeds.id = feed_articles.feed_id
             WHERE feed_articles.article_id = articles.id AND feeds.user_id = ?
           )`,
      )
      .get(id, userId, userId) as Row | undefined;
    return row ? mapStoredArticleAiSummary(row) : null;
  }

  saveArticleAiSummary(
    userId: number,
    id: number,
    sourceRevision: number,
    input: {
      promptVersion: number;
      promptId: string | null;
      sourceKind: AiArticleSourceKind;
      provider: AiProvider;
      model: string;
      text: string;
      usage: AiUsage;
    },
  ): StoredArticleAiSummary | null {
    const save = this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare(
          `SELECT articles.content_revision AS revision
           FROM articles
           WHERE articles.id = ? AND EXISTS (
             SELECT 1 FROM feed_articles
             JOIN feeds ON feeds.id = feed_articles.feed_id
             WHERE feed_articles.article_id = articles.id AND feeds.user_id = ?
           )`,
        )
        .get(id, userId) as { revision: number } | undefined;
      if (!current || current.revision !== sourceRevision) return null;
      this.sqlite
        .prepare(
          `INSERT INTO article_ai_summaries (
             user_id, article_id, source_revision, prompt_version, prompt_id, source_kind, provider, model,
             summary_text, input_tokens, output_tokens, generated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, article_id) DO UPDATE SET
             source_revision = excluded.source_revision,
             prompt_version = excluded.prompt_version,
             prompt_id = excluded.prompt_id,
             source_kind = excluded.source_kind,
             provider = excluded.provider,
             model = excluded.model,
             summary_text = excluded.summary_text,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             generated_at = excluded.generated_at`,
        )
        .run(
          userId,
          id,
          sourceRevision,
          input.promptVersion,
          input.promptId,
          input.sourceKind,
          input.provider,
          input.model,
          input.text,
          input.usage.inputTokens,
          input.usage.outputTokens,
          now(),
        );
      return this.getArticleAiSummary(userId, id);
    });
    return save();
  }

  getArticleAiTranslation(
    userId: number,
    id: number,
    language: string,
    sourceKind: AiArticleSourceKind,
  ): StoredArticleAiTranslation | null {
    const row = this.sqlite
      .prepare(
        `SELECT article_ai_translations.source_revision AS aiTranslationSourceRevision,
                article_ai_translations.prompt_version AS aiTranslationPromptVersion,
                article_ai_translations.target_language AS aiTranslationLanguage,
                article_ai_translations.source_kind AS aiTranslationSourceKind,
                article_ai_translations.provider AS aiTranslationProvider,
                article_ai_translations.model AS aiTranslationModel,
                article_ai_translations.translation_html AS aiTranslationHtml,
                article_ai_translations.input_tokens AS aiTranslationInputTokens,
                article_ai_translations.output_tokens AS aiTranslationOutputTokens,
                article_ai_translations.generated_at AS aiTranslationGeneratedAt
         FROM article_ai_translations
         JOIN articles ON articles.id = article_ai_translations.article_id
         WHERE article_ai_translations.article_id = ?
           AND article_ai_translations.user_id = ?
           AND article_ai_translations.target_language = ? COLLATE NOCASE
           AND article_ai_translations.source_kind = ?
           AND article_ai_translations.source_revision = articles.content_revision
           AND EXISTS (
             SELECT 1 FROM feed_articles
             JOIN feeds ON feeds.id = feed_articles.feed_id
             WHERE feed_articles.article_id = articles.id AND feeds.user_id = ?
           )`,
      )
      .get(id, userId, language, sourceKind, userId) as Row | undefined;
    return row ? mapStoredArticleAiTranslation(row) : null;
  }

  saveArticleAiTranslation(
    userId: number,
    id: number,
    sourceRevision: number,
    input: {
      promptVersion: number;
      language: string;
      sourceKind: AiArticleSourceKind;
      provider: AiProvider;
      model: string;
      html: string;
      usage: AiUsage;
    },
  ): StoredArticleAiTranslation | null {
    const save = this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare(
          `SELECT articles.content_revision AS revision
           FROM articles
           WHERE articles.id = ? AND EXISTS (
             SELECT 1 FROM feed_articles
             JOIN feeds ON feeds.id = feed_articles.feed_id
             WHERE feed_articles.article_id = articles.id AND feeds.user_id = ?
           )`,
        )
        .get(id, userId) as { revision: number } | undefined;
      if (!current || current.revision !== sourceRevision) return null;
      this.sqlite
        .prepare(
          `INSERT INTO article_ai_translations (
             user_id, article_id, target_language, source_kind, source_revision, prompt_version,
             provider, model, translation_html, input_tokens, output_tokens, generated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, article_id, target_language, source_kind) DO UPDATE SET
             source_revision = excluded.source_revision,
             prompt_version = excluded.prompt_version,
             provider = excluded.provider,
             model = excluded.model,
             translation_html = excluded.translation_html,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             generated_at = excluded.generated_at`,
        )
        .run(
          userId,
          id,
          input.language,
          input.sourceKind,
          sourceRevision,
          input.promptVersion,
          input.provider,
          input.model,
          input.html,
          input.usage.inputTokens,
          input.usage.outputTokens,
          now(),
        );
      return this.getArticleAiTranslation(userId, id, input.language, input.sourceKind);
    });
    return save();
  }
}
