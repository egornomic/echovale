import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import argon2 from "argon2";
import { normalizeFeedPollInterval, type SessionUser } from "../../../shared/types.js";
import { accountActivityCutoff, accountActivityTouchBefore } from "../../account-activity.js";
import type {
  AuthRepository,
  StoredAuthChallenge,
  StoredPasskey,
  StoredSession,
  StoredUser,
} from "./repository.js";

const SESSION_COOKIE = "feedfold_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_SECONDS = 60 * 5;
const PENDING_REGISTRATION_SECONDS = 60 * 5;
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface LoginSession {
  token: string;
  user: AuthenticatedUser;
}

export interface AuthenticatedUser {
  id: number;
  publicId: string;
  username: string;
  hasPassword: boolean;
}

export interface WebAuthnContext {
  origin: string;
  rpId: string;
}

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string;
  backedUp: boolean;
}

export interface AuthRateLimitOptions {
  registrationPerIp: { attempts: number; windowMs: number };
  registrationGlobal: { attempts: number; windowMs: number };
  loginPerIp: { attempts: number; windowMs: number };
  loginPerAccount: { attempts: number; windowMs: number };
  stepUp: { attempts: number; windowMs: number };
}

export interface AuthOptions {
  maxAccounts?: number;
  recentAuthenticationSeconds?: number;
  rateLimits?: Partial<AuthRateLimitOptions>;
}

const DEFAULT_RATE_LIMITS: AuthRateLimitOptions = {
  registrationPerIp: { attempts: 10, windowMs: 60 * 60_000 },
  registrationGlobal: { attempts: 100, windowMs: 60 * 60_000 },
  loginPerIp: { attempts: 50, windowMs: 15 * 60_000 },
  loginPerAccount: { attempts: 10, windowMs: 15 * 60_000 },
  stepUp: { attempts: 10, windowMs: 15 * 60_000 },
};

async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

function verifyLegacyPassword(password: string, stored: string): boolean {
  const [algorithm, saltValue, digestValue] = stored.split("$");
  if (algorithm !== "scrypt" || !saltValue || !digestValue) return false;
  const expected = Buffer.from(digestValue, "base64url");
  const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$argon2id$")) {
    try {
      return await argon2.verify(stored, password);
    } catch {
      return false;
    }
  }
  return verifyLegacyPassword(password, stored);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function now(): string {
  return new Date().toISOString();
}

function passkeySummary(passkey: StoredPasskey): PasskeySummary {
  return {
    id: passkey.id,
    name: passkey.name,
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
    deviceType: passkey.deviceType,
    backedUp: passkey.backedUp,
  };
}

function authenticatedUser(user: StoredUser): AuthenticatedUser {
  return {
    id: user.id,
    publicId: user.publicId,
    username: user.username,
    hasPassword: user.hasPassword,
  };
}

export function sessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}

export class AuthService {
  private readonly maxAccounts: number;
  private readonly recentAuthenticationSeconds: number;
  private readonly rateLimits: AuthRateLimitOptions;
  private readonly authHashSecret: Buffer;
  private readonly dummyPasswordHash: Promise<string>;

  constructor(
    private readonly repository: AuthRepository,
    private readonly defaultPollIntervalMinutes = 20,
    options: AuthOptions = {},
  ) {
    this.maxAccounts = options.maxAccounts ?? 1;
    this.recentAuthenticationSeconds = options.recentAuthenticationSeconds ?? 5 * 60;
    this.rateLimits = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
    this.authHashSecret = this.repository.authHashSecret();
    const current = now();
    this.repository.deleteExpiredSessions(current, accountActivityCutoff(current));
    this.dummyPasswordHash = hashPassword(randomBytes(32).toString("base64url"));
  }

  publicUser(user: AuthenticatedUser | StoredUser): SessionUser {
    return { id: user.publicId, username: user.username, hasPassword: user.hasPassword };
  }

  registrationAvailable(): boolean {
    return this.repository.registrationAvailable(this.maxAccounts);
  }

  private keyedHash(namespace: string, value: string): string {
    return createHmac("sha256", this.authHashSecret)
      .update(`${namespace}\0${value}`)
      .digest("base64url");
  }

  private consumeLimit(
    namespace: string,
    value: string,
    setting: { attempts: number; windowMs: number },
  ): number | null {
    return this.repository.consumeRateLimit(
      this.keyedHash(namespace, value),
      setting.attempts,
      setting.windowMs,
      Date.now(),
    );
  }

  consumeRegistrationAttempt(ip: string): number | null {
    const ipRetry = this.consumeLimit("registration-ip", ip, this.rateLimits.registrationPerIp);
    if (ipRetry !== null) return ipRetry;
    return this.consumeLimit(
      "registration-global",
      "deployment",
      this.rateLimits.registrationGlobal,
    );
  }

  consumeLoginAttempt(ip: string, username: string): number | null {
    const ipRetry = this.consumeLimit("login-ip", ip, this.rateLimits.loginPerIp);
    if (ipRetry !== null) return ipRetry;
    return this.consumeLimit(
      "login-account",
      username.trim().toLocaleLowerCase("en-US"),
      this.rateLimits.loginPerAccount,
    );
  }

  loginSucceeded(ip: string, username: string): void {
    this.repository.reduceRateLimit(this.keyedHash("login-ip", ip));
    this.repository.clearRateLimit(
      this.keyedHash("login-account", username.trim().toLocaleLowerCase("en-US")),
    );
  }

  consumePasskeyLoginAttempt(ip: string, credentialId?: string): number | null {
    const ipRetry = this.consumeLimit("login-ip", ip, this.rateLimits.loginPerIp);
    if (ipRetry !== null) return ipRetry;
    return credentialId ? this.consumePasskeyAccountAttempt(credentialId) : null;
  }

  consumePasskeyAccountAttempt(credentialId: string): number | null {
    const passkey = this.repository.passkeyById(credentialId);
    return passkey
      ? this.consumeLimit(
          "login-account",
          passkey.username.toLocaleLowerCase("en-US"),
          this.rateLimits.loginPerAccount,
        )
      : null;
  }

  passkeyLoginSucceeded(ip: string, username: string): void {
    this.loginSucceeded(ip, username);
  }

  consumeStepUpAttempt(sessionHash: string): number | null {
    return this.consumeLimit("step-up-session", sessionHash, this.rateLimits.stepUp);
  }

  stepUpSucceeded(sessionHash: string): void {
    this.repository.clearRateLimit(this.keyedHash("step-up-session", sessionHash));
  }

  async register(username: string, password: string): Promise<LoginSession | null> {
    const token = randomBytes(32).toString("base64url");
    const storedSession = this.storedSession(token);
    const user = this.repository.registerUserWithSession(
      username.trim(),
      await hashPassword(password),
      randomBytes(16).toString("hex"),
      randomBytes(32),
      normalizeFeedPollInterval(this.defaultPollIntervalMinutes),
      storedSession,
      this.maxAccounts,
    );
    return user ? { token, user: authenticatedUser(user) } : null;
  }

  async passkeySignupOptions(username: string, context: WebAuthnContext) {
    const trimmedUsername = username.trim();
    if (!this.registrationAvailable()) return null;
    const userHandle = randomBytes(32);
    const options = await generateRegistrationOptions({
      rpName: "feedfold",
      rpID: context.rpId,
      userID: new Uint8Array(userHandle),
      userName: trimmedUsername,
      userDisplayName: trimmedUsername,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const registrationId = randomBytes(32).toString("base64url");
    const stored = this.repository.storePendingRegistration(
      {
        idHash: tokenHash(registrationId),
        username: trimmedUsername,
        webauthnUserId: userHandle,
        challenge: options.challenge,
        origin: context.origin,
        rpId: context.rpId,
        expiresAt: new Date(Date.now() + PENDING_REGISTRATION_SECONDS * 1_000).toISOString(),
      },
      this.maxAccounts,
    );
    return stored ? { registrationId, options } : null;
  }

  async completePasskeySignup(
    registrationId: string,
    response: RegistrationResponseJSON,
  ): Promise<LoginSession | null> {
    const idHash = tokenHash(registrationId);
    const pending = this.repository.pendingRegistration(idHash, now());
    if (!pending) return null;
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin,
      expectedRPID: pending.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) return null;
    const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
    const createdAt = now();
    const token = randomBytes(32).toString("base64url");
    const session = this.storedSession(token);
    const user = this.repository.completePendingRegistration(
      idHash,
      await this.dummyPasswordHash,
      randomBytes(16).toString("hex"),
      {
        id: credential.id,
        name: credentialBackedUp ? "Synced passkey" : "Device passkey",
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: credential.transports ?? [],
        createdAt,
        lastUsedAt: null,
      },
      normalizeFeedPollInterval(this.defaultPollIntervalMinutes),
      session,
      this.maxAccounts,
      createdAt,
    );
    return user ? { token, user: authenticatedUser(user) } : null;
  }

  async login(username: string, password: string): Promise<LoginSession | null> {
    const row = this.repository.findEnabledUser(username.trim());
    const storedHash = row?.hasPassword ? row.passwordHash : await this.dummyPasswordHash;
    if (!(await verifyPassword(password, storedHash)) || !row?.hasPassword) return null;
    if (
      !row.passwordHash.startsWith("$argon2id$") ||
      argon2.needsRehash(row.passwordHash, ARGON2_OPTIONS)
    ) {
      this.repository.upgradePasswordHash(row.id, await hashPassword(password), now());
    }
    return this.createSession(row);
  }

  private createSession(user: StoredUser): LoginSession {
    const token = randomBytes(32).toString("base64url");
    this.repository.insertSession(user.id, this.storedSession(token));
    return { token, user: authenticatedUser(user) };
  }

  private storedSession(token: string): StoredSession {
    const createdAt = now();
    return {
      tokenHash: tokenHash(token),
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString(),
      recentAuthAt: createdAt,
    };
  }

  sessionForToken(token: string | null) {
    if (!token) return null;
    const current = now();
    return this.repository.sessionForTokenHash(
      tokenHash(token),
      current,
      accountActivityCutoff(current),
      accountActivityTouchBefore(current),
    );
  }

  userForToken(token: string | null): AuthenticatedUser | null {
    const user = this.sessionForToken(token)?.user;
    return user ? authenticatedUser(user) : null;
  }

  endSession(token: string | null): void {
    if (token) this.repository.deleteSession(tokenHash(token));
  }

  beginSensitiveOperation(
    token: string | null,
  ): { required: false } | { required: true; operationId: string } | null {
    const session = this.sessionForToken(token);
    if (!session) return null;
    const recentCutoff = Date.now() - this.recentAuthenticationSeconds * 1_000;
    if (session.recentAuthAt && new Date(session.recentAuthAt).getTime() >= recentCutoff)
      return { required: false };
    const operationId = randomBytes(32).toString("base64url");
    const startedAt = now();
    this.repository.storeAuthOperation({
      idHash: tokenHash(operationId),
      sessionHash: session.tokenHash,
      userId: session.user.id,
      startedAt,
      passwordEnrolledAt: session.user.hasPassword ? session.user.passwordEnrolledAt : null,
      passkeyIds: this.repository.passkeysForUser(session.user.id).map(({ id }) => id),
      expiresAt: new Date(Date.now() + CHALLENGE_SECONDS * 1_000).toISOString(),
    });
    return { required: true, operationId };
  }

  async stepUpWithPassword(token: string, operationId: string, password: string): Promise<boolean> {
    const session = this.sessionForToken(token);
    if (!session) return false;
    const operation = this.repository.authOperation(
      tokenHash(operationId),
      session.tokenHash,
      now(),
    );
    if (
      !operation ||
      !session.user.hasPassword ||
      !session.user.passwordEnrolledAt ||
      session.user.passwordEnrolledAt !== operation.passwordEnrolledAt ||
      !(await verifyPassword(password, session.user.passwordHash))
    )
      return false;
    return this.repository.markSessionRecentlyAuthenticated(session.tokenHash, now());
  }

  async stepUpPasskeyOptions(token: string, operationId: string, context: WebAuthnContext) {
    const session = this.sessionForToken(token);
    if (!session) return null;
    const operationHash = tokenHash(operationId);
    const operation = this.repository.authOperation(operationHash, session.tokenHash, now());
    if (!operation) return null;
    const passkeys = this.repository
      .passkeysForUser(session.user.id)
      .filter((passkey) => operation.passkeyIds.includes(passkey.id));
    if (passkeys.length === 0) return null;
    const options = await generateAuthenticationOptions({
      rpID: context.rpId,
      userVerification: "required",
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      })),
    });
    const ceremonyId = this.storeChallenge(
      "step-up-authentication",
      options.challenge,
      context,
      session.user.id,
      session.tokenHash,
      operationHash,
    );
    return { ceremonyId, options };
  }

  async verifyStepUpPasskey(
    token: string,
    ceremonyId: string,
    response: AuthenticationResponseJSON,
  ): Promise<boolean> {
    const session = this.sessionForToken(token);
    const challenge = this.consumeChallenge(ceremonyId, "step-up-authentication");
    if (
      !session ||
      !challenge ||
      challenge.sessionHash !== session.tokenHash ||
      !challenge.operationIdHash
    )
      return false;
    const operation = this.repository.authOperation(
      challenge.operationIdHash,
      session.tokenHash,
      now(),
    );
    const passkey = this.repository.passkeyById(response.id);
    if (
      !operation ||
      !passkey ||
      passkey.userId !== session.user.id ||
      !operation.passkeyIds.includes(passkey.id)
    )
      return false;
    const verified = await this.verifyPasskeyResponse(passkey, response, challenge);
    if (!verified) return false;
    return this.repository.markSessionRecentlyAuthenticated(session.tokenHash, now());
  }

  async setPassword(userId: number, currentSessionToken: string, password: string): Promise<void> {
    this.repository.updatePassword(
      userId,
      await hashPassword(password),
      tokenHash(currentSessionToken),
      now(),
    );
  }

  async removePassword(userId: number): Promise<void> {
    this.repository.removePassword(
      userId,
      await hashPassword(randomBytes(32).toString("base64url")),
      now(),
    );
  }

  passkeys(userId: number): PasskeySummary[] {
    return this.repository.passkeysForUser(userId).map(passkeySummary);
  }

  async passkeyRegistrationOptions(userId: number, context: WebAuthnContext) {
    const user = this.repository.userWithPasskeys(userId);
    if (!user) return null;
    const passkeys = this.repository.passkeysForUser(userId);
    const options = await generateRegistrationOptions({
      rpName: "feedfold",
      rpID: context.rpId,
      userID: new Uint8Array(user.webauthnUserId),
      userName: user.username,
      userDisplayName: user.username,
      attestationType: "none",
      excludeCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const ceremonyId = this.storeChallenge(
      "passkey-registration",
      options.challenge,
      context,
      userId,
    );
    return { ceremonyId, options };
  }

  async verifyPasskeyRegistration(
    userId: number,
    ceremonyId: string,
    response: RegistrationResponseJSON,
  ): Promise<PasskeySummary | null> {
    const challenge = this.consumeChallenge(ceremonyId, "passkey-registration");
    if (!challenge || challenge.userId !== userId) return null;
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) return null;
    const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
    const createdAt = now();
    const passkey: StoredPasskey = {
      id: credential.id,
      name: credentialBackedUp ? "Synced passkey" : "Device passkey",
      userId,
      username: "",
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: credential.transports ?? [],
      createdAt,
      lastUsedAt: null,
    };
    this.repository.insertPasskey(passkey);
    return passkeySummary(passkey);
  }

  async passkeyAuthenticationOptions(context: WebAuthnContext) {
    const options = await generateAuthenticationOptions({
      rpID: context.rpId,
      userVerification: "required",
    });
    const ceremonyId = this.storeChallenge(
      "passkey-authentication",
      options.challenge,
      context,
      null,
    );
    return { ceremonyId, options };
  }

  private async verifyPasskeyResponse(
    passkey: StoredPasskey,
    response: AuthenticationResponseJSON,
    challenge: StoredAuthChallenge,
  ): Promise<boolean> {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpId,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: true,
    });
    if (!verification.verified) return false;
    const { newCounter, credentialBackedUp, credentialDeviceType } =
      verification.authenticationInfo;
    this.repository.updatePasskeyUse(
      passkey.id,
      newCounter,
      credentialDeviceType,
      credentialBackedUp,
      now(),
    );
    return true;
  }

  async verifyPasskeyAuthentication(
    ceremonyId: string,
    response: AuthenticationResponseJSON,
  ): Promise<LoginSession | null> {
    const challenge = this.consumeChallenge(ceremonyId, "passkey-authentication");
    const passkey = this.repository.passkeyById(response.id);
    if (!challenge || !passkey || !(await this.verifyPasskeyResponse(passkey, response, challenge)))
      return null;
    const user = this.repository.userWithPasskeys(passkey.userId);
    return user ? this.createSession(user) : null;
  }

  deletePasskey(userId: number, id: string): boolean {
    return this.repository.deletePasskey(userId, id);
  }

  renamePasskey(userId: number, id: string, name: string): PasskeySummary | null {
    if (!this.repository.renamePasskey(userId, id, name)) return null;
    const passkey = this.repository.passkeyById(id);
    return passkey ? passkeySummary(passkey) : null;
  }

  private storeChallenge(
    kind: StoredAuthChallenge["kind"],
    challenge: string,
    context: WebAuthnContext,
    userId: number | null,
    sessionHash: string | null = null,
    operationIdHash: string | null = null,
  ): string {
    const ceremonyId = randomBytes(32).toString("base64url");
    this.repository.storeChallenge({
      idHash: tokenHash(ceremonyId),
      challenge,
      kind,
      userId,
      sessionHash,
      operationIdHash,
      origin: context.origin,
      rpId: context.rpId,
      expiresAt: new Date(Date.now() + CHALLENGE_SECONDS * 1_000).toISOString(),
    });
    return ceremonyId;
  }

  private consumeChallenge(
    ceremonyId: string,
    kind: StoredAuthChallenge["kind"],
  ): StoredAuthChallenge | null {
    return this.repository.consumeChallenge(tokenHash(ceremonyId), kind, now());
  }

  sessionCookie(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}; Priority=High${secure ? "; Secure" : ""}`;
  }

  clearSessionCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Priority=High${secure ? "; Secure" : ""}`;
  }
}
