import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { resourceId } from "../../shared/api-inputs.js";

export type UserId = (request: FastifyRequest) => number;

export const idParams = z.object({ id: z.coerce.number().pipe(resourceId) });

export function missing(reply: FastifyReply, resource: string): FastifyReply {
  return reply.code(404).send({ error: `${resource} was not found.` });
}
