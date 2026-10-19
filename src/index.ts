#!/usr/bin/env node
// Remote MCP server for Mobbin: Streamable HTTP at /mcp behind OAuth, where every user signs in with
// their own Mobbin account and their tool calls run on their own Mobbin session.
//
// Zero config runs locally on http://127.0.0.1:8790. Hosted:
//   PUBLIC_URL=https://mobbin.example.com DATA_DIR=/var/lib/mobbin-mcp ENCRYPTION_KEY=… HOST=127.0.0.1 PORT=3000 node dist/index.js
import { homedir } from "node:os";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig } from "./api.js";
import { Clients } from "./clients.js";
import { MobbinLogin } from "./mobbin-login.js";
import { authRouter, bearerAuth, challenge, cors, mcpResource } from "./oauth.js";
import { Users } from "./sessions.js";
import { encryptionKey, Store } from "./store.js";
import { registerTools } from "./tools.js";

const VERSION = "0.2.0";

interface ServerConfig {
  publicUrl: string;
  host: string;
  port: number;
  dataDir: string;
  encryptionKey: Buffer;
  keySource: string;
  keyCreated: boolean;
  trustProxy: boolean | number | string;
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "mobbin-mcp");
  if (process.platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "mobbin-mcp");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "mobbin-mcp");
  return join(homedir(), ".local", "share", "mobbin-mcp");
}

function serverConfig(env = process.env): ServerConfig {
  const port = Number(env.PORT || 8790);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT must be a TCP port number: ${env.PORT}`);
  const publicUrl = env.PUBLIC_URL || `http://127.0.0.1:${port}`;
  const url = new URL(publicUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`PUBLIC_URL must be https (http is accepted only for localhost): ${publicUrl}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`PUBLIC_URL must be an origin without a path, e.g. https://mobbin.example.com: ${publicUrl}`);
  const host = env.HOST?.trim() || "127.0.0.1";
  const dataDir = env.DATA_DIR || defaultDataDir(env);
  const key = encryptionKey(dataDir, env.ENCRYPTION_KEY);
  const tp = env.TRUST_PROXY;
  return {
    publicUrl: url.origin,
    host,
    port,
    dataDir,
    encryptionKey: key.key,
    keySource: key.source,
    keyCreated: key.created,
    // Behind a reverse proxy, how many hops (or which addresses) to trust for the client IP.
    trustProxy: tp === undefined ? false : tp === "true" ? true : /^\d+$/.test(tp) ? Number(tp) : tp,
  };
}

function main() {
  const sc = serverConfig();
  const cfg = loadConfig(sc.dataDir);
  const store = new Store(sc.dataDir, sc.encryptionKey);
  const users = new Users(store, cfg);
  const clients = new Clients(store);
  const auth = { publicUrl: sc.publicUrl, store, clients, users, login: new MobbinLogin(cfg) };
  const { router, provider } = authRouter(auth);
  setInterval(() => store.pruneExpired(), 60 * 60_000).unref();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", sc.trustProxy);
  app.use(router);

  // Stateless Streamable HTTP: each POST gets a fresh McpServer bound to the caller's tool state.
  // The web-standard transport hands back the finished response, so a Mobbin session that died
  // during this request can still turn it into a 401 that sends the client through sign-in.
  app.options("/mcp", cors);
  app.all("/mcp", cors, bearerAuth(auth, provider), express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST." }, id: null });
      return;
    }
    const authInfo = req.auth!;
    const ctx = users.context(String(authInfo.extra?.userId));
    const server = new McpServer({ name: "mobbin", version: VERSION });
    registerTools(server, ctx.tools);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const headers = new Headers();
      for (const name of ["accept", "content-type", "mcp-protocol-version"]) {
        const v = req.headers[name];
        if (typeof v === "string") headers.set(name, v);
      }
      const response = await transport.handleRequest(new Request(mcpResource(sc.publicUrl), { method: "POST", headers }), { parsedBody: req.body, authInfo });
      if (ctx.dead) {
        res
          .status(401)
          .set("WWW-Authenticate", challenge(sc.publicUrl, ctx.dead))
          .json({ error: "invalid_token", error_description: ctx.dead });
        return;
      }
      res.status(response.status);
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    } finally {
      await server.close();
    }
  });

  app.use((err: Error & { status?: number; type?: string }, req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.parse.failed") {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON" }, id: null });
      return;
    }
    console.error(`${req.method} ${req.path}:`, err);
    if (!res.headersSent) res.status(err.status ?? 500).json({ error: "server_error", error_description: "Internal server error" });
  });

  const listener = app.listen(sc.port, sc.host, () => {
    const mcpUrl = mcpResource(sc.publicUrl);
    console.log(
      [
        `mobbin-mcp ${VERSION} listening on ${sc.host}:${sc.port}`,
        `  Data:            ${sc.dataDir}`,
        `  Encryption key:  ${sc.keySource}${sc.keyCreated ? " (created)" : ""}`,
        `  MCP URL:         ${mcpUrl}`,
        "",
        "Add it to Claude Code, then run /mcp in Claude Code to sign in with your Mobbin account:",
        `  claude mcp add --transport http mobbin ${mcpUrl}`,
      ].join("\n"),
    );
  });
  listener.on("error", (e) => {
    console.error(`Can't listen on ${sc.host}:${sc.port}: ${e.message}`);
    process.exit(1);
  });
}

try {
  main();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
