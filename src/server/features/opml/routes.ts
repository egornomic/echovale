import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { QuotaExceededError } from "../../quota.js";
import type { FeedRefreshService } from "../../refresh.js";
import type { UserId } from "../routes.js";
import type { OpmlService } from "./service.js";

export async function opmlRoutes(
  app: FastifyInstance,
  {
    opml,
    refreshService,
    userId,
  }: { opml: OpmlService; refreshService: FeedRefreshService; userId: UserId },
): Promise<void> {
  app.post("/api/opml/import", async (request, reply) => {
    const { opml: source } = z.object({ opml: z.string().min(1) }).parse(request.body);
    try {
      const { feedIds, ...result } = opml.import(userId(request), source);
      refreshService.request(feedIds);
      return result;
    } catch (error) {
      if (error instanceof QuotaExceededError) throw error;
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/opml/export", async (request, reply) => {
    return reply
      .header("Content-Type", "text/x-opml; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="feedfold-subscriptions.opml"')
      .send(opml.export(userId(request)));
  });
}
