import type Sqlite from "better-sqlite3";
import {
  DEFAULT_ARTICLE_SUMMARY_PROMPT,
  DEFAULT_ARTICLE_TRANSLATION_PROMPT,
  DEFAULT_CUSTOM_PROMPTS,
} from "../../../shared/ai-prompts.js";

const LEGACY_OWNER = "__legacy_owner__";

export interface StoredUser {
  id: number;
  publicId: string;
  username: string;
  passwordHash: string;
  hasPassword: boolean;
  passwordEnrolledAt: string | null;
  webauthnUserId: Buffer;
}

export interface StoredSession {
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  recentAuthAt: string;
}

export interface AuthenticatedSession {
  tokenHash: string;
  recentAuthAt: string | null;
  user: StoredUser;
}

export interface StoredPasskey {
  id: string;
  name: string;
  userId: number;
  username: string;
  publicKey: Buffer;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface StoredAuthChallenge {
  idHash: string;
  challenge: string;
  kind: "passkey-registration" | "passkey-authentication" | "step-up-authentication";
  userId: number | null;
  sessionHash: string | null;
  operationIdHash: string | null;
  origin: string;
  rpId: string;
  expiresAt: string;
}

export interface StoredPendingRegistration {
  idHash: string;
  username: string;
  webauthnUserId: Buffer;
  challenge: string;
  origin: string;
  rpId: string;
  expiresAt: string;
}

export interface StoredAuthOperation {
  idHash: string;
  sessionHash: string;
  userId: number;
  startedAt: string;
  passwordEnrolledAt: string | null;
  passkeyIds: string[];
  expiresAt: string;
}

function booleanRow<T extends { hasPassword: number }>(
  row: T,
): Omit<T, "hasPassword"> & {
  hasPassword: boolean;
} {
  return { ...row, hasPassword: row.hasPassword === 1 };
}

export class AuthRepository {
  constructor(private readonly sqlite: Sqlite.Database) {}

  authHashSecret(): Buffer {
    return this.sqlite
      .prepare("SELECT value FROM auth_secrets WHERE name = 'limiter-hmac'")
      .pluck()
      .get() as Buffer;
  }

  deleteExpiredSessions(at: string, idleCutoff: string): void {
    this.sqlite
      .prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?")
      .run(at, idleCutoff);
  }

  registrationAvailable(maxAccounts: number): boolean {
    if (maxAccounts <= 0) return false;
    const count = this.sqlite
      .prepare("SELECT COUNT(*) FROM users WHERE enabled = 1")
      .pluck()
      .get() as number;
    return count < maxAccounts;
  }

  private createDefaultSettings(userId: number, pollIntervalMinutes: number): void {
    this.sqlite
      .prepare(
        `INSERT INTO settings (
           user_id, poll_interval_minutes, single_key_shortcuts, mark_read_on_scroll,
           show_youtube_descriptions, translation_language, summary_prompt,
           translation_prompt, custom_prompts_json
         ) VALUES (?, ?, 1, 1, 0, 'English', ?, ?, ?)`,
      )
      .run(
        userId,
        pollIntervalMinutes,
        DEFAULT_ARTICLE_SUMMARY_PROMPT,
        DEFAULT_ARTICLE_TRANSLATION_PROMPT,
        JSON.stringify(DEFAULT_CUSTOM_PROMPTS),
      );
  }

  private createUser(
    username: string,
    passwordHash: string,
    hasPassword: boolean,
    passwordEnrolledAt: string | null,
    publicId: string,
    webauthnUserId: Buffer,
    pollIntervalMinutes: number,
    at: string,
  ): StoredUser {
    const legacy = this.sqlite
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .get(LEGACY_OWNER) as { id: number } | undefined;
    let id: number;
    if (legacy) {
      this.sqlite
        .prepare(
          `UPDATE users
           SET username = ?, password_hash = ?, has_password = ?, password_enrolled_at = ?,
               public_id = ?, webauthn_user_id = ?, enabled = 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          username,
          passwordHash,
          hasPassword ? 1 : 0,
          passwordEnrolledAt,
          publicId,
          webauthnUserId,
          at,
          legacy.id,
        );
      id = legacy.id;
    } else {
      const result = this.sqlite
        .prepare(
          `INSERT INTO users (
             username, password_hash, has_password, password_enrolled_at, public_id,
             webauthn_user_id, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          username,
          passwordHash,
          hasPassword ? 1 : 0,
          passwordEnrolledAt,
          publicId,
          webauthnUserId,
          at,
          at,
        );
      id = Number(result.lastInsertRowid);
      this.createDefaultSettings(id, pollIntervalMinutes);
    }
    return {
      id,
      publicId,
      username,
      passwordHash,
      hasPassword,
      passwordEnrolledAt,
      webauthnUserId,
    };
  }

  registerUserWithSession(
    username: string,
    passwordHash: string,
    publicId: string,
    webauthnUserId: Buffer,
    defaultPollIntervalMinutes: number,
    session: StoredSession,
    maxAccounts: number,
  ): StoredUser | null {
    const register = this.sqlite.transaction(() => {
      if (!this.registrationAvailable(maxAccounts)) return null;
      if (
        this.sqlite.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)
      )
        return null;
      const user = this.createUser(
        username,
        passwordHash,
        true,
        session.createdAt,
        publicId,
        webauthnUserId,
        defaultPollIntervalMinutes,
        session.createdAt,
      );
      this.insertSession(user.id, session);
      return user;
    });
    return register.immediate();
  }

  storePendingRegistration(pending: StoredPendingRegistration, maxAccounts: number): boolean {
    const store = this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM pending_registrations WHERE expires_at <= ?")
        .run(new Date().toISOString());
      if (!this.registrationAvailable(maxAccounts)) return false;
      if (
        this.sqlite
          .prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE")
          .get(pending.username) ||
        this.sqlite
          .prepare("SELECT 1 FROM pending_registrations WHERE username = ? COLLATE NOCASE")
          .get(pending.username)
      )
        return false;
      this.sqlite
        .prepare(
          `INSERT INTO pending_registrations (
             id_hash, username, webauthn_user_id, challenge, origin, rp_id, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pending.idHash,
          pending.username,
          pending.webauthnUserId,
          pending.challenge,
          pending.origin,
          pending.rpId,
          pending.expiresAt,
        );
      return true;
    });
    return store.immediate();
  }

  pendingRegistration(idHash: string, at: string): StoredPendingRegistration | null {
    return (
      (this.sqlite
        .prepare(
          `SELECT id_hash AS idHash, username, webauthn_user_id AS webauthnUserId,
                  challenge, origin, rp_id AS rpId, expires_at AS expiresAt
           FROM pending_registrations WHERE id_hash = ? AND expires_at > ?`,
        )
        .get(idHash, at) as StoredPendingRegistration | undefined) ?? null
    );
  }

  completePendingRegistration(
    idHash: string,
    passwordHash: string,
    publicId: string,
    passkey: Omit<StoredPasskey, "userId" | "username">,
    defaultPollIntervalMinutes: number,
    session: StoredSession,
    maxAccounts: number,
    at: string,
  ): StoredUser | null {
    const complete = this.sqlite.transaction(() => {
      const pending = this.pendingRegistration(idHash, at);
      this.sqlite.prepare("DELETE FROM pending_registrations WHERE id_hash = ?").run(idHash);
      if (!pending || !this.registrationAvailable(maxAccounts)) return null;
      if (
        this.sqlite
          .prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE")
          .get(pending.username) ||
        this.sqlite.prepare("SELECT 1 FROM passkeys WHERE id = ?").get(passkey.id)
      )
        return null;
      const user = this.createUser(
        pending.username,
        passwordHash,
        false,
        null,
        publicId,
        pending.webauthnUserId,
        defaultPollIntervalMinutes,
        at,
      );
      this.insertPasskey({ ...passkey, userId: user.id, username: user.username });
      this.insertSession(user.id, session);
      return user;
    });
    return complete.immediate();
  }

  findEnabledUser(username: string): StoredUser | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, public_id AS publicId, username, password_hash AS passwordHash,
                has_password AS hasPassword, password_enrolled_at AS passwordEnrolledAt,
                webauthn_user_id AS webauthnUserId
         FROM users WHERE username = ? COLLATE NOCASE AND enabled = 1`,
      )
      .get(username) as (Omit<StoredUser, "hasPassword"> & { hasPassword: number }) | undefined;
    return row ? booleanRow(row) : null;
  }

  insertSession(userId: number, session: StoredSession): void {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO sessions (
             token_hash, user_id, created_at, last_seen_at, expires_at, recent_auth_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.tokenHash,
          userId,
          session.createdAt,
          session.lastSeenAt,
          session.expiresAt,
          session.recentAuthAt,
        );
      this.sqlite
        .prepare("UPDATE users SET last_active_at = ? WHERE id = ?")
        .run(session.lastSeenAt, userId);
    })();
  }

  touchUserActivity(userId: number, at: string, touchBefore: string): boolean {
    return (
      this.sqlite
        .prepare("UPDATE users SET last_active_at = ? WHERE id = ? AND last_active_at <= ?")
        .run(at, userId, touchBefore).changes > 0
    );
  }

  sessionForTokenHash(
    hash: string,
    at: string,
    idleCutoff: string,
    touchBefore: string,
  ): AuthenticatedSession | null {
    const row = this.sqlite
      .prepare(
        `SELECT sessions.token_hash AS tokenHash, sessions.recent_auth_at AS recentAuthAt,
                users.id, users.public_id AS publicId, users.username,
                users.password_hash AS passwordHash, users.has_password AS hasPassword,
                users.password_enrolled_at AS passwordEnrolledAt,
                users.webauthn_user_id AS webauthnUserId
         FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?
           AND sessions.last_seen_at > ? AND users.enabled = 1`,
      )
      .get(hash, at, idleCutoff) as
      | (Omit<StoredUser, "hasPassword"> & {
          tokenHash: string;
          recentAuthAt: string | null;
          hasPassword: number;
        })
      | undefined;
    if (!row) return null;
    const { tokenHash, recentAuthAt, ...user } = row;
    this.sqlite
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at <= ?")
      .run(at, hash, touchBefore);
    this.touchUserActivity(user.id, at, touchBefore);
    return { tokenHash, recentAuthAt, user: booleanRow(user) };
  }

  deleteSession(hash: string): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
  }

  markSessionRecentlyAuthenticated(hash: string, at: string): boolean {
    return (
      this.sqlite
        .prepare("UPDATE sessions SET recent_auth_at = ? WHERE token_hash = ?")
        .run(at, hash).changes > 0
    );
  }

  updatePassword(
    userId: number,
    passwordHash: string,
    currentSessionHash: string,
    at: string,
  ): void {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE users SET password_hash = ?, has_password = 1,
             password_enrolled_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(passwordHash, at, at, userId);
      this.sqlite
        .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?")
        .run(userId, currentSessionHash);
    })();
  }

  removePassword(userId: number, replacementHash: string, at: string): void {
    this.sqlite
      .prepare(
        `UPDATE users SET password_hash = ?, has_password = 0,
           password_enrolled_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(replacementHash, at, userId);
  }

  upgradePasswordHash(userId: number, passwordHash: string, at: string): void {
    this.sqlite
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, at, userId);
  }

  passkeysForUser(userId: number): StoredPasskey[] {
    const rows = this.sqlite
      .prepare(
        `SELECT passkeys.id, passkeys.name, passkeys.user_id AS userId, users.username,
                passkeys.public_key AS publicKey, passkeys.counter, passkeys.device_type AS deviceType,
                passkeys.backed_up AS backedUp, passkeys.transports_json AS transportsJson,
                passkeys.created_at AS createdAt, passkeys.last_used_at AS lastUsedAt
         FROM passkeys JOIN users ON users.id = passkeys.user_id
         WHERE passkeys.user_id = ? ORDER BY passkeys.created_at DESC`,
      )
      .all(userId) as Array<
      Omit<StoredPasskey, "backedUp" | "transports"> & {
        backedUp: number;
        transportsJson: string;
      }
    >;
    return rows.map(({ backedUp, transportsJson, ...row }) => ({
      ...row,
      backedUp: backedUp === 1,
      transports: JSON.parse(transportsJson) as string[],
    }));
  }

  passkeyById(id: string): StoredPasskey | null {
    const row = this.sqlite
      .prepare(
        `SELECT passkeys.id, passkeys.name, passkeys.user_id AS userId, users.username,
                passkeys.public_key AS publicKey, passkeys.counter, passkeys.device_type AS deviceType,
                passkeys.backed_up AS backedUp, passkeys.transports_json AS transportsJson,
                passkeys.created_at AS createdAt, passkeys.last_used_at AS lastUsedAt
         FROM passkeys JOIN users ON users.id = passkeys.user_id
         WHERE passkeys.id = ? AND users.enabled = 1`,
      )
      .get(id) as
      | (Omit<StoredPasskey, "backedUp" | "transports"> & {
          backedUp: number;
          transportsJson: string;
        })
      | undefined;
    if (!row) return null;
    const { backedUp, transportsJson, ...passkey } = row;
    return {
      ...passkey,
      backedUp: backedUp === 1,
      transports: JSON.parse(transportsJson) as string[],
    };
  }

  insertPasskey(passkey: StoredPasskey): void {
    this.sqlite
      .prepare(
        `INSERT INTO passkeys (
           id, name, user_id, public_key, counter, device_type, backed_up, transports_json,
           created_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        passkey.id,
        passkey.name,
        passkey.userId,
        passkey.publicKey,
        passkey.counter,
        passkey.deviceType,
        passkey.backedUp ? 1 : 0,
        JSON.stringify(passkey.transports),
        passkey.createdAt,
        passkey.lastUsedAt,
      );
  }

  renamePasskey(userId: number, id: string, name: string): boolean {
    return (
      this.sqlite
        .prepare("UPDATE passkeys SET name = ? WHERE user_id = ? AND id = ?")
        .run(name, userId, id).changes > 0
    );
  }

  updatePasskeyUse(
    id: string,
    counter: number,
    deviceType: string,
    backedUp: boolean,
    at: string,
  ): void {
    this.sqlite
      .prepare(
        `UPDATE passkeys SET counter = ?, device_type = ?, backed_up = ?, last_used_at = ?
         WHERE id = ?`,
      )
      .run(counter, deviceType, backedUp ? 1 : 0, at, id);
  }

  deletePasskey(userId: number, id: string): boolean {
    return (
      this.sqlite.prepare("DELETE FROM passkeys WHERE user_id = ? AND id = ?").run(userId, id)
        .changes > 0
    );
  }

  userWithPasskeys(userId: number): StoredUser | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, public_id AS publicId, username, password_hash AS passwordHash,
                has_password AS hasPassword, password_enrolled_at AS passwordEnrolledAt,
                webauthn_user_id AS webauthnUserId
         FROM users WHERE id = ? AND enabled = 1`,
      )
      .get(userId) as (Omit<StoredUser, "hasPassword"> & { hasPassword: number }) | undefined;
    return row ? booleanRow(row) : null;
  }

  storeChallenge(challenge: StoredAuthChallenge): void {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM auth_challenges WHERE expires_at <= ?")
        .run(new Date().toISOString());
      this.sqlite
        .prepare(
          `INSERT INTO auth_challenges (
             id_hash, challenge, kind, user_id, session_hash, operation_id_hash,
             origin, rp_id, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          challenge.idHash,
          challenge.challenge,
          challenge.kind,
          challenge.userId,
          challenge.sessionHash,
          challenge.operationIdHash,
          challenge.origin,
          challenge.rpId,
          challenge.expiresAt,
        );
    })();
  }

  consumeChallenge(
    idHash: string,
    kind: StoredAuthChallenge["kind"],
    at: string,
  ): StoredAuthChallenge | null {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT id_hash AS idHash, challenge, kind, user_id AS userId,
                  session_hash AS sessionHash, operation_id_hash AS operationIdHash,
                  origin, rp_id AS rpId, expires_at AS expiresAt
           FROM auth_challenges WHERE id_hash = ? AND kind = ? AND expires_at > ?`,
        )
        .get(idHash, kind, at) as StoredAuthChallenge | undefined;
      this.sqlite.prepare("DELETE FROM auth_challenges WHERE id_hash = ?").run(idHash);
      return row ?? null;
    })();
  }

  storeAuthOperation(operation: StoredAuthOperation): void {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM auth_operations WHERE expires_at <= ?")
        .run(operation.startedAt);
      this.sqlite
        .prepare(
          `INSERT INTO auth_operations (
             id_hash, session_hash, user_id, started_at, password_enrolled_at,
             passkey_ids_json, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.idHash,
          operation.sessionHash,
          operation.userId,
          operation.startedAt,
          operation.passwordEnrolledAt,
          JSON.stringify(operation.passkeyIds),
          operation.expiresAt,
        );
    })();
  }

  authOperation(idHash: string, sessionHash: string, at: string): StoredAuthOperation | null {
    const row = this.sqlite
      .prepare(
        `SELECT id_hash AS idHash, session_hash AS sessionHash, user_id AS userId,
                started_at AS startedAt, password_enrolled_at AS passwordEnrolledAt,
                passkey_ids_json AS passkeyIdsJson, expires_at AS expiresAt
         FROM auth_operations
         WHERE id_hash = ? AND session_hash = ? AND expires_at > ?`,
      )
      .get(idHash, sessionHash, at) as
      | (Omit<StoredAuthOperation, "passkeyIds"> & { passkeyIdsJson: string })
      | undefined;
    if (!row) return null;
    const { passkeyIdsJson, ...operation } = row;
    return { ...operation, passkeyIds: JSON.parse(passkeyIdsJson) as string[] };
  }

  consumeRateLimit(
    keyHash: string,
    limit: number,
    windowMs: number,
    currentMs: number,
  ): number | null {
    const consume = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM auth_rate_limits WHERE reset_at <= ?").run(currentMs);
      const row = this.sqlite
        .prepare("SELECT attempts, reset_at AS resetAt FROM auth_rate_limits WHERE key_hash = ?")
        .get(keyHash) as { attempts: number; resetAt: number } | undefined;
      if (row && row.attempts >= limit)
        return Math.max(1, Math.ceil((row.resetAt - currentMs) / 1_000));
      if (row) {
        this.sqlite
          .prepare("UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE key_hash = ?")
          .run(keyHash);
      } else {
        this.sqlite
          .prepare("INSERT INTO auth_rate_limits (key_hash, attempts, reset_at) VALUES (?, 1, ?)")
          .run(keyHash, currentMs + windowMs);
      }
      return null;
    });
    return consume.immediate();
  }

  reduceRateLimit(keyHash: string): void {
    const reduce = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "UPDATE auth_rate_limits SET attempts = attempts - 1 WHERE key_hash = ? AND attempts > 1",
        )
        .run(keyHash);
      this.sqlite
        .prepare("DELETE FROM auth_rate_limits WHERE key_hash = ? AND attempts <= 1")
        .run(keyHash);
    });
    reduce.immediate();
  }

  clearRateLimit(keyHash: string): void {
    this.sqlite.prepare("DELETE FROM auth_rate_limits WHERE key_hash = ?").run(keyHash);
  }
}
