import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type AuthService, type LoginSession, sessionToken } from "./service.js";

const username = z
  .string()
  .trim()
  .min(3, "Use at least 3 characters for the username.")
  .max(32, "Use no more than 32 characters for the username.")
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
    "Use letters, numbers, dots, hyphens, or underscores; start and end with a letter or number.",
  );
const loginUsername = z.string().trim().min(1).max(80);
const password = z
  .string()
  .min(15, "Use at least 15 characters for the password.")
  .max(128, "Use no more than 128 characters for the password.");
const loginCredentials = z.object({
  username: loginUsername,
  password: z.string().min(1).max(128),
});
const registrationCredentials = z.object({ username, password });
const passwordChange = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
});
const passwordConfirmation = z.object({ password: z.string().min(1).max(128) });
const ceremonyId = z.string().min(32).max(128);
const passkeyResponse = z
  .object({
    id: z.string().min(1).max(2_048),
    rawId: z.string().min(1).max(2_048),
    response: z.object({}).passthrough(),
    type: z.literal("public-key"),
    clientExtensionResults: z.object({}).passthrough(),
  })
  .passthrough();
const passkeyCeremony = z.object({ ceremonyId, response: passkeyResponse });
const passkeyId = z.string().min(1).max(2_048);
const passkeyRename = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name for the passkey.")
    .max(80, "Use no more than 80 characters for the passkey name."),
});

class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  private remember(key: string, attempts: number[]): void {
    this.attempts.delete(key);
    this.attempts.set(key, attempts);
    while (this.attempts.size > 10_000) {
      const oldestKey = this.attempts.keys().next().value;
      if (oldestKey === undefined) break;
      this.attempts.delete(oldestKey);
    }
  }

  check(key: string, limit: number, windowMs = 15 * 60_000, record = true): number | null {
    const cutoff = Date.now() - windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((time) => time > cutoff);
    if (recent.length >= limit) {
      this.remember(key, recent);
      return Math.max(1, Math.ceil((recent[0] + windowMs - Date.now()) / 1_000));
    }
    if (record) recent.push(Date.now());
    this.remember(key, recent);
    return null;
  }

  record(key: string): void {
    const recent = this.attempts.get(key) ?? [];
    recent.push(Date.now());
    this.remember(key, recent);
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

const limiter = new AttemptLimiter();

function publicOrigin(request: FastifyRequest, configuredOrigin: string | undefined): URL {
  if (configuredOrigin) return new URL(configuredOrigin);
  return new URL(`${request.protocol}://${request.headers.host ?? request.hostname}`);
}

function passkeysAvailable(origin: URL): boolean {
  return (
    origin.protocol === "https:" ||
    origin.hostname === "localhost" ||
    origin.hostname.endsWith(".localhost")
  );
}

function webAuthnContext(request: FastifyRequest, configuredOrigin: string | undefined) {
  const origin = publicOrigin(request, configuredOrigin);
  return { origin: origin.origin, rpId: origin.hostname };
}

function secureRequest(request: FastifyRequest, configuredOrigin: string | undefined): boolean {
  return publicOrigin(request, configuredOrigin).protocol === "https:";
}

function sendSession(
  reply: FastifyReply,
  request: FastifyRequest,
  authService: AuthService,
  session: LoginSession,
  configuredOrigin: string | undefined,
): FastifyReply {
  return reply
    .header(
      "Set-Cookie",
      authService.sessionCookie(session.token, secureRequest(request, configuredOrigin)),
    )
    .send({ user: session.user });
}

function limited(reply: FastifyReply, retryAfter: number | null): FastifyReply | null {
  if (retryAfter === null) return null;
  return reply
    .header("Retry-After", retryAfter)
    .code(429)
    .send({ error: "Too many attempts. Wait a few minutes, then try again." });
}

function authenticatedUser(request: FastifyRequest, authService: AuthService) {
  return authService.userForToken(sessionToken(request.headers.cookie));
}

export async function authRoutes(
  app: FastifyInstance,
  { authService, configuredOrigin }: { authService: AuthService; configuredOrigin?: string },
): Promise<void> {
  app.get("/api/auth/config", async (request) => {
    const origin = publicOrigin(request, configuredOrigin);
    return {
      registrationAvailable: authService.registrationAvailable(),
      passkeysAvailable: passkeysAvailable(origin),
    };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginCredentials.parse(request.body);
    const accountKey = `password:${request.ip}:${body.username.toLocaleLowerCase("en-US")}`;
    const rateLimited =
      limited(reply, limiter.check(`password-ip:${request.ip}`, 50, undefined, false)) ??
      limited(reply, limiter.check(accountKey, 10, undefined, false));
    if (rateLimited) return rateLimited;
    const session = await authService.login(body.username, body.password);
    if (!session) {
      limiter.record(`password-ip:${request.ip}`);
      limiter.record(accountKey);
      return reply.code(401).send({ error: "The username or password is incorrect." });
    }
    limiter.clear(accountKey);
    return sendSession(reply, request, authService, session, configuredOrigin);
  });

  app.post("/api/auth/register", async (request, reply) => {
    const rateLimited = limited(reply, limiter.check(`register:${request.ip}`, 10, 60 * 60_000));
    if (rateLimited) return rateLimited;
    const body = registrationCredentials.parse(request.body);
    if (!authService.registrationAvailable()) {
      return reply.code(403).send({ error: "Account creation is closed on this server." });
    }
    const session = await authService.register(body.username, body.password);
    if (!session) {
      return authService.registrationAvailable()
        ? reply.code(409).send({ error: "That username is already in use." })
        : reply.code(403).send({ error: "Account creation is closed on this server." });
    }
    return sendSession(reply.code(201), request, authService, session, configuredOrigin);
  });

  app.get("/api/auth/session", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    return { user };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    authService.endSession(sessionToken(request.headers.cookie));
    return reply
      .header(
        "Set-Cookie",
        authService.clearSessionCookie(secureRequest(request, configuredOrigin)),
      )
      .code(204)
      .send();
  });

  app.post("/api/auth/password", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    const token = sessionToken(request.headers.cookie);
    if (!user || !token) return reply.code(401).send({ error: "Sign in to continue." });
    const body = passwordChange.parse(request.body);
    const sensitiveKey = `sensitive:${request.ip}:${user.id}`;
    const rateLimited = limited(reply, limiter.check(sensitiveKey, 10, undefined, false));
    if (rateLimited) return rateLimited;
    if (body.currentPassword === body.newPassword) {
      return reply.code(400).send({ error: "Choose a password you have not already used here." });
    }
    if (
      !(await authService.changePassword(user.id, token, body.currentPassword, body.newPassword))
    ) {
      limiter.record(sensitiveKey);
      return reply.code(401).send({ error: "The current password is incorrect." });
    }
    limiter.clear(sensitiveKey);
    return reply.code(204).send();
  });

  app.get("/api/auth/passkeys", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    return { passkeys: authService.passkeys(user.id) };
  });

  app.post("/api/auth/passkeys/options", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    const context = webAuthnContext(request, configuredOrigin);
    if (!passkeysAvailable(new URL(context.origin))) {
      return reply.code(400).send({ error: "Passkeys require HTTPS or localhost." });
    }
    const result = await authService.passkeyRegistrationOptions(user.id, context);
    if (!result) return reply.code(401).send({ error: "Sign in to continue." });
    return result;
  });

  app.post("/api/auth/passkeys", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    const body = passkeyCeremony.parse(request.body);
    try {
      const passkey = await authService.verifyPasskeyRegistration(
        user.id,
        body.ceremonyId,
        body.response as unknown as RegistrationResponseJSON,
      );
      if (!passkey) throw new Error("Passkey verification failed");
      return reply.code(201).send({ passkey });
    } catch {
      return reply.code(400).send({ error: "The passkey could not be verified. Try again." });
    }
  });

  app.patch("/api/auth/passkeys/:id", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    const id = passkeyId.parse((request.params as { id?: unknown }).id);
    const body = passkeyRename.parse(request.body);
    const passkey = authService.renamePasskey(user.id, id, body.name);
    if (!passkey) {
      return reply.code(404).send({ error: "That passkey no longer exists." });
    }
    return { passkey };
  });

  app.delete("/api/auth/passkeys/:id", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    const body = passwordConfirmation.parse(request.body);
    const sensitiveKey = `sensitive:${request.ip}:${user.id}`;
    const rateLimited = limited(reply, limiter.check(sensitiveKey, 10, undefined, false));
    if (rateLimited) return rateLimited;
    if (!(await authService.passwordMatches(user.id, body.password))) {
      limiter.record(sensitiveKey);
      return reply.code(401).send({ error: "The password is incorrect." });
    }
    limiter.clear(sensitiveKey);
    const id = passkeyId.parse((request.params as { id?: unknown }).id);
    if (!authService.deletePasskey(user.id, id)) {
      return reply.code(404).send({ error: "That passkey no longer exists." });
    }
    return reply.code(204).send();
  });

  app.post("/api/auth/passkey/options", async (request, reply) => {
    const rateLimited = limited(reply, limiter.check(`passkey:${request.ip}`, 30));
    if (rateLimited) return rateLimited;
    const context = webAuthnContext(request, configuredOrigin);
    if (!passkeysAvailable(new URL(context.origin))) {
      return reply.code(400).send({ error: "Passkeys require HTTPS or localhost." });
    }
    return authService.passkeyAuthenticationOptions(context);
  });

  app.post("/api/auth/passkey", async (request, reply) => {
    const rateLimited = limited(reply, limiter.check(`passkey:${request.ip}`, 30));
    if (rateLimited) return rateLimited;
    const body = passkeyCeremony.parse(request.body);
    try {
      const session = await authService.verifyPasskeyAuthentication(
        body.ceremonyId,
        body.response as unknown as AuthenticationResponseJSON,
      );
      if (!session) throw new Error("Passkey verification failed");
      return sendSession(reply, request, authService, session, configuredOrigin);
    } catch {
      return reply.code(401).send({ error: "The passkey could not sign you in. Try again." });
    }
  });
}
