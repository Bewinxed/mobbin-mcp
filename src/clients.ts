// OAuth clients: Client ID Metadata Documents (the client_id is an https URL serving the client's
// metadata, draft-ietf-oauth-client-id-metadata-document-00) and Dynamic Client Registration
// (RFC 7591, kept for clients on older MCP authorization specs). Every client is public: it
// authenticates at the token endpoint with PKCE only ("none").
import { lookup as dnsLookup, promises as dnsPromises } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Store } from "./store.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_DOC_BYTES = 10_240;
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_MIN_S = 60;
const CACHE_DEFAULT_S = 300;
const CACHE_MAX_S = 86_400;

export type ResolvedClient = { client: OAuthClientInformationFull; metadataDocument: boolean } | { error: string };

// A redirect URI is https, or http on a loopback host (MCP authorization: "All redirect URIs MUST be
// either localhost or use HTTPS").
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== "string") return "redirect URIs must be strings";
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return `redirect URI ${JSON.stringify(uri)} is not a URL`;
  }
  if (u.hash) return `redirect URI ${uri} has a fragment`;
  if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) return null;
  return `redirect URI ${uri} must use https, or http on localhost/127.0.0.1`;
}

export const isLoopbackRedirect = (uri: string) => {
  const u = new URL(uri);
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
};

export class Clients implements OAuthRegisteredClientsStore {
  private documents = new Map<string, { client: OAuthClientInformationFull; until: number }>();

  constructor(private store: Store) {}

  // For the SDK's token endpoint: unknown or unusable clients are simply absent.
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const r = await this.resolve(clientId);
    return "client" in r ? r.client : undefined;
  }

  // For /authorize, which shows the reason a client can't be used.
  async resolve(clientId: string): Promise<ResolvedClient> {
    if (!clientId.startsWith("https://")) {
      const client = this.store.getClient(clientId);
      return client ? { client, metadataDocument: false } : { error: `Unknown client_id ${clientId}. Register the client first, or use a client ID metadata document URL.` };
    }
    const cached = this.documents.get(clientId);
    if (cached && cached.until > Date.now()) return { client: cached.client, metadataDocument: true };
    try {
      const { client, maxAge } = await fetchClientMetadata(clientId);
      this.documents.set(clientId, { client, until: Date.now() + maxAge * 1000 });
      if (this.documents.size > 1000) this.documents.delete(this.documents.keys().next().value!);
      return { client, metadataDocument: true };
    } catch (e) {
      return { error: `Client metadata document ${clientId} is unusable: ${(e as Error).message}` };
    }
  }

  // DCR. The SDK handler has validated the body against RFC 7591; registrations become public
  // clients whatever auth method they asked for, since the server issues no client secrets.
  registerClient(info: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const full = info as OAuthClientInformationFull;
    if (!full.redirect_uris?.length) throw new InvalidClientMetadataError("redirect_uris is required");
    for (const uri of full.redirect_uris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw new InvalidClientMetadataError(problem);
    }
    const { client_secret: _s, client_secret_expires_at: _e, ...rest } = full;
    const client: OAuthClientInformationFull = {
      ...rest,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    this.store.putClient(client);
    return client;
  }
}

// ---------- fetching a client ID metadata document ----------

async function fetchClientMetadata(clientId: string): Promise<{ client: OAuthClientInformationFull; maxAge: number }> {
  const url = new URL(clientId);
  if (url.href !== clientId) throw new Error(`client_id must be in normalized form (${url.href})`);
  if (url.pathname === "/") throw new Error("client_id URL must have a path");
  if (url.hash || url.username || url.password) throw new Error("client_id URL must not have a fragment or credentials");
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (isNonPublic(literal)) throw new Error(`${url.hostname} is not a public address`);
  } else {
    // Checked here as well as at connect time, because with an HTTP proxy configured
    // (NODE_USE_ENV_PROXY) the proxy resolves the host and the connect-time lookup never runs.
    const addresses = await dnsPromises.lookup(literal, { all: true });
    const blocked = addresses.find((a) => isNonPublic(a.address));
    if (blocked) throw new Error(`${url.hostname} resolves to non-public address ${blocked.address}`);
  }

  const { status, contentType, cacheControl, body } = await getSmall(url);
  if (status !== 200) throw new Error(`fetching it answered HTTP ${status}`);
  if (!/^application\/([a-z.+-]*\+)?json\b/i.test(contentType)) throw new Error(`it is served as ${contentType || "no content type"}, not JSON`);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error("it is not valid JSON");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("it is not a JSON object");
  if (doc.client_id !== clientId) throw new Error(`its client_id ${JSON.stringify(doc.client_id)} does not match the URL`);
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) throw new Error("it has no client_name");
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) throw new Error("it has no redirect_uris");
  for (const uri of doc.redirect_uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new Error(problem);
  }
  if ("client_secret" in doc || "client_secret_expires_at" in doc) throw new Error("it must not contain a client secret");
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
    throw new Error(`token_endpoint_auth_method ${JSON.stringify(doc.token_endpoint_auth_method)} is not supported; this server only has public clients ("none")`);
  }
  const maxAge = Number(/max-age=(\d+)/i.exec(cacheControl)?.[1] ?? CACHE_DEFAULT_S);
  return {
    client: { ...(doc as unknown as OAuthClientInformationFull), token_endpoint_auth_method: "none" },
    maxAge: Math.min(CACHE_MAX_S, Math.max(CACHE_MIN_S, maxAge)),
  };
}

// One GET: no redirects, a size cap, a timeout, and a DNS lookup that refuses non-public addresses
// at connect time (no window between checking and connecting).
function getSmall(url: URL): Promise<{ status: number; contentType: string; cacheControl: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers: { accept: "application/json", "user-agent": "mobbin-mcp" }, lookup: publicOnlyLookup, timeout: FETCH_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_DOC_BYTES) {
          req.destroy(new Error(`it is larger than ${MAX_DOC_BYTES} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          cacheControl: String(res.headers["cache-control"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`no answer within ${FETCH_TIMEOUT_MS / 1000} s`)));
    req.on("error", reject);
    req.end();
  });
}

const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const blocked = addresses.find((a) => isNonPublic(a.address));
    if (blocked) return callback(new Error(`${hostname} resolves to non-public address ${blocked.address}`), "", 0);
    if (options.all) return (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

const NON_PUBLIC = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NON_PUBLIC.addSubnet(net, bits, "ipv4");
// No ::ffff:0:0/96 rule: BlockList checks IPv4 addresses against IPv4-mapped IPv6 rules (so it would
// block every IPv4 address), and the IPv4 rules above already match mapped addresses.
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) NON_PUBLIC.addSubnet(net, bits, "ipv6");

function isNonPublic(address: string): boolean {
  const family = isIP(address);
  return family === 0 || NON_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4");
}
