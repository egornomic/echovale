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
const passkeySignup = z.object({ username });
const passwordCredential = z.object({ password });
const ceremonyId = z.string().min(32).max(128);
const operationId = z.string().min(32).max(128);
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
const passkeySignupCeremony = z.object({ registrationId: operationId, response: passkeyResponse });
const stepUpPassword = z.object({ operationId, password: z.string().min(1).max(128) });
const stepUpOptions = z.object({ operationId });
const passkeyId = z.string().min(1).max(2_048);
const passkeyRename = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name for the passkey.")
    .max(80, "Use no more than 80 characters for the passkey name."),
});

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
    .send({ user: authService.publicUser(session.user) });
}

function limited(reply: FastifyReply, retryAfter: number | null): FastifyReply | null {
  if (retryAfter === null) return null;
  return reply
    .header("Retry-After", retryAfter)
    .code(429)
    .send({ error: "Too many attempts. Try again when the cooldown ends." });
}

function authenticatedUser(request: FastifyRequest, authService: AuthService) {
  return authService.userForToken(sessionToken(request.headers.cookie));
}

export async function authRoutes(
  app: FastifyInstance,
  { authService, configuredOrigin }: { authService: AuthService; configuredOrigin?: string },
): Promise<void> {
  app.get("/api/auth/config", async (request) => ({
    registrationAvailable: authService.registrationAvailable(),
    passkeysAvailable: passkeysAvailable(publicOrigin(request, configuredOrigin)),
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const body = loginCredentials.parse(request.body);
    const rateLimited = limited(reply, authService.consumeLoginAttempt(request.ip, body.username));
    if (rateLimited) return rateLimited;
    const session = await authService.login(body.username, body.password);
    if (!session) return reply.code(401).send({ error: "The username or password is incorrect." });
    authService.loginSucceeded(request.ip, session.user.username);
    return sendSession(reply, request, authService, session, configuredOrigin);
  });

  app.post("/api/auth/register", async (request, reply) => {
    const rateLimited = limited(reply, authService.consumeRegistrationAttempt(request.ip));
    if (rateLimited) return rateLimited;
    const body = registrationCredentials.parse(request.body);
    if (!authService.registrationAvailable())
      return reply.code(403).send({ error: "Account creation is closed on this server." });
    const session = await authService.register(body.username, body.password);
    if (!session) {
      if (!authService.registrationAvailable())
        return reply.code(403).send({ error: "Account creation is closed on this server." });
      return reply
        .code(409)
        .send({ error: "The account could not be created. Choose another name or try again." });
    }
    return sendSession(reply.code(201), request, authService, session, configuredOrigin);
  });

  app.post("/api/auth/register/passkey/options", async (request, reply) => {
    const rateLimited = limited(reply, authService.consumeRegistrationAttempt(request.ip));
    if (rateLimited) return rateLimited;
    const body = passkeySignup.parse(request.body);
    const context = webAuthnContext(request, configuredOrigin);
    if (!passkeysAvailable(new URL(context.origin)))
      return reply.code(400).send({ error: "Passkeys require HTTPS or localhost." });
    if (!authService.registrationAvailable())
      return reply.code(403).send({ error: "Account creation is closed on this server." });
    const result = await authService.passkeySignupOptions(body.username, context);
    if (!result) {
      if (!authService.registrationAvailable())
        return reply.code(403).send({ error: "Account creation is closed on this server." });
      return reply
        .code(409)
        .send({ error: "The account could not be created. Choose another name or try again." });
    }
    return result;
  });

  app.post("/api/auth/register/passkey", async (request, reply) => {
    const body = passkeySignupCeremony.parse(request.body);
    try {
      const session = await authService.completePasskeySignup(
        body.registrationId,
        body.response as unknown as RegistrationResponseJSON,
      );
      if (!session) {
        if (!authService.registrationAvailable())
          return reply.code(403).send({ error: "Account creation is closed on this server." });
        throw new Error("Passkey signup failed");
      }
      return sendSession(reply.code(201), request, authService, session, configuredOrigin);
    } catch {
      return reply.code(400).send({ error: "The account could not be created. Try again." });
    }
  });

  app.get("/api/auth/session", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    return { user: authService.publicUser(user) };
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

  app.post("/api/auth/step-up/password", async (request, reply) => {
    const token = sessionToken(request.headers.cookie);
    if (!token) return reply.code(401).send({ error: "Sign in to continue." });
    const rateLimited = limited(reply, authService.consumeStepUpAttempt(token));
    if (rateLimited) return rateLimited;
    const body = stepUpPassword.parse(request.body);
    if (!(await authService.stepUpWithPassword(token, body.operationId, body.password)))
      return reply.code(401).send({ error: "Authentication failed. Try again." });
    authService.stepUpSucceeded(token);
    return reply.code(204).send();
  });

  app.post("/api/auth/step-up/passkey/options", async (request, reply) => {
    const token = sessionToken(request.headers.cookie);
    if (!token) return reply.code(401).send({ error: "Sign in to continue." });
    const rateLimited = limited(reply, authService.consumeStepUpAttempt(token));
    if (rateLimited) return rateLimited;
    const body = stepUpOptions.parse(request.body);
    const context = webAuthnContext(request, configuredOrigin);
    if (!passkeysAvailable(new URL(context.origin)))
      return reply.code(400).send({ error: "Passkeys require HTTPS or localhost." });
    const result = await authService.stepUpPasskeyOptions(token, body.operationId, context);
    if (!result) return reply.code(401).send({ error: "Authentication failed. Try again." });
    return result;
  });

  app.post("/api/auth/step-up/passkey", async (request, reply) => {
    const token = sessionToken(request.headers.cookie);
    if (!token) return reply.code(401).send({ error: "Sign in to continue." });
    const body = passkeyCeremony.parse(request.body);
    try {
      if (
        !(await authService.verifyStepUpPasskey(
          token,
          body.ceremonyId,
          body.response as unknown as AuthenticationResponseJSON,
        ))
      )
        throw new Error("Step-up failed");
      authService.stepUpSucceeded(token);
      return reply.code(204).send();
    } catch {
      return reply.code(401).send({ error: "Authentication failed. Try again." });
    }
  });

  app.put("/api/auth/password", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    const token = sessionToken(request.headers.cookie);
    if (!user || !token) return reply.code(401).send({ error: "Sign in to continue." });
    const body = passwordCredential.parse(request.body);
    await authService.setPassword(user.id, token, body.password);
    return reply.code(204).send();
  });

  app.delete("/api/auth/password", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    await authService.removePassword(user.id);
    return reply.code(204).send();
  });

  app.get("/api/auth/passkeys", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    return { passkeys: authService.passkeys(user.id), hasPassword: user.hasPassword };
  });

  app.post("/api/auth/passkeys/options", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    const context = webAuthnContext(request, configuredOrigin);
    if (!passkeysAvailable(new URL(context.origin)))
      return reply.code(400).send({ error: "Passkeys require HTTPS or localhost." });
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
    return passkey
      ? { passkey }
      : reply.code(404).send({ error: "That passkey no longer exists." });
  });

  app.delete("/api/auth/passkeys/:id", async (request, reply) => {
    const user = authenticatedUser(request, authService);
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    const id = passkeyId.parse((request.params as { id?: unknown }).id);
    if (!authService.deletePasskey(user.id, id))
      return reply.code(404).send({ error: "That passkey no longer exists." });
    return reply.code(204).send();
  });

  app.post("/api/auth/passkey/options", async (request, reply) => {
    const rateLimited = limited(reply, authService.consumePasskeyLoginAttempt(request.ip));
    if (rateLimited) return rateLimited;
    const context = webAuthnContext(request, configuredOrigin);
    if (!passkeysAvailable(new URL(context.origin)))
      return reply.code(400).send({ error: "Passkeys require HTTPS or localhost." });
    return authService.passkeyAuthenticationOptions(context);
  });

  app.post("/api/auth/passkey", async (request, reply) => {
    const body = passkeyCeremony.parse(request.body);
    const rateLimited = limited(reply, authService.consumePasskeyAccountAttempt(body.response.id));
    if (rateLimited) return rateLimited;
    try {
      const session = await authService.verifyPasskeyAuthentication(
        body.ceremonyId,
        body.response as unknown as AuthenticationResponseJSON,
      );
      if (!session) throw new Error("Passkey verification failed");
      authService.passkeyLoginSucceeded(request.ip, session.user.username);
      return sendSession(reply, request, authService, session, configuredOrigin);
    } catch {
      return reply.code(401).send({ error: "The passkey could not sign you in. Try again." });
    }
  });
}
