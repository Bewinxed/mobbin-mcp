# mobbin-mcp

An MCP server that lets Claude, Cursor, Codex and other agents search [Mobbin](https://mobbin.com) for UI references. Results come back as short text lists, not a wall of screenshots, and the agent loads images only for the screens it picks.

> [!IMPORTANT]
> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Mobbin.
>
> - You need your own Mobbin account. Full content needs a paid Mobbin plan.
> - It talks to Mobbin's web endpoints, the same ones mobbin.com uses. They can change or break at any time without notice.
> - AI search spends your Mobbin AI credits.
> - Use it in line with [Mobbin's terms](https://mobbin.com/terms).
> - Your Mobbin session stays on your machine, encrypted. Nothing is sent anywhere except Mobbin.

## What you get

The tools form a path the agent walks, and each step returns the ids the next step needs:

1. **Find apps** by description ("AI app builder") or category, on iOS, Android or web.
2. **Open an app** to see its full catalogue of flows, ranked against a query. This step costs no AI credits.
3. **Open a flow** to see its ordered steps: each screen, its tags, and where the user tapped.
4. **Get images** only for the screens the agent chose.

It can also search screens and flows across apps, using Mobbin's AI search or its free plain ranking. Results are spread across apps, so less-mainstream apps aren't buried. There are also tools for Mobbin's website library (sites and page sections) and for looking up Mobbin's exact tag names.

## Quick start

You need [Node.js](https://nodejs.org) 22.13 or newer and a Mobbin account.

```sh
npx -y github:Bewinxed/mobbin-mcp
```

The server starts on `http://127.0.0.1:8790` and prints the MCP URL. It needs no configuration. On first run it creates a data folder and an encryption key (see [Configuration](#configuration)). Leave it running, then add `http://127.0.0.1:8790/mcp` to your agent.

### Claude Code

```sh
claude mcp add --transport http mobbin http://127.0.0.1:8790/mcp
```

Then run `/mcp` in Claude Code, pick `mobbin`, and sign in in the browser window it opens. You can also sign in from the shell with `claude mcp login mobbin`.

### Cursor

Add the server to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "mobbin": { "url": "http://127.0.0.1:8790/mcp" }
  }
}
```

Cursor shows a sign-in prompt for the server in its MCP settings.

### VS Code (GitHub Copilot)

Run **MCP: Add Server** from the Command Palette, choose **HTTP**, and enter `http://127.0.0.1:8790/mcp`. To edit the config by hand, run **MCP: Open User Configuration**, or create `.vscode/mcp.json` in a workspace:

```json
{
  "servers": {
    "mobbin": { "type": "http", "url": "http://127.0.0.1:8790/mcp" }
  }
}
```

The root key in VS Code's own files is `servers`, not `mcpServers`. VS Code opens the browser for sign-in the first time it connects.

### Windsurf

Open the raw `mcp_config.json` from Cascade's MCP menu (**Open MCP config file**) and add:

```json
{
  "mcpServers": {
    "mobbin": { "serverUrl": "http://127.0.0.1:8790/mcp" }
  }
}
```

Then press refresh in the MCP panel and sign in when prompted.

### Codex CLI

```sh
codex mcp add mobbin --url http://127.0.0.1:8790/mcp
codex mcp login mobbin
```

### Other clients

Any client that supports remote MCP servers over Streamable HTTP with OAuth can connect: give it the URL `http://127.0.0.1:8790/mcp` and no headers. The server supports Client ID Metadata Documents, Dynamic Client Registration, and loopback redirects on any port.

### Claude Desktop and claude.ai

Custom connectors in Claude Desktop, claude.ai and the Claude mobile apps connect from Anthropic's cloud, not from your computer. They can't reach `127.0.0.1`. To use them, host the server at a public `https` URL (see [Hosting](#hosting)), then go to Settings → Connectors → **Add custom connector** with `https://<your-host>/mcp`. Leave the OAuth client ID and secret empty.

## Signing in

When your agent connects for the first time, it opens a browser page served by your own mobbin-mcp:

1. Enter the email of your Mobbin account.
2. Mobbin emails you a 6-digit code. Enter it. If your account has a password, the page asks for that instead.
3. A consent screen shows which app is asking and where its access goes. Approve it.

The page signs in the same way mobbin.com/login does. Accounts that use company SSO can't sign in this way, and the page tells you so. Several people can share one server, and each signs in with their own Mobbin account.

Your agent stays signed in. When Mobbin ends the session, the agent is asked to sign in again.

## Tools

| Tool | What it does | AI credits |
|---|---|---|
| `mobbin_find_apps` | Apps by free-text query or category, on `ios`, `android` or `web`. **Start here.** | No |
| `mobbin_open_app` | One app's full flow catalogue, ranked against an optional query. | No |
| `mobbin_open_flow` | A flow's ordered steps: screens, tags, and where the user tapped. | No |
| `mobbin_get_screen_images` | Screenshots for up to 8 chosen screens or website sections, at 360, 720 or 1920 px wide. | No |
| `mobbin_search_screens` | Screens across apps, by query (`mode` `ai` or `fast`) or by tag filters. | `ai` mode |
| `mobbin_search_flows` | Flows across apps, by query or by action and category tags. | `ai` mode |
| `mobbin_find_sites` | Websites in Mobbin's web library. | No |
| `mobbin_search_sections` | Website sections (hero, pricing, footer…) by query or pattern. | No |
| `mobbin_lookup_tags` | Maps an intent to Mobbin's exact tag names, with definitions and counts. | No |

AI search (`mode: "ai"`, the default for a free-text query in the cross-app searches) runs Mobbin's AI search. One batch costs about $0.016 of your Mobbin AI credits and takes about 10 seconds. Later pages of the same query come from a cache when they can. `mode: "fast"` and tag filters are free and instant, but less precise.

Cross-app searches put apps outside Mobbin's most popular ones first (`prefer: "distinctive"`, the default) and show at most a couple of results per app on each page. Use `prefer: "popular"` to keep Mobbin's own order, and `exclude_apps` to skip apps.

## Hosting

The server only needs hosting if you want to use it from claude.ai or Claude Desktop, or share it with a team.

- Run it behind a reverse proxy that terminates HTTPS and passes every path through, including `/.well-known/*`.
- Set `PUBLIC_URL` to the public origin, for example `https://mobbin.example.com`. The MCP URL is then `https://mobbin.example.com/mcp`.
- Keep `HOST=127.0.0.1` (the default) when the proxy runs on the same machine. Otherwise set `HOST=0.0.0.0`.
- Set `TRUST_PROXY=1` (or the number of proxy hops) so the per-IP limits on sign-in emails see real client addresses.
- Persist `DATA_DIR`. It holds the database and, unless you set `ENCRYPTION_KEY`, the encryption key.

```sh
PUBLIC_URL=https://mobbin.example.com \
DATA_DIR=/var/lib/mobbin-mcp \
ENCRYPTION_KEY="<output of: openssl rand -base64 32, generated once and kept>" \
HOST=127.0.0.1 \
PORT=3000 \
TRUST_PROXY=1 \
npx -y github:Bewinxed/mobbin-mcp
```

To run from a clone instead: `npm install` (it builds automatically), then `npm start`.

Anyone who can reach the server can make it send Mobbin sign-in emails. So sends are limited to 3 per email address per 15 minutes and 10 per IP per hour, and each sign-in allows 5 wrong codes before it asks for a new one.

## Configuration

Every setting is optional.

| Variable | Default | |
|---|---|---|
| `PORT` | `8790` | Port to listen on. |
| `HOST` | `127.0.0.1` | Address to listen on. `0.0.0.0` (or `::`) accepts connections on every interface. |
| `PUBLIC_URL` | `http://127.0.0.1:<PORT>` | The origin clients reach, with no path. It must be `https`; `http` is accepted only for `localhost`/`127.0.0.1`. |
| `DATA_DIR` | see below | Where the database, cache and generated key live. Keep it private. |
| `ENCRYPTION_KEY` | generated | 32 random bytes, base64 (`openssl rand -base64 32`). When unset, the server creates `DATA_DIR/encryption.key` (mode 600) on first run and reuses it. Changing or losing the key makes stored sessions unreadable, so everyone signs in again. |
| `TRUST_PROXY` | not trusted | Behind a reverse proxy: the number of hops to trust for the client IP (e.g. `1`), or an Express `trust proxy` value. |
| `MOBBIN_AUTH_MODE` | `cookie` | `cookie` sends Mobbin's Supabase auth cookies. `bearer` sends `Authorization: Bearer <access_token>` instead. |
| `MOBBIN_SUPABASE_URL` | Mobbin's | Mobbin's Supabase project URL. |
| `MOBBIN_SUPABASE_KEY` | Mobbin's | Mobbin's public publishable key, the one its website ships to every browser. |

The default `DATA_DIR` is `$XDG_DATA_HOME/mobbin-mcp` when `XDG_DATA_HOME` is set. Otherwise it is:

- Linux: `~/.local/share/mobbin-mcp`
- macOS: `~/Library/Application Support/mobbin-mcp`
- Windows: `%APPDATA%\mobbin-mcp`

## Privacy and security

- **Where data lives.** Everything is in `DATA_DIR/mobbin-mcp.db` (SQLite). The server contacts only Mobbin (mobbin.com and its Supabase project). The one exception is that it fetches an MCP client's own metadata document when that client signs in with one.
- **Your Mobbin session** is stored under your Mobbin user id, encrypted with AES-256-GCM. The key is `ENCRYPTION_KEY` or `DATA_DIR/encryption.key`. Your password and sign-in codes go to Mobbin and are never saved to disk.
- **Tokens the server gives your agent** are random values. The database holds only their SHA-256 hashes. Access tokens last 1 hour and refresh tokens 30 days, rotating on every use. Each token is bound to one user, one client and this server.
- **Sign-out.** When Mobbin rejects your session, the server deletes it along with every token issued to you.
- **Exposure.** By default the server listens on `127.0.0.1` only. Expose it beyond your machine only over HTTPS, as described in [Hosting](#hosting).

## How it works

One Node process serves everything on `PUBLIC_URL`:

| Path | What |
|---|---|
| `/mcp` | The MCP endpoint, [Streamable HTTP](https://modelcontextprotocol.io/specification/latest/basic/transports/streamable-http), stateless (`POST` only, JSON responses). Without a valid bearer token it answers `401` with a `WWW-Authenticate` challenge pointing at the resource metadata. |
| `/.well-known/oauth-protected-resource[/mcp]` | [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) protected-resource metadata. |
| `/.well-known/oauth-authorization-server` | [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) metadata: PKCE `S256`, public clients, Client ID Metadata Documents, `iss` in responses ([RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207)). |
| `/authorize`, `/token`, `/register` | OAuth 2.1 authorization code with PKCE, rotating refresh tokens, and [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) Dynamic Client Registration. |
| `/signin/*` | The Mobbin sign-in and consent pages. |

Redirect URIs must be `https`, or `http` on `localhost`/`127.0.0.1`. Loopback redirects match on any port ([RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3)).

The sign-in pages call Mobbin's own login endpoints. Mobbin's server action ids change with each Mobbin deploy, so the server reads them from `https://mobbin.com/login` when it first needs them, and reads them again if Mobbin says an id no longer exists.

## License

[MIT](LICENSE). Mobbin is a trademark of its owner. This project uses the name only to say what it works with.
