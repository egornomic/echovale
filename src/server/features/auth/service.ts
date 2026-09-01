import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
} from "./repository.js";

const SESSION_COOKIE = "feedfold_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_SECONDS = 60 * 5;
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface LoginSession {
  token: string;
  user: SessionUser;
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

export interface AuthOptions {
  allowPublicRegistration?: boolean;
}

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

export function sessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}

export class AuthService {
  private readonly allowPublicRegistration: boolean;
  private readonly dummyPasswordHash: Promise<string>;

  constructor(
    private readonly repository: AuthRepository,
    private readonly defaultPollIntervalMinutes = 20,
    options: AuthOptions = {},
  ) {
    this.allowPublicRegistration = options.allowPublicRegistration ?? false;
    const current = now();
    this.repository.deleteExpiredSessions(current, accountActivityCutoff(current));
    this.dummyPasswordHash = hashPassword(randomBytes(32).toString("base64url"));
  }

  registrationAvailable(): boolean {
    return this.repository.registrationAvailable(this.allowPublicRegistration);
  }

  async register(username: string, password: string): Promise<LoginSession | null> {
    const trimmedUsername = username.trim();
    const token = randomBytes(32).toString("base64url");
    const storedSession = this.storedSession(token);
    const user = this.repository.registerUserWithSession(
      trimmedUsername,
      await hashPassword(password),
      randomBytes(32),
      normalizeFeedPollInterval(this.defaultPollIntervalMinutes),
      storedSession,
      this.allowPublicRegistration,
    );
    return user ? { token, user } : null;
  }

  async login(username: string, password: string): Promise<LoginSession | null> {
    const row = this.repository.findEnabledUser(username.trim());
    const storedHash = row?.passwordHash ?? (await this.dummyPasswordHash);
    if (!(await verifyPassword(password, storedHash)) || !row) return null;

    if (
      !row.passwordHash.startsWith("$argon2id$") ||
      argon2.needsRehash(row.passwordHash, ARGON2_OPTIONS)
    ) {
      this.repository.upgradePasswordHash(row.id, await hashPassword(password), now());
    }
    return this.createSession({ id: row.id, username: row.username });
  }

  private createSession(user: SessionUser): LoginSession {
    const token = randomBytes(32).toString("base64url");
    this.repository.insertSession(user.id, this.storedSession(token));
    return { token, user };
  }

  private storedSession(token: string): StoredSession {
    const createdAt = now();
    return {
      tokenHash: tokenHash(token),
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: new Date(Date.now() + SESSION_SECONDS * 1_000).toISOString(),
    };
  }

  userForToken(token: string | null): SessionUser | null {
    if (!token) return null;
    const current = now();
    return this.repository.userForTokenHash(
      tokenHash(token),
      current,
      accountActivityCutoff(current),
      accountActivityTouchBefore(current),
    );
  }

  endSession(token: string | null): void {
    if (!token) return;
    this.repository.deleteSession(tokenHash(token));
  }

  async changePassword(
    userId: number,
    currentSessionToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = this.repository.userWithPasskeys(userId);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) return false;
    this.repository.updatePassword(
      userId,
      await hashPassword(newPassword),
      tokenHash(currentSessionToken),
      now(),
    );
    return true;
  }

  async passwordMatches(userId: number, password: string): Promise<boolean> {
    const user = this.repository.userWithPasskeys(userId);
    return user ? verifyPassword(password, user.passwordHash) : false;
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
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
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

  async verifyPasskeyAuthentication(
    ceremonyId: string,
    response: AuthenticationResponseJSON,
  ): Promise<LoginSession | null> {
    const challenge = this.consumeChallenge(ceremonyId, "passkey-authentication");
    const passkey = this.repository.passkeyById(response.id);
    if (!challenge || !passkey) return null;
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
    if (!verification.verified) return null;
    const { newCounter, credentialBackedUp, credentialDeviceType } =
      verification.authenticationInfo;
    this.repository.updatePasskeyUse(
      passkey.id,
      newCounter,
      credentialDeviceType,
      credentialBackedUp,
      now(),
    );
    return this.createSession({ id: passkey.userId, username: passkey.username });
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
  ): string {
    const ceremonyId = randomBytes(32).toString("base64url");
    this.repository.storeChallenge({
      idHash: tokenHash(ceremonyId),
      challenge,
      kind,
      userId,
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
