import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FeedRefreshService } from "../../refresh.js";
import { type AuthService, sessionToken } from "../auth/service.js";
import type { FeedService } from "../feeds/service.js";
import type { UserId } from "../routes.js";

export async function refreshRoutes(
  app: FastifyInstance,
  {
    feeds,
    refreshService,
    authService,
    userId,
  }: {
    feeds: FeedService;
    refreshService: FeedRefreshService;
    authService: AuthService;
    userId: UserId;
  },
): Promise<void> {
  const closeEventStreams = new Set<() => void>();

  app.addHook("preClose", async () => {
    for (const close of [...closeEventStreams]) close();
  });

  app.get("/api/refresh/events", (request, reply) => {
    const accountId = userId(request);
    const token = sessionToken(request.headers.cookie);
    const stream = reply.raw;
    reply.hijack();
    stream.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe = () => {};
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      closeEventStreams.delete(close);
    };
    const close = () => {
      cleanup();
      if (!stream.destroyed && !stream.writableEnded) stream.end();
    };
    const sessionActive = () => authService.userForToken(token)?.id === accountId;
    const sendChange = () => {
      if (!sessionActive()) {
        close();
        return;
      }
      writeEvent(stream, "data: changed\n\n");
    };
    unsubscribe = refreshService.subscribe(accountId, sendChange);
    heartbeat = setInterval(() => {
      if (!sessionActive()) {
        close();
        return;
      }
      writeEvent(stream, ": keep-alive\n\n");
    }, 15_000);
    heartbeat.unref();
    closeEventStreams.add(close);
    stream.once("close", cleanup);
    stream.once("finish", cleanup);
    stream.once("error", cleanup);
    sendChange();
  });

  app.post("/api/refresh", async (request) => {
    const body = z
      .object({ feedIds: z.array(z.number().int().positive()).max(1_000).optional() })
      .parse(request.body ?? {});
    const feedIds = feeds.getManualRefreshFeedIds(userId(request), body.feedIds);
    return refreshService.request(feedIds);
  });
}

function writeEvent(stream: ServerResponse, event: string): void {
  if (stream.destroyed || stream.writableEnded) return;
  stream.write(event);
}
