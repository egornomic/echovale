import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import { TelegramMediaService } from "../../src/server/telegram-media.js";
import type { TelegramArticleMedia } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const EMBED_HTML = `<!doctype html><html><body>
  <div class="tgme_widget_message" data-post="Example_Channel/42">
    <a class="tgme_widget_message_photo_wrap"
      style="background-image:url('https://cdn.example.test/photo-current.jpg')"></a>
    <a class="tgme_widget_message_video_player" data-ratio="0.5625">
      <i class="tgme_widget_message_video_thumb"
        style="background-image:url('https://cdn.example.test/poster-current.jpg')"></i>
      <video src="https://cdn.example.test/video-current.mp4?token=fresh"></video>
    </a>
  </div>
</body></html>`;

describe("Telegram article media", () => {
  it("resolves fresh media for an owned article and exposes stable authenticated URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedfold-telegram-media-test-"));
    const database = new AppDatabase(join(directory, "feedfold.db"));
    const authService = new AuthService(database.auth, 20, { maxAccounts: 100 });
    const reader = await authService.register("reader", "reader-password");
    const otherReader = await authService.register("other", "reader-password");
    if (!reader || !otherReader) throw new Error("Expected test accounts");

    const feed = database.feeds.createFeed(reader.user.id, {
      feedUrl: "https://t.me/Example_Channel",
      title: "Example Channel",
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: "Example Channel",
        siteUrl: "https://t.me/Example_Channel",
        articles: [
          {
            externalId: "Example_Channel/42",
            title: "",
            url: "https://t.me/Example_Channel/42",
            author: "Example Channel",
            publishedAt: "2026-07-29T12:00:00.000Z",
            summary: "A post with current media.",
            imageUrl: "https://cdn.example.test/photo-expired.jpg",
            feedContentHtml: "<p>A post with current media.</p>",
          },
        ],
      },
    });
    const article = database.articles.listArticles(reader.user.id, { state: "all" })[0];
    if (!article) throw new Error("Expected a stored article");

    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000);
    const telegramMedia = new TelegramMediaService(1_000, async () =>
      Promise.resolve(new Response(EMBED_HTML, { status: 200 })),
    );
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
      telegramMediaService: telegramMedia,
    });
    cleanups.push(
      () => rm(directory, { recursive: true, force: true }),
      () => database.close(),
      () => Promise.all([refresh.stop(), extraction.stop()]).then(() => undefined),
      () => app.close(),
    );
    const readerCookie = `feedfold_session=${reader.token}`;
    const request = (url: string) =>
      app.inject({ method: "GET", url, headers: { cookie: readerCookie } });

    const articleResponse = await request(`/api/articles/${article.id}`);
    expect(articleResponse.json()).toMatchObject({
      imageUrl: `/api/articles/${article.id}/telegram-media-preview`,
    });

    const metadataResponse = await request(`/api/articles/${article.id}/telegram-media`);
    expect(metadataResponse.statusCode).toBe(200);
    expect(metadataResponse.json<TelegramArticleMedia>()).toEqual({
      items: [
        {
          kind: "image",
          sourceUrl: `/api/articles/${article.id}/telegram-media/0/source`,
          posterUrl: null,
          aspectRatio: null,
        },
        {
          kind: "video",
          sourceUrl: `/api/articles/${article.id}/telegram-media/1/source`,
          posterUrl: `/api/articles/${article.id}/telegram-media/1/poster`,
          aspectRatio: 0.5625,
        },
      ],
    });

    const previewResponse = await request(`/api/articles/${article.id}/telegram-media-preview`);
    expect(previewResponse.statusCode).toBe(302);
    expect(previewResponse.headers.location).toBe("https://cdn.example.test/photo-current.jpg");

    const videoResponse = await request(`/api/articles/${article.id}/telegram-media/1/source`);
    expect(videoResponse.statusCode).toBe(302);
    expect(videoResponse.headers.location).toBe(
      "https://cdn.example.test/video-current.mp4?token=fresh",
    );

    const posterResponse = await request(`/api/articles/${article.id}/telegram-media/1/poster`);
    expect(posterResponse.statusCode).toBe(302);
    expect(posterResponse.headers.location).toBe("https://cdn.example.test/poster-current.jpg");

    const hiddenFromOtherAccount = await app.inject({
      method: "GET",
      url: `/api/articles/${article.id}/telegram-media`,
      headers: { cookie: `feedfold_session=${otherReader.token}` },
    });
    expect(hiddenFromOtherAccount.statusCode).toBe(404);
  });
});
