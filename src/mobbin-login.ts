// Signs a user in to Mobbin the way mobbin.com/login does: submit the email, then verify the emailed
// 6-digit code (or the account password) through Mobbin's Next.js server actions. The session comes
// back in Mobbin's Supabase auth cookies.
//
// Server action ids change with every Mobbin deploy, so they are read from the login page's scripts
// at runtime, cached, and re-read once when Mobbin says an id no longer exists.
import { BROWSER_UA, type Config, MOBBIN_ORIGIN, type Session, sessionFromSetCookie } from "./api.js";

export type EmailStart =
  | { kind: "code" } // Mobbin emailed a 6-digit code (also how Google-sign-in accounts log in)
  | { kind: "password" } // the account has a password
  | { kind: "sso" } // the account signs in through its company's SSO
  | { kind: "error"; message: string };

export type Verified = { ok: true; session: Session } | { ok: false; message: string };

type ActionName = "actionLoginByToken" | "actionLoginByPassword";
const ACTIONS: ActionName[] = ["actionLoginByToken", "actionLoginByPassword"];
const ACTION_REF = /createServerReference\)\("([0-9a-f]{20,})",[^)]*?"(actionLoginBy(?:Token|Password))"\)/g;
const TIMEOUT_MS = 15_000;

const pageHeaders = { origin: MOBBIN_ORIGIN, referer: `${MOBBIN_ORIGIN}/login`, "user-agent": BROWSER_UA };

export class MobbinLogin {
  private actionIds: Promise<Record<ActionName, string>> | null = null;

  constructor(private cfg: Config) {}

  async startEmail(email: string): Promise<EmailStart> {
    const res = await fetch(`${MOBBIN_ORIGIN}/api/auth/login-by-email-only`, {
      method: "POST",
      headers: { ...pageHeaders, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, redirectTo: "/", isForgotPassword: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: { value?: { type?: string }; error?: { message?: string } } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* reported below */
    }
    if (json?.error?.message) return { kind: "error", message: json.error.message };
    switch (json?.value?.type) {
      case "magiclink":
        return { kind: "code" };
      case "password":
        return { kind: "password" };
      case "redirect":
        return { kind: "sso" };
    }
    return { kind: "error", message: `Mobbin answered HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  verifyCode(email: string, token: string): Promise<Verified> {
    return this.signIn("actionLoginByToken", { email, token });
  }

  verifyPassword(email: string, password: string): Promise<Verified> {
    return this.signIn("actionLoginByPassword", { email, password });
  }

  private async signIn(action: ActionName, payload: Record<string, string>): Promise<Verified> {
    const res = await this.callAction(action, payload);
    const text = await res.text();
    const session = sessionFromSetCookie(this.cfg.projectRef, res.headers.getSetCookie());
    if (res.ok && session) return { ok: true, session };
    return { ok: false, message: actionMessage(text) ?? `Mobbin answered HTTP ${res.status} without a session.` };
  }

  private async callAction(action: ActionName, payload: Record<string, string>, retried = false): Promise<Response> {
    this.actionIds ??= resolveActionIds().catch((e) => {
      this.actionIds = null;
      throw e;
    });
    const id = (await this.actionIds)[action];
    const res = await fetch(`${MOBBIN_ORIGIN}/login`, {
      method: "POST",
      headers: { ...pageHeaders, "next-action": id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
      body: JSON.stringify([payload]),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.headers.get("x-nextjs-action-not-found") !== "1") return res;
    // Mobbin deployed since the ids were read.
    if (retried) throw new Error(`Mobbin no longer accepts its own ${action} id ${id}, even freshly read from ${MOBBIN_ORIGIN}/login.`);
    this.actionIds = null;
    return this.callAction(action, payload, true);
  }
}

// The login page's scripts carry `createServerReference)("<id>", …, "actionLoginByToken")`.
async function resolveActionIds(): Promise<Record<ActionName, string>> {
  const page = await fetch(`${MOBBIN_ORIGIN}/login`, { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!page.ok) throw new Error(`Could not load ${MOBBIN_ORIGIN}/login to find its sign-in actions: HTTP ${page.status}`);
  const html = await page.text();
  const scripts = [...new Set(html.match(/\/_next\/static\/[^"'\s]+?\.js/g) ?? [])];
  const found: Partial<Record<ActionName, string>> = {};
  for (let i = 0; i < scripts.length && ACTIONS.some((a) => !found[a]); i += 8) {
    const bodies = await Promise.all(
      scripts.slice(i, i + 8).map((src) =>
        fetch(`${MOBBIN_ORIGIN}${src}`, { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => (r.ok ? r.text() : "")),
      ),
    );
    for (const body of bodies) for (const m of body.matchAll(ACTION_REF)) found[m[2] as ActionName] = m[1];
  }
  const missing = ACTIONS.filter((a) => !found[a]);
  if (missing.length) throw new Error(`Could not find Mobbin's ${missing.join(" and ")} in the ${scripts.length} scripts of ${MOBBIN_ORIGIN}/login.`);
  return found as Record<ActionName, string>;
}

// A failed action answers with React Server Component lines such as
// 1:{"value":{"state":"failure","message":"Token has expired or is invalid"}}
function actionMessage(rsc: string): string | null {
  for (const line of rsc.split("\n")) {
    const json = /^[0-9a-f]+:(\{.*\})$/.exec(line.trim())?.[1];
    if (!json) continue;
    try {
      const v = JSON.parse(json) as { value?: { message?: unknown }; error?: { message?: unknown } };
      const message = v.value?.message ?? v.error?.message;
      if (typeof message === "string") return message;
    } catch {
      /* not a JSON row */
    }
  }
  return null;
}
