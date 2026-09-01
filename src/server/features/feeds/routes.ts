import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WebFeedConfig } from "../../../shared/types.js";
import { discoverFeed, FeedDiscoveryError } from "../../feed-discovery.js";
import type { FeedRefreshService } from "../../refresh.js";
import { WebFeedError, type WebFeedService } from "../../web-feed.js";
import { httpUrl, idParams, missing, nullableId, type UserId } from "../routes.js";
import type { FeedService } from "./service.js";

const selector = z.string().trim().min(1).max(2_000);
const webFeedConfig = z
  .object({
    pageUrl: httpUrl,
    selectors: z
      .object({
        item: selector,
        title: selector,
        link: selector,
        date: selector.nullable(),
        author: selector.nullable(),
        summary: selector.nullable(),
        image: selector.nullable(),
      })
      .strict(),
  })
  .strict();

export async function feedRoutes(
  app: FastifyInstance,
  {
    feeds,
    refreshService,
    webFeedService,
    feedDiscoveryTimeoutMs,
    userId,
  }: {
    feeds: FeedService;
    refreshService: FeedRefreshService;
    webFeedService?: WebFeedService;
    feedDiscoveryTimeoutMs?: number;
    userId: UserId;
  },
): Promise<void> {
  app.get("/api/feeds", async (request) => ({
    feeds: feeds.listFeeds(userId(request)),
  }));

  app.get("/api/feeds/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const feed = feeds.getFeed(userId(request), id);
    return feed ?? missing(reply, "Feed");
  });

  app.post("/api/feeds/discover", async (request, reply) => {
    const { url } = z.object({ url: httpUrl }).parse(request.body);
    try {
      return await discoverFeed(url, feedDiscoveryTimeoutMs);
    } catch (error) {
      if (error instanceof FeedDiscoveryError) {
        return reply.code(422).send({ error: error.message, code: error.kind });
      }
      throw error;
    }
  });

  app.post("/api/web-feeds/analyze", async (request, reply) => {
    if (!webFeedService) {
      return reply
        .code(503)
        .send({ error: "Web feed loading is unavailable. Check the server's Chromium setup." });
    }
    const { url } = z.object({ url: httpUrl }).strict().parse(request.body);
    return webFeedService.analyze(String(userId(request)), url);
  });

  app.get("/api/web-feed-snapshots/:id", async (request, reply) => {
    if (!webFeedService) return missing(reply, "Page preview");
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    try {
      const snapshot = webFeedService.snapshot(String(userId(request)), id);
      return reply
        .type("text/html; charset=utf-8")
        .header(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        )
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .send(snapshot);
    } catch (error) {
      if (error instanceof WebFeedError) {
        return reply.code(404).send({
          error: "This page preview has expired. Reload the page, then choose the entries again.",
          code: error.kind,
        });
      }
      throw error;
    }
  });

  app.post("/api/feeds", async (request, reply) => {
    const body = z
      .discriminatedUnion("sourceKind", [
        z
          .object({
            sourceKind: z.literal("published"),
            title: z.string().trim().min(1).max(300).optional(),
            feedUrl: httpUrl,
            siteUrl: httpUrl.nullable().optional(),
            folderId: nullableId.optional(),
            paused: z.boolean().optional(),
          })
          .strict(),
        z
          .object({
            sourceKind: z.literal("web"),
            title: z.string().trim().min(1).max(300).optional(),
            feedUrl: httpUrl,
            siteUrl: httpUrl.nullable().optional(),
            folderId: nullableId.optional(),
            webConfig: webFeedConfig,
          })
          .strict(),
      ])
      .parse(request.body);
    const accountId = userId(request);
    feeds.assertCanCreateFeed(accountId);
    if (body.sourceKind === "published") {
      const feed = feeds.createFeed(accountId, body);
      if (!feed.paused && feeds.subscriptionNeedsRefresh(feed.id)) {
        refreshService.request([feed.id]);
      }
      return feeds.getFeed(accountId, feed.id);
    }
    if (!webFeedService) {
      return reply
        .code(503)
        .send({ error: "Web feed loading is unavailable. Check the server's Chromium setup." });
    }
    const extracted = await webFeedService.extract(body.webConfig as WebFeedConfig);
    const feed = feeds.createWebFeed(accountId, {
      title: body.title ?? extracted.parsed.title,
      pageUrl: body.feedUrl,
      folderId: body.folderId ?? null,
      config: body.webConfig as WebFeedConfig,
      parsed: extracted.parsed,
    });
    refreshService.notifyDataChanged(accountId);
    return feed;
  });

  app.post("/api/feeds/:id/web-feed/analyze", async (request, reply) => {
    if (!webFeedService) {
      return reply
        .code(503)
        .send({ error: "Web feed loading is unavailable. Check the server's Chromium setup." });
    }
    const { id } = idParams.parse(request.params);
    const accountId = userId(request);
    const feed = feeds.getFeed(accountId, id);
    if (!feed) return missing(reply, "Feed");
    if (feed.sourceKind !== "web") {
      return reply.code(400).send({ error: "Choose a web feed before editing a page selection." });
    }
    const config = feeds.getWebFeedConfig(accountId, id);
    if (!config) return missing(reply, "Page selection");
    return webFeedService.analyze(String(accountId), config.pageUrl, config);
  });

  app.patch("/api/feeds/:id/web-feed", async (request, reply) => {
    if (!webFeedService) {
      return reply
        .code(503)
        .send({ error: "Web feed loading is unavailable. Check the server's Chromium setup." });
    }
    const { id } = idParams.parse(request.params);
    const { config } = z.object({ config: webFeedConfig }).strict().parse(request.body);
    const accountId = userId(request);
    const feed = feeds.getFeed(accountId, id);
    if (!feed) return missing(reply, "Feed");
    if (feed.sourceKind !== "web") {
      return reply.code(400).send({ error: "Choose a web feed before editing a page selection." });
    }
    const extracted = await webFeedService.extract(config as WebFeedConfig);
    const updated = feeds.updateWebFeedSelection(
      accountId,
      id,
      config as WebFeedConfig,
      extracted.parsed,
    );
    if (!updated) return missing(reply, "Feed");
    refreshService.notifyDataChanged(accountId);
    return updated;
  });

  app.patch("/api/feeds/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(300).optional(),
        feedUrl: httpUrl.optional(),
        siteUrl: httpUrl.nullable().optional(),
        folderId: nullableId.optional(),
        paused: z.boolean().optional(),
      })
      .parse(request.body);
    const feed = feeds.updateFeed(userId(request), id, body);
    return feed ?? missing(reply, "Feed");
  });

  app.delete("/api/feeds/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!feeds.deleteFeed(userId(request), id)) return missing(reply, "Feed");
    return reply.code(204).send();
  });

  app.post("/api/feeds/:id/refresh", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!feeds.getFeed(userId(request), id)) return missing(reply, "Feed");
    return refreshService.request([id]);
  });
}
