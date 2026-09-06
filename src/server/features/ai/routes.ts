import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inputs } from "../../../shared/api-inputs.js";
import type { UserId } from "../routes.js";
import type { AiService } from "./service.js";

const aiFeatureParams = z.object({ feature: inputs.aiFeature });
const aiProviderParams = z.object({ provider: inputs.aiProvider });

export async function aiRoutes(
  app: FastifyInstance,
  { ai, userId }: { ai: AiService; userId: UserId },
): Promise<void> {
  app.get("/api/ai/settings", async (request) => ai.getSettings(userId(request)));

  app.patch("/api/ai/features/:feature", async (request) => {
    const { feature } = aiFeatureParams.parse(request.params);
    const body = inputs.updateAiFeature.parse(request.body);
    return ai.setFeatureSetting(userId(request), feature, body.provider, body.model);
  });

  app.put("/api/ai/providers/:provider/key", async (request) => {
    const { provider } = aiProviderParams.parse(request.params);
    const { apiKey } = inputs.saveAiProviderKey.parse(request.body);
    return ai.setApiKey(userId(request), provider, apiKey);
  });

  app.delete("/api/ai/providers/:provider/key", async (request) => {
    const { provider } = aiProviderParams.parse(request.params);
    return ai.deleteApiKey(userId(request), provider);
  });
}
