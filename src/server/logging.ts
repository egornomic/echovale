import { createHmac, randomBytes } from "node:crypto";
import type {
  FastifyInstance,
  FastifyLoggerOptions,
  FastifyRequest,
  FastifyServerOptions,
} from "fastify";

const SENSITIVE_LOG_FIELDS = [
  "req",
  "request",
  "headers",
  "body",
  "payload",
  "query",
  "params",
  "cookies",
  "cookie",
  "authorization",
  "credentials",
  "password",
  "token",
  "apiKey",
  "api_key",
  "prompt",
  "input",
  "messages",
  "instructions",
  "systemInstruction",
  "search",
  "searchTerm",
  "terms",
  "url",
  "uri",
  "href",
  "feedUrl",
  "articleUrl",
  "ip",
  "address",
  "remoteAddress",
  "forwardedFor",
  "xForwardedFor",
  "err",
  "error",
] as const;

const REDACTED_LOG_FIELDS = SENSITIVE_LOG_FIELDS.flatMap((field) => [field, `*.${field}`]);

export function productionLogger(
  stream?: FastifyLoggerOptions["stream"],
): FastifyServerOptions["logger"] {
  return {
    level: "info",
    stream,
    redact: {
      paths: REDACTED_LOG_FIELDS,
      remove: true,
    },
  };
}

export function productionListenMessage(): string {
  return "feedfold started";
}

function securityEvent(request: FastifyRequest, statusCode: number): string | undefined {
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 403) return "request_rejected";
  if (statusCode !== 401) return undefined;
  return request.routeOptions.url?.startsWith("/api/auth/")
    ? "authentication_failed"
    : "authentication_required";
}

export function registerOperationalLogging(app: FastifyInstance): void {
  const pseudonymKey = randomBytes(32);

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "<unmatched>";
    const fields: Record<string, number | string> = {
      event: "http_request",
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs: Number(reply.elapsedTime.toFixed(3)),
    };
    const event = securityEvent(request, reply.statusCode);
    if (event) {
      fields.securityEvent = event;
      fields.sourceId = createHmac("sha256", pseudonymKey)
        .update(request.ip)
        .digest("base64url")
        .slice(0, 16);
      request.log.warn(fields, "security event");
      return;
    }
    if (reply.statusCode >= 500) {
      request.log.error(fields, "request failed");
      return;
    }
    request.log.info(fields, "request completed");
  });
}
