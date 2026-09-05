import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { AppDatabase } from "../../src/server/database.js";
import { ExtractionQueue } from "../../src/server/extraction.js";
import { AuthService } from "../../src/server/features/auth/service.js";
import { FeedRefreshService } from "../../src/server/refresh.js";
import { parseXPostMedia, XMediaService, xSyndicationToken } from "../../src/server/x-media.js";
import type { XArticleMedia } from "../../src/shared/types.js";

const cleanups: Array<() => Promise<void> | void> = [];
const VIDEO_POST_ID = "2086315104472383847";
const OUTER_POST_ID = "2086315619226681697";
const VIDEO_URL = "https://video.twimg.com/amplify_video/fixture/vid/544x960/video.mp4";
const POSTER_URL = "https://pbs.twimg.com/amplify_video_thumb/fixture/poster.jpg";
const PAYLOAD = {
  mediaDetails: [
    {
      type: "video",
      media_url_https: POSTER_URL,
      video_info: {
        aspect_ratio: [17, 30],
        variants: [
          { content_type: "application/x-mpegURL", url: "https://video.twimg.com/stream.m3u8" },
          { content_type: "video/mp4", bitrate: 256_000, url: "https://video.twimg.com/low.mp4" },
          { content_type: "video/mp4", bitrate: 2_176_000, url: VIDEO_URL },
        ],
      },
    },
  ],
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("X article media", () => {
  it("parses the highest-quality trusted MP4 and its dimensions", () => {
    expect(xSyndicationToken(VIDEO_POST_ID)).toBe("522coghmok");
    expect(parseXPostMedia(PAYLOAD)).toEqual({
      url: VIDEO_URL,
      posterUrl: POSTER_URL,
      aspectRatio: 17 / 30,
    });
  });

  it("rejects media URLs returned from untrusted hosts", () => {
    const payload = structuredClone(PAYLOAD);
    payload.mediaDetails[0].video_info.variants = [
      { content_type: "video/mp4", bitrate: 10, url: "https://example.test/video.mp4" },
    ];
    expect(() => parseXPostMedia(payload)).toThrow("playable MP4");
  });

  it("aborts an X video body that stalls past the media timeout", async () => {
    vi.useFakeTimers();
    try {
      const service = new XMediaService(100, async (_url, options) => {
        const signal = options?.signal as AbortSignal;
        let streamController: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new Uint8Array([0]));
          },
        });
        signal.addEventListener("abort", () => streamController.error(signal.reason), {
          once: true,
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "video/mp4" } });
      });

      const { response, cancel } = await service.videoResponse(
        { url: VIDEO_URL, posterUrl: null, aspectRatio: null },
        "bytes=0-",
      );
      const reader = response.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);
      const stalledRead = reader?.read().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(101);
      await expect(stalledRead).resolves.toMatchObject({ name: "AbortError" });
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an active X video body open beyond one media timeout", async () => {
    vi.useFakeTimers();
    try {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const service = new XMediaService(100, async (_url, options) => {
        const signal = options?.signal as AbortSignal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(new Uint8Array([0]));
          },
        });
        signal.addEventListener("abort", () => streamController.error(signal.reason), {
          once: true,
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "video/mp4" } });
      });

      const { response, cancel } = await service.videoResponse({
        url: VIDEO_URL,
        posterUrl: null,
        aspectRatio: null,
      });
      const reader = response.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);
      await vi.advanceTimersByTimeAsync(60);
      streamController.enqueue(new Uint8Array([1]));
      expect((await reader?.read())?.done).toBe(false);
      await vi.advanceTimersByTimeAsync(60);
      streamController.close();
      expect((await reader?.read())?.done).toBe(true);
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a quoted video for an owned article and exposes authenticated URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedfold-x-media-test-"));
    const database = new AppDatabase(join(directory, "feedfold.db"));
    const authService = new AuthService(database.auth, 20, { maxAccounts: 100 });
    const reader = await authService.register("reader", "reader-password");
    const otherReader = await authService.register("other", "reader-password");
    if (!reader || !otherReader) throw new Error("Expected test accounts");

    const feed = database.feeds.createFeed(reader.user.id, {
      feedUrl: "https://x.com/marclou/rss",
      title: "Marc Lou / @marclou",
      paused: true,
    });
    database.feeds.completeRefresh(feed.id, {
      httpStatus: 200,
      etag: null,
      lastModified: null,
      parsed: {
        title: feed.title,
        siteUrl: "https://x.com/marclou",
        articles: [
          {
            externalId: OUTER_POST_ID,
            title: "A post quoting native video",
            url: `https://x.com/marclou/status/${OUTER_POST_ID}#m`,
            author: "Marc Lou",
            publishedAt: "2026-08-09T10:00:00.000Z",
            summary: "A post with video.",
            imageUrl: POSTER_URL,
            feedContentHtml: `<p>Post text.</p><a href="https://x.com/marclou/status/${VIDEO_POST_ID}#m"><br>Video<br><img src="https://pbs.twimg.com/amplify_video_thumb/fixture.jpg"></a>`,
          },
        ],
      },
    });
    const article = database.articles.listArticles(reader.user.id, { state: "all" })[0];
    if (!article) throw new Error("Expected a stored article");

    const extraction = new ExtractionQueue(database.extractions, 1, 1_000);
    const refresh = new FeedRefreshService(database.feeds, 1, 1_000);
    const xMedia = new XMediaService(1_000, async (url, options) => {
      if (url.startsWith("https://cdn.syndication.twimg.com/")) {
        expect(url).toContain(`id=${VIDEO_POST_ID}`);
        return new Response(JSON.stringify(PAYLOAD), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      expect(url).toBe(VIDEO_URL);
      const range = (options?.headers as Record<string, string> | undefined)?.Range;
      if (range === "bytes=300-400") {
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": "bytes */200" },
        });
      }
      expect(range).toBe("bytes=0-1");
      return new Response(new Uint8Array([0, 1]), {
        status: 206,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Length": "2",
          "Content-Range": "bytes 0-1/200",
          "Content-Type": "video/mp4",
        },
      });
    });
    const app = await createApp({
      database,
      authService,
      extractionQueue: extraction,
      refreshService: refresh,
      xMediaService: xMedia,
    });
    cleanups.push(
      () => rm(directory, { recursive: true, force: true }),
      () => database.close(),
      () => Promise.all([refresh.stop(), extraction.stop()]).then(() => undefined),
      () => app.close(),
    );
    const cookie = `feedfold_session=${reader.token}`;
    const request = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

    const metadata = await request(`/api/articles/${article.id}/x-media`);
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json<XArticleMedia>()).toEqual({
      sourceUrl: `/api/articles/${article.id}/x-media/source`,
      posterUrl: `/api/articles/${article.id}/x-media/poster`,
      aspectRatio: 17 / 30,
    });
    const source = await app.inject({
      method: "GET",
      url: `/api/articles/${article.id}/x-media/source`,
      headers: { cookie, range: "bytes=0-1" },
    });
    expect(source.statusCode).toBe(206);
    expect(source.headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-length": "2",
      "content-range": "bytes 0-1/200",
      "content-type": "video/mp4",
    });
    expect(source.rawPayload).toEqual(Buffer.from([0, 1]));
    const unsatisfiable = await app.inject({
      method: "GET",
      url: `/api/articles/${article.id}/x-media/source`,
      headers: { cookie, range: "bytes=300-400" },
    });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe("bytes */200");
    expect((await request(`/api/articles/${article.id}/x-media/poster`)).headers.location).toBe(
      POSTER_URL,
    );

    const hidden = await app.inject({
      method: "GET",
      url: `/api/articles/${article.id}/x-media`,
      headers: { cookie: `feedfold_session=${otherReader.token}` },
    });
    expect(hidden.statusCode).toBe(404);
  });
});
