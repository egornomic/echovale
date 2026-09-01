import type Sqlite from "better-sqlite3";
import {
  DEFAULT_ARTICLE_SUMMARY_PROMPT,
  DEFAULT_ARTICLE_TRANSLATION_PROMPT,
  DEFAULT_CUSTOM_PROMPTS,
} from "../../../shared/ai-prompts.js";
import type { SessionUser } from "../../../shared/types.js";

const LEGACY_OWNER = "__legacy_owner__";

export interface UserWithPassword extends SessionUser {
  passwordHash: string;
  webauthnUserId: Buffer;
}

export interface StoredSession {
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
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
  kind: "passkey-registration" | "passkey-authentication";
  userId: number | null;
  origin: string;
  rpId: string;
  expiresAt: string;
}

export class AuthRepository {
  constructor(private readonly sqlite: Sqlite.Database) {}

  deleteExpiredSessions(at: string, idleCutoff: string): void {
    this.sqlite
      .prepare("DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?")
      .run(at, idleCutoff);
  }

  registrationAvailable(allowAdditionalUsers: boolean): boolean {
    if (allowAdditionalUsers) return true;
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM users WHERE enabled = 1")
      .get() as { count: number };
    return row.count === 0;
  }

  registerUserWithSession(
    username: string,
    passwordHash: string,
    webauthnUserId: Buffer,
    defaultPollIntervalMinutes: number,
    session: StoredSession,
    allowAdditionalUsers: boolean,
  ): SessionUser | null {
    return this.sqlite.transaction(() => {
      if (!this.registrationAvailable(allowAdditionalUsers)) return null;
      const existing = this.sqlite
        .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
        .get(username);
      if (existing) return null;

      const legacy = this.sqlite
        .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
        .get(LEGACY_OWNER) as { id: number } | undefined;
      let user: SessionUser;
      if (legacy) {
        this.sqlite
          .prepare(
            `UPDATE users
             SET username = ?, password_hash = ?, webauthn_user_id = ?, enabled = 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(username, passwordHash, webauthnUserId, session.createdAt, legacy.id);
        user = { id: legacy.id, username };
      } else {
        const result = this.sqlite
          .prepare(
            `INSERT INTO users (
               username, password_hash, webauthn_user_id, enabled, created_at, updated_at
             ) VALUES (?, ?, ?, 1, ?, ?)`,
          )
          .run(username, passwordHash, webauthnUserId, session.createdAt, session.createdAt);
        const userId = Number(result.lastInsertRowid);
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
            defaultPollIntervalMinutes,
            DEFAULT_ARTICLE_SUMMARY_PROMPT,
            DEFAULT_ARTICLE_TRANSLATION_PROMPT,
            JSON.stringify(DEFAULT_CUSTOM_PROMPTS),
          );
        user = { id: userId, username };
      }
      this.insertSession(user.id, session);
      return user;
    })();
  }

  findEnabledUser(username: string): UserWithPassword | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, username, password_hash AS passwordHash,
                webauthn_user_id AS webauthnUserId
         FROM users WHERE username = ? COLLATE NOCASE AND enabled = 1`,
      )
      .get(username) as UserWithPassword | undefined;
    return row ?? null;
  }

  insertSession(userId: number, session: StoredSession): void {
    this.sqlite
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(session.tokenHash, userId, session.createdAt, session.lastSeenAt, session.expiresAt);
  }

  userForTokenHash(
    hash: string,
    at: string,
    idleCutoff: string,
    touchBefore: string,
  ): SessionUser | null {
    const row = this.sqlite
      .prepare(
        `SELECT users.id, users.username
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?
           AND sessions.last_seen_at > ? AND users.enabled = 1`,
      )
      .get(hash, at, idleCutoff) as SessionUser | undefined;
    if (!row) return null;
    this.sqlite
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at <= ?")
      .run(at, hash, touchBefore);
    return row;
  }

  deleteSession(hash: string): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
  }

  updatePassword(
    userId: number,
    passwordHash: string,
    currentSessionHash: string,
    at: string,
  ): void {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, at, userId);
      this.sqlite
        .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?")
        .run(userId, currentSessionHash);
    })();
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

  userWithPasskeys(userId: number): UserWithPassword | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, username, password_hash AS passwordHash,
                webauthn_user_id AS webauthnUserId
         FROM users WHERE id = ? AND enabled = 1`,
      )
      .get(userId) as UserWithPassword | undefined;
    return row ?? null;
  }

  storeChallenge(challenge: StoredAuthChallenge): void {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM auth_challenges WHERE expires_at <= ?")
        .run(new Date().toISOString());
      this.sqlite
        .prepare(
          `INSERT INTO auth_challenges (
             id_hash, challenge, kind, user_id, origin, rp_id, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          challenge.idHash,
          challenge.challenge,
          challenge.kind,
          challenge.userId,
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
          `SELECT id_hash AS idHash, challenge, kind, user_id AS userId, origin,
                  rp_id AS rpId, expires_at AS expiresAt
           FROM auth_challenges WHERE id_hash = ? AND kind = ? AND expires_at > ?`,
        )
        .get(idHash, kind, at) as StoredAuthChallenge | undefined;
      this.sqlite.prepare("DELETE FROM auth_challenges WHERE id_hash = ?").run(idHash);
      return row ?? null;
    })();
  }
}
