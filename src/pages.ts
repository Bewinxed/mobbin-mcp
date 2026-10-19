// HTML for the sign-in flow: email → code (or password) → consent, plus error pages.
// Every dynamic value goes through esc().

const STYLE = `
@layer base, components;
@layer base {
  :root {
    color-scheme: light dark;
    --bg: light-dark(oklch(98.5% 0.003 260deg), oklch(17% 0.005 260deg));
    --panel: light-dark(oklch(100% 0 0deg), oklch(22% 0.006 260deg));
    --text: light-dark(oklch(22% 0.01 260deg), oklch(94% 0.005 260deg));
    --muted: oklch(from var(--text) l c h / 0.68);
    --line: oklch(from var(--text) l c h / 0.16);
    --accent: light-dark(oklch(48% 0.2 265deg), oklch(72% 0.15 265deg));
    --on-accent: light-dark(oklch(99% 0 0deg), oklch(18% 0.02 265deg));
    --danger: light-dark(oklch(48% 0.19 25deg), oklch(74% 0.14 25deg));
    --warn-bg: light-dark(oklch(95% 0.05 85deg), oklch(30% 0.05 85deg));
    --step: clamp(1rem, 0.96rem + 0.2vi, 1.0625rem);
    --title: clamp(1.375rem, 1.25rem + 0.6vi, 1.625rem);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: var(--step);
    line-height: 1.5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-block-size: 100dvb;
    display: grid;
    place-items: center;
    padding: 1.25rem;
    background: var(--bg);
    color: var(--text);
  }
  h1 { font-size: var(--title); line-height: 1.2; margin: 0 0 0.5rem; text-wrap: balance; }
  p { margin: 0 0 1rem; text-wrap: pretty; }
  strong, code { overflow-wrap: anywhere; }
}
@layer components {
  main {
    inline-size: min(100%, 26rem);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: clamp(1.25rem, 1rem + 2vi, 2rem);
  }
  .brand { color: var(--muted); font-size: 0.875rem; margin-block-end: 1.25rem; }
  .muted { color: var(--muted); font-size: 0.9375rem; }
  label { display: block; font-weight: 600; margin-block-end: 0.375rem; }
  input[type="email"], input[type="password"], input[type="text"] {
    display: block;
    inline-size: 100%;
    font: inherit;
    font-size: max(1rem, 16px);
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    margin-block-end: 1rem;
    &:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  }
  input.code { letter-spacing: 0.3em; font-variant-numeric: tabular-nums; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  button {
    font: inherit;
    font-weight: 600;
    min-inline-size: 6rem;
    padding: 0.625rem 1rem;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    &.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); flex: 1 1 auto; }
    &.link { border: 0; padding: 0; min-inline-size: 0; font-weight: 400; color: var(--accent); text-decoration: underline; }
    &:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  }
  .error { color: var(--danger); font-weight: 600; }
  .sent { color: var(--accent); font-weight: 600; }
  .notice { background: var(--warn-bg); border-radius: 8px; padding: 0.75rem; font-size: 0.9375rem; }
  .who { border: 1px solid var(--line); border-radius: 10px; padding: 0.75rem; margin-block-end: 1rem; }
  .who p { margin: 0; }
  .who p:not(:first-child) { margin-block-start: 0.375rem; }
  ul { padding-inline-start: 1.25rem; margin: 0 0 1rem; }
  form.inline { display: inline; }
  .more { margin-block-start: 1rem; }
}`;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · Mobbin for Claude</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="brand">Mobbin MCP</div>
${body}
</main>
</body>
</html>`;
}

const errorLine = (error?: string) => (error ? `<p class="error" role="alert">${esc(error)}</p>` : "");
const hidden = (flow: string) => `<input type="hidden" name="flow" value="${esc(flow)}">`;

export function emailPage(flow: string, opts: { error?: string; email?: string } = {}): string {
  return layout(
    "Sign in",
    `<h1>Sign in with your Mobbin account</h1>
<p class="muted">Mobbin will email you a 6-digit code. Accounts that sign in to Mobbin with Google work too.</p>
${errorLine(opts.error)}
<form method="post" action="/signin/email">
${hidden(flow)}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus value="${esc(opts.email ?? "")}">
<div class="actions"><button class="primary" type="submit">Continue</button></div>
</form>`,
  );
}

export function codePage(flow: string, email: string, msg: { error?: string; notice?: string } = {}): string {
  return layout(
    "Enter your code",
    `<h1>Check your email</h1>
<p>Mobbin sent a 6-digit code to <strong>${esc(email)}</strong>.</p>
${msg.notice ? `<p class="sent" role="status">${esc(msg.notice)}</p>` : ""}
${errorLine(msg.error)}
<form method="post" action="/signin/code">
${hidden(flow)}
<label for="code">Code</label>
<input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
<div class="actions"><button class="primary" type="submit">Verify</button></div>
</form>
<div class="muted more">
<form class="inline" method="post" action="/signin/email">${hidden(flow)}<input type="hidden" name="email" value="${esc(email)}"><button class="link" type="submit">Send a new code</button></form>
·
<form class="inline" method="post" action="/signin/restart">${hidden(flow)}<button class="link" type="submit">Use a different email</button></form>
</div>`,
  );
}

export function passwordPage(flow: string, email: string, error?: string): string {
  return layout(
    "Enter your password",
    `<h1>Enter your Mobbin password</h1>
<p><strong>${esc(email)}</strong> signs in to Mobbin with a password.</p>
${errorLine(error)}
<form method="post" action="/signin/password">
${hidden(flow)}
<input type="hidden" name="username" autocomplete="username" value="${esc(email)}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<div class="actions"><button class="primary" type="submit">Sign in</button></div>
</form>
<div class="muted more">
<form class="inline" method="post" action="/signin/restart">${hidden(flow)}<button class="link" type="submit">Use a different email</button></form>
</div>`,
  );
}

export interface ConsentView {
  app: string; // who is asking: the client_id URL's host for metadata-document clients, else the self-declared name
  appNote: string;
  redirectHost: string;
  loopbackOnly: boolean;
  email: string;
}

export function consentPage(flow: string, v: ConsentView): string {
  const warning = v.loopbackOnly
    ? `<p class="notice">This sends access to a program on <strong>this computer</strong>. Continue only if you just started the connection yourself, for example from Claude Code.</p>`
    : "";
  return layout(
    "Allow access",
    `<h1>Allow access to your Mobbin account?</h1>
<div class="who">
<p><strong>${esc(v.app)}</strong> <span class="muted">${esc(v.appNote)}</span></p>
<p class="muted">Access goes to <strong>${esc(v.redirectHost)}</strong></p>
<p class="muted">Signed in to Mobbin as <strong>${esc(v.email)}</strong></p>
</div>
<p>It will be able to, as you:</p>
<ul>
<li>search Mobbin screens and flows, and load their screenshots</li>
<li>run Mobbin AI searches, which use your Mobbin AI credits</li>
</ul>
${warning}
<form method="post" action="/signin/consent">
${hidden(flow)}
<div class="actions">
<button class="primary" type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Cancel</button>
</div>
</form>`,
  );
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}
