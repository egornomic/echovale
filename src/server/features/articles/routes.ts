import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { telegramPostIdentity } from "../../../shared/telegram.js";
import type {
  AiArticleSourceKind,
  ArticleQuery,
  MarkReadAgeDays,
  MarkReadRequest,
} from "../../../shared/types.js";
import { MARK_READ_AGE_DAYS } from "../../../shared/types.js";
import { nitterVideoPostId } from "../../../shared/x.js";
import type { ExtractionQueue } from "../../extraction.js";
import { QuotaExceededError, type QuotaService } from "../../quota.js";
import type { TelegramMediaService } from "../../telegram-media.js";
import type { XMediaService } from "../../x-media.js";
import type { AiService } from "../ai/service.js";
import type { ExtractionService } from "../extraction/service.js";
import { idParams, missing, type UserId } from "../routes.js";
import type { ArticleRepository } from "./repository.js";

const markReadAgeDays = z
  .number()
  .int()
  .refine(
    (value) => MARK_READ_AGE_DAYS.includes(value as MarkReadAgeDays),
    "Choose one of the available age thresholds.",
  );

export async function articleRoutes(
  app: FastifyInstance,
  {
    articles,
    extractions,
    extractionQueue,
    ai,
    telegramMedia,
    xMedia,
    quotas,
    userId,
  }: {
    articles: ArticleRepository;
    extractions: ExtractionService;
    extractionQueue: ExtractionQueue;
    ai: AiService;
    telegramMedia: TelegramMediaService;
    xMedia: XMediaService;
    quotas: QuotaService;
    userId: UserId;
  },
): Promise<void> {
  const resolveTelegramMedia = async (
    accountId: number,
    articleId: number,
    reply: FastifyReply,
  ) => {
    const article = articles.getArticle(accountId, articleId);
    if (!article?.url || !telegramPostIdentity(article.url)) {
      missing(reply, "Telegram media");
      return null;
    }
    quotas.consume("media_proxy", accountId);
    try {
      return await telegramMedia.mediaForPost(article.url);
    } catch (error) {
      if (error instanceof QuotaExceededError) throw error;
      reply.code(502).send({ error: "Telegram media is temporarily unavailable. Try again." });
      return null;
    }
  };

  const resolveXMedia = async (accountId: number, articleId: number, reply: FastifyReply) => {
    const article = articles.getArticle(accountId, articleId);
    const postId = article ? nitterVideoPostId(article.url, article.feedContentHtml) : null;
    if (!postId) {
      missing(reply, "X video");
      return null;
    }
    quotas.consume("media_proxy", accountId);
    try {
      return await xMedia.mediaForPost(postId);
    } catch (error) {
      if (error instanceof QuotaExceededError) throw error;
      reply.code(502).send({ error: "X video is temporarily unavailable. Try again." });
      return null;
    }
  };

  app.get("/api/articles", async (request) => {
    const query = z
      .object({
        state: z.enum(["all", "unread", "read", "starred"]).default("unread"),
        feedId: z.coerce.number().int().positive().optional(),
        folderId: z.coerce.number().int().positive().optional(),
        search: z.string().trim().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        cursor: z.string().min(1).max(50_000).optional(),
        anchorId: z.coerce.number().int().positive().optional(),
        includeContent: z
          .enum(["true", "false"])
          .transform((value) => value === "true")
          .optional(),
      })
      .parse(request.query) as ArticleQuery;
    return articles.listArticlePage(userId(request), query);
  });

  app.get("/api/articles/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const article = articles.getArticle(userId(request), id);
    return article ?? missing(reply, "Article");
  });

  app.get("/api/articles/:id/telegram-media", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const items = await resolveTelegramMedia(userId(request), id, reply);
    if (!items) return reply;
    return {
      items: items.map((item, index) => ({
        kind: item.kind,
        sourceUrl: `/api/articles/${id}/telegram-media/${index}/source`,
        posterUrl:
          item.kind === "video" && item.posterUrl
            ? `/api/articles/${id}/telegram-media/${index}/poster`
            : null,
        aspectRatio: item.aspectRatio,
      })),
    };
  });

  app.get("/api/articles/:id/telegram-media-preview", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const items = await resolveTelegramMedia(userId(request), id, reply);
    if (!items) return reply;
    const first = items[0];
    if (!first) return missing(reply, "Telegram media");
    return reply.redirect(first.posterUrl ?? first.url);
  });

  const mediaItemParams = z.object({
    id: z.coerce.number().int().positive(),
    index: z.coerce.number().int().min(0).max(99),
  });

  app.get("/api/articles/:id/telegram-media/:index/source", async (request, reply) => {
    const { id, index } = mediaItemParams.parse(request.params);
    const items = await resolveTelegramMedia(userId(request), id, reply);
    if (!items) return reply;
    const item = items[index];
    return item ? reply.redirect(item.url) : missing(reply, "Telegram media");
  });

  app.get("/api/articles/:id/telegram-media/:index/poster", async (request, reply) => {
    const { id, index } = mediaItemParams.parse(request.params);
    const items = await resolveTelegramMedia(userId(request), id, reply);
    if (!items) return reply;
    const posterUrl = items[index]?.posterUrl;
    return posterUrl ? reply.redirect(posterUrl) : missing(reply, "Telegram media poster");
  });

  app.get("/api/articles/:id/x-media", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const media = await resolveXMedia(userId(request), id, reply);
    if (!media) return reply;
    return {
      sourceUrl: `/api/articles/${id}/x-media/source`,
      posterUrl: media.posterUrl ? `/api/articles/${id}/x-media/poster` : null,
      aspectRatio: media.aspectRatio,
    };
  });

  app.get("/api/articles/:id/x-media/source", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const media = await resolveXMedia(userId(request), id, reply);
    if (!media) return reply;
    try {
      const { response, cancel } = await xMedia.videoResponse(media, request.headers.range);
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = response.headers.get(name);
        if (value) reply.header(name, value);
      }
      reply.code(response.status);
      if (!response.body) {
        cancel();
        return reply.send();
      }
      const stream = Readable.fromWeb(
        response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
      );
      stream.once("close", cancel);
      return reply.send(stream);
    } catch (error) {
      if (error instanceof QuotaExceededError) throw error;
      return reply.code(502).send({ error: "X video is temporarily unavailable. Try again." });
    }
  });

  app.get("/api/articles/:id/x-media/poster", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const media = await resolveXMedia(userId(request), id, reply);
    return media?.posterUrl ? reply.redirect(media.posterUrl) : missing(reply, "X video poster");
  });

  app.patch("/api/articles/:id/state", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({ isRead: z.boolean().optional(), isStarred: z.boolean().optional() })
      .refine((value) => value.isRead !== undefined || value.isStarred !== undefined, {
        message: "Choose whether to update read state or saved state.",
      })
      .parse(request.body);
    const article = articles.updateArticleState(userId(request), id, body);
    return article ?? missing(reply, "Article");
  });

  app.post("/api/articles/mark-read", async (request) => {
    const body = z
      .object({
        articleIds: z.array(z.number().int().positive()).max(1_000).optional(),
        feedId: z.number().int().positive().optional(),
        folderId: z.number().int().positive().optional(),
        olderThanDays: markReadAgeDays.optional(),
      })
      .parse(request.body ?? {}) as MarkReadRequest;
    return { updated: articles.markArticlesRead(userId(request), body) };
  });

  app.post("/api/articles/:id/extract", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const accountId = userId(request);
    if (!articles.getArticle(accountId, id)) return missing(reply, "Article");
    if (extractions.requestExtraction(accountId, id)) {
      extractionQueue.prioritize(id);
    }
    return articles.getArticle(accountId, id);
  });

  app.post("/api/articles/:id/summary", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { promptId, regenerate } = z
      .object({ promptId: z.uuid().nullable(), regenerate: z.boolean() })
      .parse(request.body ?? {});
    const summary = await ai.summarizeArticle(userId(request), id, promptId, regenerate);
    return summary ?? missing(reply, "Article");
  });

  app.post("/api/articles/:id/translation", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { sourceKind } = z
      .object({ sourceKind: z.enum(["full", "feed", "excerpt"]) })
      .parse(request.body) as { sourceKind: AiArticleSourceKind };
    const translation = await ai.translateArticle(userId(request), id, sourceKind);
    return translation ?? missing(reply, "Article");
  });
}
