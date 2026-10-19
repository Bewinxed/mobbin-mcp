// The OAuth 2.1 authorization server and protected-resource plumbing for the MCP endpoint, all on
// PUBLIC_URL's origin:
//   /.well-known/oauth-protected-resource[/mcp]  RFC 9728 metadata naming this server as issuer
//   /.well-known/oauth-authorization-server      RFC 8414 metadata (CIMD + RFC 9207 iss advertised)
//   /authorize, /signin/*                        Mobbin sign-in (email → code or password → consent)
//   /token                                       SDK handler: authorization_code + PKCE S256, refresh_token with rotation
//   /register                                    SDK handler: RFC 7591 Dynamic Client Registration
// Tokens are opaque, stored hashed, and bound to the Mobbin user, the client and the resource.
import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Session } from "./api.js";
import { type Clients, isLoopbackRedirect } from "./clients.js";
import type { MobbinLogin } from "./mobbin-login.js";
import { codePage, consentPage, emailPage, errorPage, passwordPage } from "./pages.js";
import type { Users } from "./sessions.js";
import type { Store } from "./store.js";
import { Throttle } from "./throttle.js";

const FLOW_TTL_MS = 15 * 60_000;
const MAX_FLOWS = 10_000;
const MAX_ATTEMPTS = 5;
const BROWSER_COOKIE = "mobbin_mcp_browser";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthServerOptions {
  publicUrl: string; // origin only, no trailing slash; also the issuer identifier
  store: Store;
  clients: Clients;
  users: Users;
  login: MobbinLogin;
}

// ---------- resource identity ----------

export const mcpResource = (publicUrl: string) => `${publicUrl}/mcp`;
export const resourceMetadataUrl = (publicUrl: string) => `${publicUrl}/.well-known/oauth-protected-resource/mcp`;

// RFC 8707 resource comparison: scheme and host case-folded by URL, trailing slash ignored.
function sameResource(given: string, canonical: string): boolean {
  try {
    const u = new URL(given);
    return !u.hash && u.href.replace(/\/$/, "") === canonical.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export function challenge(publicUrl: string, description: string): string {
  return `Bearer error="invalid_token", error_description="${description.replace(/["\\]/g, "'")}", resource_metadata="${resourceMetadataUrl(publicUrl)}"`;
}

// CORS for browser-based MCP clients: metadata, the MCP endpoint and its 401 challenge.
export const cors: RequestHandler = (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID");
  res.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
};

// ---------- token issuing and checking ----------

class Provider implements OAuthServerProvider {
  constructor(
    private o: AuthServerOptions,
    readonly clientsStore: Clients,
  ) {}

  // Authorization is served by authRouter's /authorize and /signin routes, not by the SDK handler.
  async authorize(): Promise<void> {
    throw new Error("authorize is handled by the sign-in routes");
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const grant = this.o.store.peekCode(code);
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError("The authorization code is invalid, expired, or was issued to another client");
    return grant.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const grant = this.o.store.takeCode(code);
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError("The authorization code is invalid, expired, or was issued to another client");
    if (grant.redirectUriExplicit ? redirectUri !== grant.redirectUri : redirectUri !== undefined && redirectUri !== grant.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !sameResource(resource.href, grant.resource)) throw new InvalidTargetError(`resource must be ${grant.resource}`);
    if (!this.o.store.hasSession(grant.userId)) throw new InvalidGrantError("The Mobbin session has ended; sign in again");
    return this.o.store.issueTokens(grant.userId, grant.clientId, grant.resource);
  }

  // Rotation: the presented refresh token is spent and a new pair issued in the same response.
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const grant = this.o.store.getToken(refreshToken, "refresh");
    if (!grant || grant.clientId !== client.client_id) throw new InvalidGrantError("The refresh token is invalid, expired, or was issued to another client");
    if (resource && !sameResource(resource.href, grant.resource)) throw new InvalidTargetError(`resource must be ${grant.resource}`);
    this.o.store.deleteToken(refreshToken);
    if (!this.o.store.hasSession(grant.userId)) throw new InvalidGrantError("The Mobbin session has ended; sign in again");
    return this.o.store.issueTokens(grant.userId, grant.clientId, grant.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = this.o.store.getToken(token, "access");
    if (!grant) throw new InvalidTokenError("The access token is invalid or expired");
    return { token, clientId: grant.clientId, scopes: [], expiresAt: grant.expiresAt, resource: new URL(grant.resource), extra: { userId: grant.userId } };
  }
}

export function bearerAuth(o: AuthServerOptions, provider: OAuthServerProvider): RequestHandler {
  return requireBearerAuth({ verifier: provider, resourceMetadataUrl: resourceMetadataUrl(o.publicUrl), expectedResource: new URL(mcpResource(o.publicUrl)) });
}

// ---------- the sign-in flow ----------

interface Flow {
  id: string;
  browser: string; // the browser cookie that started it; later steps must come from the same browser
  created: number;
  client: OAuthClientInformationFull;
  metadataDocument: boolean;
  redirectUri: string;
  redirectUriExplicit: boolean;
  state: string | undefined;
  codeChallenge: string;
  resource: string;
  step: "email" | "code" | "password" | "consent";
  email?: string;
  attempts: number;
  session?: Session;
}

function sendPage(res: Response, status: number, html: string) {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
    })
    .send(html);
}

const minutes = (s: number) => (s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`);

export function authRouter(o: AuthServerOptions): { router: express.Router; provider: OAuthServerProvider } {
  const issuer = o.publicUrl;
  const resource = mcpResource(o.publicUrl);
  const provider = new Provider(o, o.clients);
  const flows = new Map<string, Flow>();
  // Anyone can make this server send Mobbin emails, so sends are limited per address and per IP.
  const perEmail = new Throttle(3, 15 * 60_000);
  const perIp = new Throttle(10, 60 * 60_000);
  const secureCookie = issuer.startsWith("https://");

  setInterval(() => {
    for (const [id, f] of flows) if (Date.now() - f.created > FLOW_TTL_MS) flows.delete(id);
  }, 60_000).unref();

  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: "16kb" });

  // ----- discovery -----

  const protectedResource = { resource, authorization_servers: [issuer], bearer_methods_supported: ["header"], resource_name: "Mobbin" };
  const authorizationServer = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
  router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], cors, (_req, res) => {
    res.json(protectedResource);
  });
  router.get("/.well-known/oauth-authorization-server", cors, (_req, res) => {
    res.json(authorizationServer);
  });
  router.options(/^\/\.well-known\/.*/, cors);

  // ----- token and registration (SDK handlers) -----

  // Hosted Claude refreshes for all its users from one IP range, so the token endpoint has no
  // per-IP limit; its tokens are 256-bit random values.
  router.use("/token", tokenHandler({ provider, rateLimit: false }));
  router.use("/register", clientRegistrationHandler({ clientsStore: o.clients, rateLimit: { windowMs: 60 * 60_000, limit: 60 } }));

  // ----- authorization -----

  // RFC 9207: every authorization response names the issuer.
  const authResponse = (redirectUri: string, params: Record<string, string | undefined>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set("iss", issuer);
    return u.href;
  };

  const browserId = (req: Request, res: Response): string => {
    const existing = /(?:^|;\s*)mobbin_mcp_browser=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie ?? "")?.[1];
    if (existing) return existing;
    const id = randomBytes(24).toString("base64url");
    res.cookie(BROWSER_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: secureCookie, path: "/", maxAge: FLOW_TTL_MS });
    return id;
  };

  router.all("/authorize", form, async (req, res) => {
    const p = (req.method === "POST" ? req.body : req.query) as Record<string, unknown>;
    const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
    const stop = (message: string) => sendPage(res, 400, errorPage("Can't start sign-in", message));

    // Until client and redirect URI check out, errors go to the user, never to a redirect.
    const clientId = str("client_id");
    if (!clientId) return stop("The app's sign-in request has no client_id.");
    const resolved = await o.clients.resolve(clientId);
    if ("error" in resolved) return stop(resolved.error);
    const { client, metadataDocument } = resolved;
    let redirectUri = str("redirect_uri");
    const redirectUriExplicit = redirectUri !== undefined;
    if (redirectUri !== undefined) {
      const requested = redirectUri;
      if (!client.redirect_uris.some((registered) => redirectUriMatches(requested, registered))) {
        return stop(`The redirect URI ${redirectUri} is not registered for this app.`);
      }
    } else if (client.redirect_uris.length === 1) {
      redirectUri = client.redirect_uris[0];
    } else {
      return stop("The app has several redirect URIs and didn't say which one to use (redirect_uri).");
    }

    const state = str("state");
    const fail = (error: string, description: string) => res.redirect(302, authResponse(redirectUri, { error, error_description: description, state }));
    if (str("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    const codeChallenge = str("code_challenge");
    if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return fail("invalid_request", "code_challenge is required: the S256 PKCE challenge, 43 base64url characters");
    if (str("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
    const requestedResource = str("resource");
    if (requestedResource !== undefined && !sameResource(requestedResource, resource)) return fail("invalid_target", `resource must be ${resource}`);

    if (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value!);
    const flow: Flow = {
      id: randomBytes(24).toString("base64url"),
      browser: browserId(req, res),
      created: Date.now(),
      client,
      metadataDocument,
      redirectUri,
      redirectUriExplicit,
      state,
      codeChallenge,
      resource,
      step: "email",
      attempts: 0,
    };
    flows.set(flow.id, flow);
    sendPage(res, 200, emailPage(flow.id));
  });

  // Each step must come from the browser that started the flow, within its lifetime.
  const step =
    (handler: (flow: Flow, req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response, next: NextFunction) => {
      const flow = flows.get(String(req.body?.flow ?? ""));
      const cookie = /(?:^|;\s*)mobbin_mcp_browser=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (!flow || flow.browser !== cookie || Date.now() - flow.created > FLOW_TTL_MS) {
        sendPage(res, 400, errorPage("This sign-in has expired", "Go back to the app and connect to Mobbin again."));
        return;
      }
      try {
        await handler(flow, req, res);
      } catch (e) {
        next(e);
      }
    };

  router.post(
    "/signin/email",
    form,
    step(async (flow, req, res) => {
      const email = String(req.body.email ?? "").trim().toLowerCase();
      const resend = flow.step === "code" && flow.email === email;
      const again = (error: string, status = 200) =>
        sendPage(res, status, resend ? codePage(flow.id, email, { error }) : emailPage(flow.id, { error, email }));
      if (email.length > 254 || !EMAIL.test(email)) return again("Enter a valid email address.");
      const wait = perIp.take(req.ip ?? "unknown") || perEmail.take(email);
      if (wait) return again(`Too many sign-in emails requested. Try again in ${minutes(wait)}.`, 429);
      let start;
      try {
        start = await o.login.startEmail(email);
      } catch (e) {
        return again(`Couldn't reach Mobbin: ${(e as Error).message}`, 502);
      }
      switch (start.kind) {
        case "code":
          Object.assign(flow, { step: "code", email, attempts: 0 });
          return sendPage(res, 200, codePage(flow.id, email, resend ? { notice: "Mobbin sent a new code." } : {}));
        case "password":
          Object.assign(flow, { step: "password", email, attempts: 0 });
          return sendPage(res, 200, passwordPage(flow.id, email));
        case "sso":
          return again("This Mobbin account signs in through its company's single sign-on (SSO). This server can only sign in accounts that use an emailed code or a password.");
        case "error":
          return again(`Mobbin: ${start.message}`);
      }
    }),
  );

  router.post(
    "/signin/restart",
    form,
    step((flow, _req, res) => {
      Object.assign(flow, { step: "email", email: undefined, attempts: 0, session: undefined });
      sendPage(res, 200, emailPage(flow.id));
    }),
  );

  const verified = (flow: Flow, session: Session, res: Response) => {
    flow.session = session;
    flow.step = "consent";
    const redirect = new URL(flow.redirectUri);
    sendPage(
      res,
      200,
      consentPage(flow.id, {
        app: flow.metadataDocument ? new URL(flow.client.client_id).host : flow.client.client_name || "An unnamed app",
        appNote: flow.metadataDocument
          ? flow.client.client_name
            ? `(calls itself “${flow.client.client_name}”)`
            : ""
          : "(name given by the app, not verified)",
        redirectHost: redirect.host,
        loopbackOnly: isLoopbackRedirect(flow.redirectUri),
        email: session.user.email ?? flow.email ?? "",
      }),
    );
  };

  router.post(
    "/signin/code",
    form,
    step(async (flow, req, res) => {
      if (flow.step !== "code" || !flow.email) return sendPage(res, 400, emailPage(flow.id, { error: "Start with your email." }));
      const email = flow.email;
      const code = String(req.body.code ?? "").replace(/\s/g, "");
      if (!/^\d{6}$/.test(code)) return sendPage(res, 200, codePage(flow.id, email, { error: "Enter the 6 digits from the email." }));
      if (++flow.attempts > MAX_ATTEMPTS) return sendPage(res, 429, codePage(flow.id, email, { error: "Too many wrong codes. Send a new code." }));
      let result;
      try {
        result = await o.login.verifyCode(email, code);
      } catch (e) {
        return sendPage(res, 502, codePage(flow.id, email, { error: `Couldn't reach Mobbin: ${(e as Error).message}` }));
      }
      if (!result.ok) return sendPage(res, 200, codePage(flow.id, email, { error: `Mobbin: ${result.message}` }));
      verified(flow, result.session, res);
    }),
  );

  router.post(
    "/signin/password",
    form,
    step(async (flow, req, res) => {
      if (flow.step !== "password" || !flow.email) return sendPage(res, 400, emailPage(flow.id, { error: "Start with your email." }));
      const email = flow.email;
      const password = String(req.body.password ?? "");
      if (!password) return sendPage(res, 200, passwordPage(flow.id, email, "Enter your password."));
      if (++flow.attempts > MAX_ATTEMPTS) return sendPage(res, 429, passwordPage(flow.id, email, "Too many wrong passwords. Start again from the app."));
      let result;
      try {
        result = await o.login.verifyPassword(email, password);
      } catch (e) {
        return sendPage(res, 502, passwordPage(flow.id, email, `Couldn't reach Mobbin: ${(e as Error).message}`));
      }
      if (!result.ok) return sendPage(res, 200, passwordPage(flow.id, email, `Mobbin: ${result.message}`));
      verified(flow, result.session, res);
    }),
  );

  router.post(
    "/signin/consent",
    form,
    step(async (flow, req, res) => {
      const session = flow.session;
      if (flow.step !== "consent" || !session?.user?.id) return sendPage(res, 400, emailPage(flow.id, { error: "Start with your email." }));
      flows.delete(flow.id);
      if (req.body.decision !== "allow") {
        return res.redirect(303, authResponse(flow.redirectUri, { error: "access_denied", error_description: "The user declined", state: flow.state }));
      }
      await o.users.signIn(session);
      const code = o.store.issueCode({
        clientId: flow.client.client_id,
        userId: session.user.id,
        redirectUri: flow.redirectUri,
        redirectUriExplicit: flow.redirectUriExplicit,
        codeChallenge: flow.codeChallenge,
        resource: flow.resource,
      });
      res.redirect(303, authResponse(flow.redirectUri, { code, state: flow.state }));
    }),
  );

  return { router, provider };
}
