// Persistent server state in DATA_DIR/mobbin-mcp.db: registered OAuth clients, authorization codes,
// access/refresh tokens (stored as SHA-256 hashes only) and each user's Mobbin session (AES-256-GCM).
// node:sqlite is synchronous, so every method runs to completion without interleaving other requests.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Session } from "./api.js";

export const ACCESS_TOKEN_TTL = 3600; // seconds
export const REFRESH_TOKEN_TTL = 30 * 86400;
export const CODE_TTL = 300;

const now = () => Math.floor(Date.now() / 1000);
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const opaque = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

// The key is 32 random bytes, base64 (e.g. `openssl rand -base64 32`).
function parseKey(value: string, source: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) throw new Error(`${source} must be 32 bytes, base64-encoded (got ${key.length} bytes). Generate one with: openssl rand -base64 32`);
  return key;
}

// ENCRYPTION_KEY from the environment when set. Otherwise DATA_DIR/encryption.key, created on first
// run (mode 600) and reused after that. Losing or changing the key makes stored Mobbin sessions unreadable.
export function encryptionKey(dataDir: string, envValue: string | undefined): { key: Buffer; source: string; created: boolean } {
  if (envValue) return { key: parseKey(envValue, "ENCRYPTION_KEY"), source: "ENCRYPTION_KEY", created: false };
  const file = join(dataDir, "encryption.key");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fresh = randomBytes(32);
  try {
    writeFileSync(file, `${fresh.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    return { key: fresh, source: file, created: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return { key: parseKey(readFileSync(file, "utf8"), file), source: file, created: false };
}

export interface CodeGrant {
  clientId: string;
  userId: string;
  redirectUri: string;
  redirectUriExplicit: boolean; // the authorize request named redirect_uri, so the token request must repeat it
  codeChallenge: string;
  resource: string;
}

export interface TokenGrant {
  kind: "access" | "refresh";
  clientId: string;
  userId: string;
  resource: string;
  expiresAt: number;
}

export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(
    dataDir: string,
    private key: Buffer,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, "mobbin-mcp.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (
        hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        redirect_explicit INTEGER NOT NULL, challenge TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL,
        resource TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tokens_user ON tokens (user_id);
      CREATE TABLE IF NOT EXISTS sessions (user_id TEXT PRIMARY KEY, email TEXT, sealed BLOB NOT NULL, updated_at INTEGER NOT NULL);
    `);
  }

  // ---------- clients (Dynamic Client Registration) ----------

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT metadata FROM clients WHERE client_id = ?").get(clientId) as { metadata: string } | undefined;
    return row ? (JSON.parse(row.metadata) as OAuthClientInformationFull) : undefined;
  }

  putClient(client: OAuthClientInformationFull): void {
    this.db.prepare("INSERT INTO clients (client_id, metadata, created_at) VALUES (?, ?, ?)").run(client.client_id, JSON.stringify(client), now());
  }

  // ---------- authorization codes (single use) ----------

  issueCode(grant: CodeGrant): string {
    const code = opaque("mmc");
    this.db
      .prepare("INSERT INTO codes (hash, client_id, user_id, redirect_uri, redirect_explicit, challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(hash(code), grant.clientId, grant.userId, grant.redirectUri, grant.redirectUriExplicit ? 1 : 0, grant.codeChallenge, grant.resource, now() + CODE_TTL);
    return code;
  }

  peekCode(code: string): CodeGrant | null {
    const row = this.db.prepare("SELECT * FROM codes WHERE hash = ? AND expires_at > ?").get(hash(code), now()) as Record<string, string | number> | undefined;
    if (!row) return null;
    return {
      clientId: String(row.client_id),
      userId: String(row.user_id),
      redirectUri: String(row.redirect_uri),
      redirectUriExplicit: row.redirect_explicit === 1,
      codeChallenge: String(row.challenge),
      resource: String(row.resource),
    };
  }

  takeCode(code: string): CodeGrant | null {
    const grant = this.peekCode(code);
    this.db.prepare("DELETE FROM codes WHERE hash = ?").run(hash(code));
    return grant;
  }

  // ---------- access and refresh tokens ----------

  issueTokens(userId: string, clientId: string, resource: string): IssuedTokens {
    const access = opaque("mma");
    const refresh = opaque("mmr");
    const insert = this.db.prepare("INSERT INTO tokens (hash, kind, client_id, user_id, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run(hash(access), "access", clientId, userId, resource, now() + ACCESS_TOKEN_TTL);
    insert.run(hash(refresh), "refresh", clientId, userId, resource, now() + REFRESH_TOKEN_TTL);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, refresh_token: refresh };
  }

  getToken(token: string, kind: TokenGrant["kind"]): TokenGrant | null {
    const row = this.db.prepare("SELECT * FROM tokens WHERE hash = ? AND kind = ? AND expires_at > ?").get(hash(token), kind, now()) as
      | Record<string, string | number>
      | undefined;
    if (!row) return null;
    return { kind, clientId: String(row.client_id), userId: String(row.user_id), resource: String(row.resource), expiresAt: Number(row.expires_at) };
  }

  deleteToken(token: string): void {
    this.db.prepare("DELETE FROM tokens WHERE hash = ?").run(hash(token));
  }

  // ---------- Mobbin sessions, encrypted, keyed by Mobbin user id ----------

  saveSession(userId: string, session: Session): void {
    this.db
      .prepare("INSERT INTO sessions (user_id, email, sealed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, sealed = excluded.sealed, updated_at = excluded.updated_at")
      .run(userId, session.user.email ?? null, this.seal(JSON.stringify(session), userId), now());
  }

  loadSession(userId: string): Session | null {
    const row = this.db.prepare("SELECT sealed FROM sessions WHERE user_id = ?").get(userId) as { sealed: Uint8Array } | undefined;
    return row ? (JSON.parse(this.open(Buffer.from(row.sealed), userId)) as Session) : null;
  }

  hasSession(userId: string): boolean {
    return this.db.prepare("SELECT 1 FROM sessions WHERE user_id = ?").get(userId) !== undefined;
  }

  // The user's Mobbin session is dead: drop it and every token issued for them, so their clients
  // get a 401 and run the sign-in again.
  dropUser(userId: string): void {
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM tokens WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM codes WHERE user_id = ?").run(userId);
    this.db.exec("COMMIT");
  }

  pruneExpired(): void {
    const t = now();
    this.db.prepare("DELETE FROM tokens WHERE expires_at <= ?").run(t);
    this.db.prepare("DELETE FROM codes WHERE expires_at <= ?").run(t);
  }

  // iv (12) | tag (16) | ciphertext; the user id is bound as associated data.
  private seal(plaintext: string, userId: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(userId));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private open(sealed: Buffer, userId: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
  }
}
