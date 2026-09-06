import type { FastifyInstance } from "fastify";
import { inputs } from "../../../shared/api-inputs.js";
import { idParams, missing, type UserId } from "../routes.js";
import type { RuleRepository } from "./repository.js";

export async function ruleRoutes(
  app: FastifyInstance,
  { rules, userId }: { rules: RuleRepository; userId: UserId },
): Promise<void> {
  app.get("/api/rules", async (request) => ({
    rules: rules.listRules(userId(request)),
  }));

  app.post("/api/rules", async (request) =>
    rules.createRule(userId(request), inputs.createRule.parse(request.body)),
  );

  app.patch("/api/rules/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const accountId = userId(request);
    const body = inputs.updateRule.parse(request.body);
    return rules.updateRule(accountId, id, body) ?? missing(reply, "Rule");
  });

  app.delete("/api/rules/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!rules.deleteRule(userId(request), id)) return missing(reply, "Rule");
    return reply.code(204).send();
  });
}
