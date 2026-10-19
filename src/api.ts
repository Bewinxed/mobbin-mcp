// Mobbin web API client for one user: that user's Supabase session (held by a SessionHandle),
// @supabase/ssr cookie construction, typed requests for search, flows, tags, apps, images.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------- config ----------

export interface Config {
  supabaseUrl: string;
  supabaseKey: string;
  projectRef: string;
  cacheDir: string; // shared, user-independent data: tag catalogue and app lists
  authMode: "cookie" | "bearer";
}

export const MOBBIN_ORIGIN = "https://mobbin.com";
export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export function loadConfig(dataDir: string, env = process.env): Config {
  const supabaseUrl = (env.MOBBIN_SUPABASE_URL ?? "https://ujasntkfphywizsdaapi.supabase.co").replace(/\/$/, "");
  return {
    supabaseUrl,
    // Public client-side key, shipped in Mobbin's bundle as NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
    supabaseKey: env.MOBBIN_SUPABASE_KEY ?? "sb_publishable_YptnKskI90SD2g25sAvVxQ_tZltjYFE",
    projectRef: new URL(supabaseUrl).hostname.split(".")[0],
    cacheDir: join(dataDir, "cache"),
    authMode: env.MOBBIN_AUTH_MODE === "bearer" ? "bearer" : "cookie",
  };
}

// ---------- types ----------

export type Platform = "ios" | "android" | "web";
// Mobbin's sort options per content type (its bundle: apps publishedAt/popularity/rating,
// screens and flows trending/popularity, sites publishedAt/popularity, sections popularity/trending).
export type SortBy = "trending" | "popularity" | "publishedAt" | "rating";

export interface ImgSources {
  src: string;
  srcSet: { url: string; descriptor: string }[];
}

export interface Screen {
  id: string;
  appId: string;
  appName: string;
  platform: Platform;
  width: number;
  height: number;
  screenPatterns: string[];
  screenElements: string[];
  screenCdnImgSources: ImgSources | null;
  screenUrl: string;
  restricted?: boolean;
  textInScreenshotSearchBoundingBoxes?: { text: string }[];
}

export interface FlowScreen {
  order: number;
  hotspotType: string | null;
  hotspotX: number | null;
  hotspotY: number | null;
  hotspotWidth: number | null;
  hotspotHeight: number | null;
  screenId: string;
  width: number;
  height: number;
  screenCdnImgSources: ImgSources | null;
}

export interface Flow {
  id: string;
  name: string;
  actions: string[];
  appId: string;
  appName: string;
  platform: Platform;
  screens: FlowScreen[];
}

export interface SearchPage<T> {
  searchRequestId: string;
  data: T[];
  hasNextPage: boolean;
  totalCount: number;
}

export interface Tag {
  id: string;
  displayName: string;
  definition: string;
  synonyms: string[];
  subCategory: string;
  categorySlug: string;
  // App tags count per platform ({"screens": {"ios": 4547, "android": 1860}}); website tags count once ({"sections": 250}).
  contentCounts: Record<string, number | Record<string, number>>;
}

export interface TagGroup {
  displayName: string;
  tags: Tag[];
}

export type Catalog = Record<"mobile" | "web" | "sites", Record<string, TagGroup[]>>;

export interface AppEntry {
  id: string;
  appName: string;
  platform: Platform;
  appTagline?: string;
}

// One app's whole catalogue on Mobbin, read from its app page: every flow and every screen's tags.
export interface AppScreen {
  id: string;
  screenPatterns: string[];
  screenElements: string[];
  width: number;
  height: number;
  text: string; // words visible in the screenshot (Mobbin's OCR), space-joined
  screenCdnImgSources: ImgSources | null;
  restricted: boolean;
}

export interface AppContent {
  app: AppEntry;
  versionId: string;
  flowCount: number; // Mobbin's own count for the version
  screenCount: number; // screens in the version
  flows: Flow[]; // Mobbin's order
  screens: Map<string, AppScreen>;
}

// An app in Mobbin's popularity ranking, most popular first.
export interface RankedApp {
  id: string;
  appName: string;
}

export type FreeTextQuery = {
  contentType: "screens" | "flows";
  platform: Platform;
  type: "free_text_search";
  mode: "standard";
  query: string;
  textInScreenshotQuery: string | null;
  hasAnimation: null;
};

export type ScreenFilterQuery = {
  contentType: "screens";
  platform: Platform;
  type: "filters";
  activeFilterTags: [];
  categories: string[] | null;
  screenElements: string[] | null;
  screenPatterns: string[] | null;
  textInScreenshotQuery: string | null;
  hasAnimation: null;
  sortBy: SortBy;
};

export type FlowFilterQuery = {
  contentType: "flows";
  platform: Platform;
  type: "filters";
  activeFilterTags: [];
  categories: string[] | null;
  flowActions: string[] | null;
  sortBy: SortBy;
};

export type AppsQuery =
  | { contentType: "apps"; platform: Platform; type: "free_text_search"; mode: "standard"; query: string; textInScreenshotQuery: null; hasAnimation: null }
  | { contentType: "apps"; platform: Platform; type: "filters"; activeFilterTags: []; categories: string[] | null; sortBy: "publishedAt" | "popularity" | "rating" };

export type SitesQuery =
  | { contentType: "sites"; type: "free_text_search"; mode: "standard"; query: string }
  | { contentType: "sites"; type: "filters"; activeFilterTags: []; categories: null; styles: null; pageAndSectionPatterns: null; sortBy: "publishedAt" | "popularity" };

export type SectionsQuery =
  | { contentType: "sections"; type: "free_text_search"; mode: "standard"; query: string; textInScreenshotQuery: null }
  | {
      contentType: "sections";
      type: "filters";
      activeFilterTags: [];
      categories: null;
      styles: null;
      pageAndSectionPatterns: string[];
      textInScreenshotQuery: null;
      sortBy: "popularity" | "trending";
    };

export type SearchQuery = FreeTextQuery | ScreenFilterQuery | FlowFilterQuery | AppsQuery | SitesQuery | SectionsQuery;

// One app in an app search.
export interface AppSummary {
  id: string;
  appName: string;
  appTagline: string | null;
  platform: Platform;
  appVersionId: string;
  average_rating: number | null;
  isRestricted?: boolean;
}

// A marketing website in Mobbin's sites library.
export interface Site {
  id: string;
  name: string;
  tagline: string | null;
  url: string | null;
  is_defunct?: boolean;
  isRestricted?: boolean;
}

// One section (a slice of a website page) in Mobbin's sites library.
export interface Section {
  id: string;
  patterns: string[];
  page_url: string | null;
  type: string;
  site_version: { id: string; published_at: string; site: { id: string; name: string } };
  cdnImgSources: ImgSources | null;
  restricted?: boolean;
}

// Mobbin's AI ("deep") search: same query shape, separate streaming endpoints.
export type AiQuery = Omit<FreeTextQuery, "mode"> & { mode: "deep" };

// An AI result is the usual screen/flow plus Mobbin's grade (observed 3 and 2) and one-line description.
export type Graded<T> = T & { relevanceScore: number; description: string };

export interface AiCursor {
  searchRequestId: string; // same across every batch of one search
  pageIndex: number;
  evaluatedIds: string[]; // every id Mobbin's AI already judged, so the next batch skips them
}

export interface AiBatch<T> {
  items: Graded<T>[];
  evaluatedIds: string[];
  costUsd: number | null;
  latencyMs: number | null;
}

// ---------- session ----------

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  expires_in: number;
  token_type: string;
  user: { id: string; email?: string } & Record<string, unknown>;
}

// The user's Mobbin session is gone (refresh rejected, or Mobbin refused it after a refresh):
// the user has to sign in again.
export class AuthError extends Error {}

export function normalizeSession(raw: Record<string, unknown>): Session {
  if (typeof raw.access_token !== "string" || typeof raw.refresh_token !== "string") {
    throw new AuthError(`Supabase returned no session: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  const expiresIn = Number(raw.expires_in ?? 3600);
  // Google provider tokens are dropped: Mobbin's server never needs them.
  const { provider_token: _p, provider_refresh_token: _r, weak_password: _w, ...rest } = raw;
  return {
    ...(rest as unknown as Session),
    expires_in: expiresIn,
    expires_at: Number(raw.expires_at ?? Math.floor(Date.now() / 1000) + expiresIn),
  };
}

// Supabase refresh grant. A 4xx means the refresh token is spent or revoked (AuthError: the session
// is dead); anything else is a transient failure and leaves the session alone.
export async function refreshSupabaseSession(cfg: Config, refreshToken: string): Promise<Session> {
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: cfg.supabaseKey, "content-type": "application/json", "x-client-info": "mobbin-mcp" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const text = await res.text();
  if (res.status >= 400 && res.status < 500) throw new AuthError(`Mobbin session refresh rejected: HTTP ${res.status} ${text.slice(0, 200)}`);
  if (!res.ok) throw new Error(`Mobbin session refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  return normalizeSession(JSON.parse(text));
}

// Where a MobbinClient gets its user's session. The server implements it over encrypted per-user
// storage with a per-user lock (src/sessions.ts).
export interface SessionHandle {
  current(): Promise<Session>; // throws AuthError when the user has no session
  refresh(stale: Session): Promise<Session>; // throws AuthError when the refresh token is rejected
  adopt(rotated: Session): Promise<void>; // Mobbin rotated the session via Set-Cookie
  kill(reason: string): Promise<never>; // drops the session; throws AuthError(reason)
}

// @supabase/ssr storage format: "base64-" + base64url(JSON), split into <=3180-char
// chunks named <key>.0, <key>.1 (single cookie <key> when it fits).
export function sessionCookies(cfg: Config, session: Session): string {
  const key = `sb-${cfg.projectRef}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const CHUNK = 3180;
  if (value.length <= CHUNK) return `${key}=${value}`;
  const parts: string[] = [];
  for (let i = 0; i * CHUNK < value.length; i++) parts.push(`${key}.${i}=${value.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  return parts.join("; ");
}

// Reads the session from Mobbin's auth Set-Cookie headers: on sign-in, and whenever Mobbin's server
// refreshes the session itself (adopted so the stored refresh token never goes stale).
export function sessionFromSetCookie(projectRef: string, setCookies: string[]): Session | null {
  const key = `sb-${projectRef}-auth-token`;
  const chunks = new Map<number, string>();
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = decodeURIComponent(pair.slice(eq + 1).trim());
    if (!value) continue;
    if (name === key) chunks.set(0, value);
    const m = name.startsWith(`${key}.`) ? /^\d+$/.exec(name.slice(key.length + 1)) : null;
    if (m) chunks.set(Number(m[0]), value);
  }
  if (chunks.size === 0) return null;
  const joined = [...chunks.keys()].sort((a, b) => a - b).map((k) => chunks.get(k)).join("");
  const json = joined.startsWith("base64-") ? Buffer.from(joined.slice(7), "base64url").toString("utf8") : joined;
  return normalizeSession(JSON.parse(json));
}

// ---------- client ----------

const DAY_MS = 86_400_000;
const POPULAR_PAGES = 5;
const MAX_CACHED_APPS = 30;

export class MobbinClient {
  private catalog: Catalog | null = null;
  private apps = new Map<Platform, AppEntry[]>();

  constructor(
    readonly cfg: Config,
    private sessions: SessionHandle,
  ) {}

  private async getSession(force = false): Promise<Session> {
    const session = await this.sessions.current();
    const fresh = session.expires_at - Math.floor(Date.now() / 1000) > 120;
    return fresh && !force ? session : this.sessions.refresh(session);
  }

  // One authenticated request: session cookies (or bearer), adopts a session Mobbin rotated via Set-Cookie.
  // A POST carries a JSON body; a GET (an app page) asks for the Next.js flight payload instead of HTML.
  private async send(path: string, body: unknown, contentType: string | null, retried: boolean): Promise<{ res: Response; text: string }> {
    const session = await this.getSession(retried);
    const headers: Record<string, string> = {
      accept: "*/*",
      origin: MOBBIN_ORIGIN,
      referer: `${MOBBIN_ORIGIN}/`,
      "user-agent": BROWSER_UA,
    };
    if (contentType) headers["content-type"] = contentType;
    else headers.rsc = "1";
    if (this.cfg.authMode === "bearer") headers.authorization = `Bearer ${session.access_token}`;
    else headers.cookie = sessionCookies(this.cfg, session);

    const init: RequestInit = contentType
      ? { method: "POST", headers, body: JSON.stringify(body) }
      : { method: "GET", headers, redirect: "manual" };
    const res = await fetch(`${MOBBIN_ORIGIN}${path}`, init);
    const rotated = sessionFromSetCookie(this.cfg.projectRef, res.headers.getSetCookie());
    if (rotated && rotated.refresh_token !== session.refresh_token) await this.sessions.adopt(rotated);
    return { res, text: await res.text() };
  }

  async post<T>(path: string, body: unknown, retried = false): Promise<T> {
    const { res, text } = await this.send(path, body, "text/plain;charset=UTF-8", retried);
    let json: { value?: T; error?: { message?: string } } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body handled below */
    }
    const message = json?.error?.message;
    if (res.status === 401 || message === "unauthenticated") {
      if (!retried) return this.post<T>(path, body, true);
      return this.sessions.kill(`Mobbin rejected the session (${message ?? `HTTP ${res.status}`}) even after a refresh.`);
    }
    if (!res.ok) throw new Error(`Mobbin ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (message) throw new Error(`Mobbin ${path} error: ${message}`);
    if (!json || !("value" in json)) throw new Error(`Mobbin ${path} returned an unexpected body: ${text.slice(0, 300)}`);
    return json.value as T;
  }

  // One batch of Mobbin's AI search (~$0.016 of the account's Mobbin AI credits, ~8–11 s).
  async aiSearch<T>(q: AiQuery, cursor: AiCursor, retried = false): Promise<AiBatch<T>> {
    const path = `/api/search/ai/${q.contentType}/stream`;
    const body = {
      searchQuery: q,
      shouldCurate: true,
      searchRequestId: cursor.searchRequestId,
      [q.contentType === "screens" ? "evaluatedScreenIds" : "evaluatedFlowIds"]: cursor.evaluatedIds,
      pageIndex: cursor.pageIndex,
      id: messageId(),
      messages: [{ parts: [{ type: "text", text: q.query }], id: messageId(), role: "user" }],
      trigger: "submit-message",
    };
    const { res, text } = await this.send(path, body, "application/json", retried);
    if (res.status === 401) {
      if (!retried) return this.aiSearch<T>(q, cursor, true);
      return this.sessions.kill(`Mobbin rejected the session on ${path} (HTTP 401) even after a refresh.`);
    }
    if (!res.ok) throw new Error(`Mobbin ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    return parseAiStream<T>(text, q.contentType);
  }

  // searchRequestId is reused per query so later pages continue the same result set.
  private requestIds = new Map<string, string>();
  private requestId(q: SearchQuery): string {
    const key = JSON.stringify(q);
    let id = this.requestIds.get(key);
    if (!id) {
      id = randomUUID();
      this.requestIds.set(key, id);
      if (this.requestIds.size > 200) this.requestIds.delete(this.requestIds.keys().next().value!);
    }
    return id;
  }

  searchScreens(q: FreeTextQuery | ScreenFilterQuery, pageIndex: number): Promise<SearchPage<Screen>> {
    return this.post("/api/search/fetch-search-page-screens", { searchRequestId: this.requestId(q), pageIndex, searchQuery: q });
  }

  searchFlows(q: FreeTextQuery | FlowFilterQuery, pageIndex: number): Promise<SearchPage<Flow>> {
    return this.post("/api/search/fetch-search-page-flows", { searchRequestId: this.requestId(q), pageIndex, searchQuery: q });
  }

  searchApps(q: AppsQuery, pageIndex: number): Promise<SearchPage<AppSummary>> {
    return this.post("/api/search/fetch-search-page-apps", { searchRequestId: this.requestId(q), pageIndex, searchQuery: q });
  }

  searchSites(q: SitesQuery, pageIndex: number): Promise<SearchPage<Site>> {
    return this.post("/api/search/fetch-search-page-sites", { searchRequestId: this.requestId(q), pageIndex, searchQuery: q });
  }

  searchSections(q: SectionsQuery, pageIndex: number): Promise<SearchPage<Section>> {
    return this.post("/api/search/fetch-search-page-sections", { searchRequestId: this.requestId(q), pageIndex, searchQuery: q });
  }

  // Shape of the value is unverified live; callers dig for image sources defensively.
  screenInfo(screenId: string): Promise<unknown> {
    return this.post("/api/screen/fetch-screen-info", { screenId });
  }

  async tagCatalog(): Promise<Catalog> {
    this.catalog ??= await this.cached("filter-tag-catalogs.json", () => this.post<Catalog>("/api/filter-tags/fetch-filter-tag-catalogs", {}));
    return this.catalog;
  }

  async searchableApps(platform: Platform): Promise<AppEntry[]> {
    let list = this.apps.get(platform);
    if (!list) {
      list = await this.cached(`apps-${platform}.json`, async () => {
        const raw = await this.post<AppEntry[]>("/api/search-bar/fetch-searchable-apps", { platform });
        return raw.map(({ id, appName, platform: p, appTagline }) => ({ id, appName, platform: p, appTagline }));
      });
      this.apps.set(platform, list);
    }
    return list;
  }

  private async cached<T>(file: string, load: () => Promise<T>): Promise<T> {
    const path = join(this.cfg.cacheDir, file);
    const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => Infinity);
    if (age < DAY_MS) return JSON.parse(await readFile(path, "utf8")) as T;
    const value = await load();
    // Shared by every user's client: write-then-rename so a concurrent reader never sees half a file.
    await mkdir(this.cfg.cacheDir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, path);
    return value;
  }

  // Mobbin's most popular apps for a platform (5 pages of 24), shared by every user's client for a day.
  popularApps(platform: Platform): Promise<RankedApp[]> {
    return this.cached(`popular-apps-${platform}.json`, async () => {
      const out: RankedApp[] = [];
      for (let pageIndex = 0; pageIndex < POPULAR_PAGES; pageIndex++) {
        const page = await this.searchApps({ contentType: "apps", platform, type: "filters", activeFilterTags: [], categories: null, sortBy: "popularity" }, pageIndex);
        out.push(...page.data.map(({ id, appName }) => ({ id, appName })));
        if (!page.hasNextPage) break;
      }
      return out;
    });
  }

  // Every flow and screen of one app, from its app page; kept per user and app for a day.
  private appContents = new Map<string, { at: number; value: Promise<AppContent> }>();

  appContent(app: AppEntry): Promise<AppContent> {
    const hit = this.appContents.get(app.id);
    if (hit && Date.now() - hit.at < DAY_MS) return hit.value;
    const value = this.loadAppContent(app);
    this.appContents.set(app.id, { at: Date.now(), value });
    value.catch(() => this.appContents.delete(app.id));
    if (this.appContents.size > MAX_CACHED_APPS) this.appContents.delete(this.appContents.keys().next().value!);
    return value;
  }

  private async loadAppContent(app: AppEntry): Promise<AppContent> {
    const v = await this.post<{ appVersions: { id: string; createdAt: string; publishedAt: string | null; appScreens: unknown[] }[] }>(
      "/api/app/fetch-app-versions-screens",
      { appId: app.id },
    );
    const when = (x: { createdAt: string; publishedAt: string | null }) => Date.parse(x.publishedAt ?? x.createdAt);
    const latest = [...v.appVersions].sort((a, b) => when(b) - when(a))[0];
    if (!latest) throw new Error(`Mobbin lists no versions for ${app.appName} (${app.platform}).`);
    // Mobbin ignores the slug before "-<platform>-"; the app id and version id pick the page.
    const slug = app.appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
    const text = await this.getPage(`/apps/${slug}-${app.platform}-${app.id}/${latest.id}/flows`);
    return parseAppPage(text, app, latest.id, latest.appScreens.length);
  }

  // An app page as a Next.js flight payload (the "rsc: 1" request), on the user's session.
  private async getPage(path: string, retried = false): Promise<string> {
    const { res, text } = await this.send(path, null, null, retried);
    const location = res.headers.get("location") ?? "";
    if (res.status === 401 || (res.status >= 300 && res.status < 400 && location.includes("login"))) {
      if (!retried) return this.getPage(path, true);
      return this.sessions.kill(`Mobbin sent ${path} to sign-in (HTTP ${res.status}) even after a session refresh.`);
    }
    if (res.status !== 200) throw new Error(`Mobbin ${path} returned HTTP ${res.status}${location ? ` → ${location}` : ""}: ${text.slice(0, 200)}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/x-component")) throw new Error(`Mobbin ${path} answered ${type || "no content-type"} instead of a flight payload: ${text.slice(0, 200)}`);
    return text;
  }

  async fetchImage(url: string): Promise<{ data: string; mimeType: string }> {
    const res = await fetch(url, { headers: { "user-agent": BROWSER_UA, referer: `${MOBBIN_ORIGIN}/` } });
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!res.ok || !mimeType.startsWith("image/")) {
      throw new Error(`Image fetch failed: HTTP ${res.status} ${mimeType} for ${url.slice(0, 120)}`);
    }
    return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType };
  }
}

// ---------- app page ----------

// The JSON object starting at s[i] ("{"), with strings and their escapes skipped; null when unbalanced.
function objectAt(s: string, i: number): string | null {
  let depth = 0;
  let inString = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inString) {
      if (c === "\\") j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(i, j + 1);
  }
  return null;
}

function* objectsStarting(s: string, start: RegExp): Generator<Record<string, unknown>> {
  for (const m of s.matchAll(start)) {
    const raw = objectAt(s, m.index);
    if (!raw) continue;
    try {
      yield JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* a match inside a longer string literal; not an object */
    }
  }
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

type PageFlowStep = Omit<FlowScreen, "width" | "height" | "screenCdnImgSources">;

// Reads an app page's flight payload by object shape (the page also holds the tag catalogue and
// unrelated data): screens are {"type",…,"appId","screenPatterns",…}, flows are {"id","name","actions",…,"screens":[{screenId,…}]}.
// The flow count Mobbin states for the version must equal the flows found, so a page served without
// the signed-in flow data fails instead of reporting a short catalogue.
export function parseAppPage(text: string, app: AppEntry, versionId: string, screenCount: number): AppContent {
  const screens = new Map<string, AppScreen>();
  for (const o of objectsStarting(text, new RegExp(`\\{"type":"[a-z_]+","id":"${UUID}"`, "g"))) {
    if (o.appId !== app.id || !Array.isArray(o.screenPatterns) || !Array.isArray(o.screenElements)) continue;
    const boxes = Array.isArray(o.ocrBoundingBoxes) ? (o.ocrBoundingBoxes as { text?: unknown }[]) : [];
    screens.set(o.id as string, {
      id: o.id as string,
      screenPatterns: o.screenPatterns as string[],
      screenElements: o.screenElements as string[],
      width: Number(o.width ?? 0),
      height: Number(o.height ?? 0),
      text: boxes.map((b) => (typeof b.text === "string" ? b.text : "")).join(" "),
      screenCdnImgSources: (o.screenCdnImgSources as ImgSources | null) ?? null,
      restricted: o.restricted === true,
    });
  }

  const flows = new Map<string, Flow & { order: number }>();
  for (const o of objectsStarting(text, new RegExp(`\\{"id":"${UUID}","name":`, "g"))) {
    if (flows.has(o.id as string) || !Array.isArray(o.actions) || !Array.isArray(o.screens)) continue;
    const steps = o.screens as PageFlowStep[];
    if (!steps.length || !steps.every((st) => screens.has(st.screenId))) continue;
    flows.set(o.id as string, {
      id: o.id as string,
      name: String(o.name),
      actions: o.actions as string[],
      appId: app.id,
      appName: app.appName,
      platform: app.platform,
      order: Number(o.order ?? 0),
      screens: steps.map((st) => {
        const s = screens.get(st.screenId)!;
        return {
          order: st.order,
          hotspotType: st.hotspotType,
          hotspotX: st.hotspotX,
          hotspotY: st.hotspotY,
          hotspotWidth: st.hotspotWidth,
          hotspotHeight: st.hotspotHeight,
          screenId: st.screenId,
          width: s.width,
          height: s.height,
          screenCdnImgSources: s.screenCdnImgSources,
        };
      }),
    });
  }

  const count = new RegExp(`"id":"${versionId}"[^{}]*?"appVersionFlowsCount":\\[\\{"count":(\\d+)\\}\\]`).exec(text);
  if (!count) throw new Error(`Mobbin's app page for ${app.appName} (${app.platform}) has no flow count for version ${versionId}; its layout may have changed.`);
  const flowCount = Number(count[1]);
  if (flows.size !== flowCount) {
    throw new Error(
      `Mobbin's app page for ${app.appName} (${app.platform}) states ${flowCount} flows but carries ${flows.size} (and ${screens.size} screens). ` +
        `Mobbin leaves flow data out for signed-out visitors, so the session may not be signed in; sign in again if this repeats.`,
    );
  }
  return {
    app,
    versionId,
    flowCount,
    screenCount,
    flows: [...flows.values()].sort((a, b) => a.order - b.order),
    screens,
  };
}

// AI-SDK style 16-char message id.
function messageId(): string {
  return randomBytes(12).toString("base64url").slice(0, 16);
}

// Parses an AI-SDK UI message stream ("data: {json}" lines, then "data: [DONE]"): data-phase parts,
// then one data-result carrying the graded screens or flows. Anything else is an error that quotes the stream.
export function parseAiStream<T>(stream: string, contentType: "screens" | "flows"): AiBatch<T> {
  let phase = "none";
  let result: Record<string, unknown> | null = null;
  let errorText: string | null = null;
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let part: { type?: string; data?: Record<string, unknown>; errorText?: string };
    try {
      part = JSON.parse(payload);
    } catch {
      continue;
    }
    if (part.type === "data-phase" && typeof part.data?.phase === "string") phase = part.data.phase;
    else if (part.type === "data-result") result = part.data ?? null;
    else if (part.type === "error") errorText = part.errorText ?? JSON.stringify(part);
  }
  const fail = (why: string) =>
    new Error(`Mobbin AI ${contentType} search failed: ${why} (last phase "${phase}"). Stream starts: ${stream.slice(0, 300)}`);
  if (errorText !== null) throw fail(`stream error "${errorText.slice(0, 200)}"`);
  const items = result?.[contentType];
  const evaluated = result?.[contentType === "screens" ? "evaluatedScreenIds" : "evaluatedFlowIds"];
  if (!result) throw fail("stream ended without a result");
  if (!Array.isArray(items) || !Array.isArray(evaluated)) throw fail(`result has no ${contentType} list`);
  return { items: items as Graded<T>[], evaluatedIds: evaluated as string[], costUsd: totalCost(result.costs), latencyMs: typeof result.latencyMs === "number" ? result.latencyMs : null };
}

// costs = { <stage>: { totalCostUsd } … }; null when Mobbin omits it.
function totalCost(costs: unknown): number | null {
  if (!costs || typeof costs !== "object") return null;
  const stages = Object.values(costs as Record<string, { totalCostUsd?: unknown }>).map((s) => s?.totalCostUsd);
  return stages.every((n) => typeof n === "number") ? (stages as number[]).reduce((a, b) => a + b, 0) : null;
}
