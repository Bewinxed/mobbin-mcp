// MCP tool surface: a path an agent walks (find apps → open an app → open a flow → images), cross-app
// screen and flow search, and Mobbin's websites library. Every step returns compact text with the ids
// the next step takes; images load only for screens the agent picks.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  type AiQuery,
  type AppContent,
  type AppEntry,
  type AppSummary,
  type AppsQuery,
  type Catalog,
  type Flow,
  type FlowScreen,
  type FreeTextQuery,
  type Graded,
  type ImgSources,
  MOBBIN_ORIGIN,
  type MobbinClient,
  type Platform,
  type Screen,
  type SearchPage,
  type Section,
  type SectionsQuery,
  type Site,
  type SitesQuery,
  type Tag,
} from "./api.js";
import { describeMatches, parseRankQuery, rankFlows, screenMatches, tagSummary } from "./appsearch.js";
import { norm, quote, stem, words } from "./text.js";

const API_PAGE = 24; // Mobbin's page size on the non-AI endpoints
const MAX_STEPS_SHOWN = 25;
const AI_BATCH_COST = "~$0.016 of the user's Mobbin AI credits, ~10 s";
const MAX_CACHED_SEARCHES = 50;
const MAX_REMEMBERED_FLOWS = 5000;
const SCREENS_PER_APP = 2; // per round of a cross-app screen page
const FLOWS_PER_APP = 1; // per round of a cross-app flow page

class InputError extends Error {}

const PLATFORMS: Platform[] = ["ios", "android", "web"];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---------- tags ----------

export type TagKind = "patterns" | "elements" | "flow_actions" | "app_categories" | "sections" | "site_categories" | "site_styles";
const KIND: Record<TagKind, { slug: string; label: string; sites: boolean }> = {
  patterns: { slug: "screenPatterns", label: "screen pattern", sites: false },
  elements: { slug: "screenElements", label: "UI element", sites: false },
  flow_actions: { slug: "flowActions", label: "flow action", sites: false },
  app_categories: { slug: "appCategories", label: "app category", sites: false },
  sections: { slug: "pageAndSectionPatterns", label: "website section", sites: true },
  site_categories: { slug: "categories", label: "website category", sites: true },
  site_styles: { slug: "styles", label: "website style", sites: true },
};
const ALL_KINDS = Object.keys(KIND) as TagKind[];

// App tags differ between web and mobile; website tags are one set.
const experience = (kind: TagKind, p: Platform) => (KIND[kind].sites ? "sites" : p === "web" ? "web" : "mobile");
const scopeOf = (kind: TagKind, p: Platform) => (KIND[kind].sites ? "websites" : p);

function groupsOf(cat: Catalog, platform: Platform, kind: TagKind) {
  return cat[experience(kind, platform)]?.[KIND[kind].slug] ?? [];
}

function tagsOf(cat: Catalog, platform: Platform, kind: TagKind): Tag[] {
  return groupsOf(cat, platform, kind).flatMap((g) => g.tags);
}

function tagCount(tag: Tag, platform: Platform): string {
  const [unit, counts] = Object.entries(tag.contentCounts ?? {})[0] ?? [];
  if (typeof counts === "number") return `${counts} ${unit}`;
  const n = counts?.[platform];
  return n === undefined ? "" : `${n} ${platform} ${unit}`;
}

// Mobbin lists some synonyms as "" (e.g. the website style "3D").
const synonymsOf = (tag: Tag) => tag.synonyms.filter((s) => s.trim());

const STOP = new Set("a an and app apps for in of on the to ui ux with screen screens page pages view flow flows".split(" "));

function scoreTag(tag: Tag, phrase: string, tokens: string[]): number {
  const name = norm(tag.displayName);
  const syns = synonymsOf(tag).map(norm);
  let s = 0;
  if (name === phrase) s += 100;
  else if (syns.includes(phrase)) s += 80;
  const nameStems = words(tag.displayName).map(stem);
  const synStems = syns.flatMap((x) => x.split(" ")).map(stem);
  const defStems = words(tag.definition ?? "").map(stem);
  for (const t of tokens) {
    if (nameStems.includes(t)) s += 30;
    if (synStems.includes(t)) s += 20;
    if (defStems.includes(t)) s += 4;
  }
  return s;
}

export function lookupTags(cat: Catalog, platform: Platform, kinds: TagKind[], query: string | undefined, limit: number): string {
  const apps = kinds.some((k) => !KIND[k].sites);
  const sites = kinds.some((k) => KIND[k].sites);
  const scope = [apps ? `app tags for ${platform}` : "", sites ? "website tags" : ""].filter(Boolean).join(", ");
  if (!query?.trim()) {
    const out = [`All Mobbin tag names (${scope}). Call again with a query for definitions and synonyms.`];
    for (const kind of kinds) {
      out.push(`\n${KIND[kind].label}s (kind ${kind}):`);
      for (const g of groupsOf(cat, platform, kind)) out.push(`  ${g.displayName}: ${g.tags.map((t) => t.displayName).join(", ")}`);
    }
    return out.join("\n");
  }
  const phrase = norm(query);
  const tokens = [...new Set(words(query).filter((w) => !STOP.has(w)).map(stem))];
  const ranked = kinds
    .flatMap((kind) => tagsOf(cat, platform, kind).map((tag) => ({ kind, tag, score: scoreTag(tag, phrase, tokens) })))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) {
    return `No Mobbin tag matches "${query}" (${scope}). Mobbin has no tag for this: search it as free text (query, plus on_screen_text for words visible on a screen).`;
  }
  const shown = ranked.slice(0, limit);
  const lines = shown.map(({ kind, tag }) => {
    const meta = [`${KIND[kind].label}, kind ${kind}`, tag.subCategory, tagCount(tag, platform)].filter(Boolean).join(" · ");
    const syn = synonymsOf(tag).length ? ` Synonyms: ${synonymsOf(tag).join(", ")}.` : "";
    return `- ${tag.displayName} (${meta})${tag.definition ? ` — ${tag.definition}` : ""}${syn}`;
  });
  const more = ranked.length > shown.length ? `\n${ranked.length - shown.length} weaker matches not shown; raise limit to see them.` : "";
  return `Tags matching "${query}" (${scope}), best first:\n${lines.join("\n")}${more}`;
}

// Exact names or synonyms only: a wrong tag name silently returns zero results upstream.
export function resolveTags(cat: Catalog, platform: Platform, kind: TagKind, names: string[] | undefined) {
  if (!names?.length) return { names: null as string[] | null, notes: [] as string[] };
  const all = tagsOf(cat, platform, kind);
  const notes: string[] = [];
  const resolved = names.map((raw) => {
    const n = norm(raw);
    const exact = all.find((t) => norm(t.displayName) === n);
    if (exact) return exact.displayName;
    const viaSyn = all.find((t) => synonymsOf(t).some((s) => norm(s) === n));
    if (viaSyn) {
      notes.push(`"${raw}" → ${viaSyn.displayName}`);
      return viaSyn.displayName;
    }
    const tokens = words(raw).filter((w) => !STOP.has(w)).map(stem);
    const close = all
      .map((t) => ({ t, s: scoreTag(t, n, tokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map((x) => x.t.displayName);
    throw new InputError(
      `Unknown ${scopeOf(kind, platform)} ${KIND[kind].label} tag "${raw}". ` +
        (close.length
          ? `Closest: ${close.join(", ")}, e.g. ["${close[0]}"].`
          : `No similar tag; Mobbin may not tag this idea, so search it as free text, or call mobbin_lookup_tags with kind "${kind}" for the full list.`),
    );
  });
  return { names: resolved, notes };
}

// Pattern, element and flow-action tags: the vocabulary an app's own content is ranked with.
const rankTags = (cat: Catalog, platform: Platform) => (["patterns", "elements", "flow_actions"] as TagKind[]).flatMap((k) => tagsOf(cat, platform, k));

// ---------- apps ----------

const stripParens = (s: string) => norm(s.replace(/\([^)]*\)/g, ""));

// By exact full name (never a prefix) on the given platform, or by app id on any platform.
export async function resolveApp(client: Pick<MobbinClient, "searchableApps">, platform: Platform, ref: string): Promise<AppEntry> {
  const id = UUID_RE.exec(ref)?.[0]?.toLowerCase();
  if (id) {
    for (const p of [platform, ...PLATFORMS.filter((x) => x !== platform)]) {
      const hit = (await client.searchableApps(p)).find((a) => a.id === id);
      if (hit) return hit;
    }
    throw new InputError(`No Mobbin app has id ${id}. Use an id printed by mobbin_find_apps, or the app's exact name.`);
  }
  const apps = await client.searchableApps(platform);
  const n = norm(ref);
  const hit = apps.find((a) => norm(a.appName) === n) ?? apps.find((a) => stripParens(a.appName) === stripParens(ref));
  if (hit) return hit;
  const nameWords = new Set(words(ref));
  const sharing = apps.filter((a) => words(a.appName).some((w) => nameWords.has(w))).slice(0, 8);
  throw new InputError(
    `No ${platform} app on Mobbin is named "${ref}".` +
      (sharing.length ? ` ${platform} apps sharing a word: ${sharing.map((a) => a.appName).join(", ")}.` : "") +
      ` Pass the exact name or an app id from mobbin_find_apps; the app may also exist only on another platform.`,
  );
}

// ---------- session knowledge (filled by every tool, used for flow context, open_flow and images) ----------

interface Known {
  appName: string;
  img: ImgSources | null;
  tags?: string;
  section?: boolean; // a website section, not an app screen
  flows?: { id: string; name: string; step: number; steps: number }[]; // every flow it is a step of, most recently opened first
}

// 'flow "Creating an app with AI" step 1/13 (also in "Home" step 1, "Planning with AI" step 1)'
function flowContext(k: Known | undefined): string {
  const [first, ...rest] = k?.flows ?? [];
  if (!first) return "";
  const others = rest.slice(0, 2).map((f) => `"${f.name}" step ${f.step}`);
  if (rest.length > 2) others.push(`${rest.length - 2} more`);
  return `flow "${first.name}" step ${first.step}/${first.steps}${others.length ? ` (also in ${others.join(", ")})` : ""}`;
}

export type KnownFlow = Flow & { description?: string };

export class Memory {
  screens = new Map<string, Known>();
  flows = new Map<string, KnownFlow>();

  rememberScreens(list: Screen[]) {
    for (const s of list) {
      const prev = this.screens.get(s.id);
      this.screens.set(s.id, { ...prev, appName: s.appName, img: s.screenCdnImgSources ?? prev?.img ?? null, tags: screenTags(s.screenPatterns, s.screenElements) || prev?.tags });
    }
  }

  rememberFlows(list: KnownFlow[]) {
    for (const f of list) {
      const prev = this.flows.get(f.id);
      this.flows.delete(f.id); // re-inserted last, so the cap drops the least recently seen
      this.flows.set(f.id, { ...prev, ...f });
      if (this.flows.size > MAX_REMEMBERED_FLOWS) this.flows.delete(this.flows.keys().next().value!);
      for (const st of f.screens) {
        const prev = this.screens.get(st.screenId);
        const step = { id: f.id, name: f.name, step: st.order + 1, steps: f.screens.length };
        this.screens.set(st.screenId, {
          ...prev,
          appName: f.appName,
          img: st.screenCdnImgSources ?? prev?.img ?? null,
          flows: [step, ...(prev?.flows ?? []).filter((x) => x.id !== f.id)],
        });
      }
    }
  }

  rememberApp(content: AppContent) {
    this.rememberFlows(content.flows);
    for (const s of content.screens.values()) {
      const prev = this.screens.get(s.id);
      this.screens.set(s.id, { ...prev, appName: content.app.appName, img: s.screenCdnImgSources ?? prev?.img ?? null, tags: screenTags(s.screenPatterns, s.screenElements) });
    }
  }

  rememberSections(list: Section[]) {
    for (const s of list) {
      this.screens.set(s.id, { appName: s.site_version.site.name, img: s.cdnImgSources, section: true });
    }
  }
}

function screenTags(patterns: string[] | undefined, elements: string[] | undefined): string {
  const parts: string[] = [];
  if (patterns?.length) parts.push(`patterns: ${patterns.join(", ")}`);
  if (elements?.length) parts.push(`elements: ${elements.join(", ")}`);
  return parts.join(" — ");
}

// ---------- ordering: spread across apps, less-mainstream first ----------

export type Prefer = "distinctive" | "popular";

export interface Ordering {
  prefer: Prefer;
  popular: Set<string> | null; // Mobbin's most popular app ids for the platform ("distinctive" only)
  popularCount: number;
  excluded: Map<string, string>; // app id → name
}

export async function makeOrdering(client: MobbinClient, platform: Platform, prefer: Prefer, exclude: string[] | undefined): Promise<Ordering> {
  const excluded = new Map<string, string>();
  for (const name of exclude ?? []) {
    const app = await resolveApp(client, platform, name);
    excluded.set(app.id, app.appName);
  }
  if (prefer === "popular") return { prefer, popular: null, popularCount: 0, excluded };
  const list = await client.popularApps(platform);
  return { prefer, popular: new Set(list.map((a) => a.id)), popularCount: list.length, excluded };
}

// Round-robin by app, `cap` items per app per round, apps in first-appearance order; with a popularity
// set, apps outside it come first in every round.
export function spread<T extends { appId: string }>(items: T[], cap: number, popular: Set<string> | null): T[] {
  const byApp = new Map<string, T[]>();
  for (const i of items) byApp.set(i.appId, [...(byApp.get(i.appId) ?? []), i]);
  let apps = [...byApp.keys()];
  if (popular) apps = [...apps.filter((a) => !popular.has(a)), ...apps.filter((a) => popular.has(a))];
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) {
    for (const a of apps) out.push(...byApp.get(a)!.slice(round * cap, (round + 1) * cap));
  }
  return out;
}

const popularMark = (o: Ordering, appId: string) => (o.popular?.has(appId) ? " (popular)" : "");

function orderNote(o: Ordering, platform: Platform, cap: number, noun: string, within: string): string {
  const spreadText = `at most ${cap} ${cap === 1 ? noun.replace(/s$/, "") : noun} per app before an app repeats`;
  const hidden = o.excluded.size ? ` Excluded: ${[...o.excluded.values()].join(", ")}.` : "";
  return o.popular
    ? `Order: ${within}, apps outside Mobbin's ${o.popularCount} most popular ${platform} apps first, popular ones marked (popular); ${spreadText}.${hidden}`
    : `Order: Mobbin's ${within === "within each grade" ? "order within each grade" : "order"}, which favours popular apps; ${spreadText}.${hidden}`;
}

// ---------- formatting ----------

const screenUrl = (id: string) => `${MOBBIN_ORIGIN}/screens/${id}`;
const flowUrl = (id: string) => `${MOBBIN_ORIGIN}/flows/${id}`;

// Consecutive screens of one app share a heading; an app that comes back in a later round gets a new one.
export function formatScreenList(screens: Screen[], memory: Memory, o: Ordering): string {
  const out: string[] = [];
  let last = "";
  for (const s of screens) {
    if (s.appId !== last) out.push(`${s.appName}${popularMark(o, s.appId)} · ${s.platform}`);
    last = s.appId;
    const parts = [screenUrl(s.id)];
    const tags = screenTags(s.screenPatterns, s.screenElements);
    if (tags) parts.push(tags);
    const flow = flowContext(memory.screens.get(s.id));
    if (flow) parts.push(flow);
    const text = s.textInScreenshotSearchBoundingBoxes?.map((b) => b.text).join(" ");
    if (text) parts.push(`text match: "${text}"`);
    if (s.restricted) parts.push("restricted");
    out.push(`  ${parts.join(" — ")}`);
  }
  return out.join("\n");
}

export function describeHotspot(s: FlowScreen): string {
  const { hotspotX: x, hotspotY: y, hotspotWidth: w, hotspotHeight: h } = s;
  if (x == null || y == null || w == null || h == null) return "end (no tap)";
  const cx = x + w / 2;
  const cy = y + h / 2;
  const vert = cy < 0.12 ? "top bar" : cy < 0.33 ? "upper area" : cy < 0.66 ? "middle" : cy < 0.88 ? "lower area" : "bottom bar";
  const horiz = w > 0.75 ? "full width" : cx < 0.33 ? "left" : cx < 0.66 ? "center" : "right";
  const shape =
    w > 0.6 && h < 0.12 ? "wide button/row" : w < 0.18 && h < 0.1 ? "small icon/control" : h > 0.3 ? "large area" : "element";
  const verb = s.hotspotType ?? "tap";
  return `${verb} ${shape}, ${horiz}, ${vert} (y≈${Math.round(cy * 100)}%)`;
}

// The full flow: every step's screen id, its tags when known, and the tap that leads on.
export function formatFlow(f: KnownFlow, memory: Memory): string {
  const steps = [...f.screens].sort((a, b) => a.order - b.order);
  const head = `Flow "${f.name}" · ${f.appName} · ${f.platform} · ${steps.length} steps` + (f.actions?.length ? ` · actions: ${f.actions.join(", ")}` : "");
  const lines = [head, `  ${flowUrl(f.id)}`];
  if (f.description) lines.push(`  ${f.description}`);
  steps.slice(0, MAX_STEPS_SHOWN).forEach((st, i) => {
    const tags = memory.screens.get(st.screenId)?.tags;
    lines.push(`  ${i + 1}. ${st.screenId} — ${describeHotspot(st)}${tags ? ` — ${tags}` : ""}`);
  });
  if (steps.length > MAX_STEPS_SHOWN) lines.push(`  … ${steps.length - MAX_STEPS_SHOWN} more steps; open the flow URL.`);
  return lines.join("\n");
}

// One line per flow in a cross-app list; the steps come from mobbin_open_flow.
function flowLine(f: KnownFlow, o: Ordering): string {
  const parts = [`${f.appName}${popularMark(o, f.appId)}`, quote(f.name), `${f.screens.length} steps`];
  if (f.actions?.length) parts.push(`actions: ${f.actions.join(", ")}`);
  if (f.description) parts.push(f.description);
  parts.push(`flow ${f.id}`);
  return `- ${parts.join(" — ")}`;
}

// ---------- helpers ----------

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
  }
}

// Rows [start, start+count) of a non-AI search, read across Mobbin's fixed 24-row API pages.
async function apiSlice<T>(fetchPage: (i: number) => Promise<SearchPage<T>>, start: number, count: number) {
  let index = Math.floor(start / API_PAGE);
  const offset = start - index * API_PAGE;
  const rows: T[] = [];
  const first = await fetchPage(index);
  let last = first;
  rows.push(...first.data);
  while (rows.length < offset + count && last.hasNextPage) {
    last = await fetchPage(++index);
    rows.push(...last.data);
  }
  return { items: rows.slice(offset, offset + count), total: first.totalCount, hasMore: rows.length > offset + count || last.hasNextPage };
}

// ---------- AI search: Mobbin's graded "deep" search, batches cached per query ----------

type AiItem = { id: string; appId: string; relevanceScore: number };

interface AiState<T extends AiItem> {
  query: AiQuery;
  searchRequestId: string;
  evaluated: Set<string>; // every candidate Mobbin's AI has judged for this search
  batches: T[][]; // kept results per batch, in Mobbin's order
  seen: Set<string>;
  end: string | null; // why no further batch will run
  pending: Promise<number | null> | null;
}

export interface AiRun {
  costUsd: number | null;
  ms: number;
}

export class AiSearches {
  private states = new Map<string, AiState<AiItem>>();

  constructor(private client: Pick<MobbinClient, "aiSearch">) {}

  // Makes sure `need` in-scope results are cached, running at most one new AI batch per call.
  async ensure<T extends AiItem>(query: AiQuery, need: number, inScope: (item: T) => boolean): Promise<{ state: AiState<T>; run: AiRun | null }> {
    const key = JSON.stringify(query);
    let state = this.states.get(key) as AiState<T> | undefined;
    if (!state) {
      state = { query, searchRequestId: randomUUID(), evaluated: new Set(), batches: [], seen: new Set(), end: null, pending: null };
      this.states.set(key, state as unknown as AiState<AiItem>);
      if (this.states.size > MAX_CACHED_SEARCHES) this.states.delete(this.states.keys().next().value!);
    }
    // A concurrent call for the same search waits for its batch instead of paying for a second one.
    if (state.pending) await state.pending.catch(() => null);
    if (state.batches.flat().filter(inScope).length >= need || state.end) return { state, run: null };
    const t0 = Date.now();
    const s = state;
    s.pending = this.batch(s).finally(() => (s.pending = null));
    const costUsd = await s.pending;
    return { state, run: { costUsd, ms: Date.now() - t0 } };
  }

  private async batch<T extends AiItem>(s: AiState<T>): Promise<number | null> {
    const b = await this.client.aiSearch<T>(s.query, {
      searchRequestId: s.searchRequestId,
      pageIndex: s.batches.length,
      evaluatedIds: [...s.evaluated],
    });
    const fresh = b.evaluatedIds.filter((id) => !s.evaluated.has(id));
    fresh.forEach((id) => s.evaluated.add(id));
    const kept = b.items.filter((i) => !s.seen.has(i.id));
    kept.forEach((i) => s.seen.add(i.id));
    s.batches.push(kept);
    if (fresh.length === 0) s.end = "Mobbin AI has no unchecked candidates left for this query";
    else if (kept.length === 0) s.end = `Mobbin AI's last batch of ${fresh.length} candidates kept none`;
    return b.costUsd;
  }
}

const GRADE_LABEL: Record<number, string> = { 3: "Strong matches", 2: "Related" };
const gradeLabel = (g: number) => `${GRADE_LABEL[g] ?? "Other"} (grade ${g})`;

function gradeCounts(items: AiItem[]): string {
  const n = new Map<number, number>();
  for (const i of items) n.set(i.relevanceScore, (n.get(i.relevanceScore) ?? 0) + 1);
  return [...n.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([g, c]) => `${c} ${g === 3 ? "strong" : g === 2 ? "related" : `grade ${g}`}`)
    .join(", ");
}

// One batch in display order: grade by grade, each grade spread across apps. Batches are arranged
// independently, so a new batch never moves results an earlier page already showed.
function arrangeBatch<T extends AiItem>(batch: T[], cap: number, o: Ordering): T[] {
  const grades = [...new Set(batch.map((i) => i.relevanceScore))].sort((a, b) => b - a);
  return grades.flatMap((g) => spread(batch.filter((i) => i.relevanceScore === g), cap, o.popular));
}

// Regroups a page by grade; the sort is stable, so the arranged order holds within each grade.
function groupByGrade<T extends AiItem>(items: T[], line: (item: T) => string, sep: string): string {
  const groups = new Map<number, T[]>();
  for (const i of [...items].sort((a, b) => b.relevanceScore - a.relevanceScore)) {
    groups.set(i.relevanceScore, [...(groups.get(i.relevanceScore) ?? []), i]);
  }
  return [...groups].map(([g, list]) => `${gradeLabel(g)}:\n${list.map(line).join(sep)}`).join("\n\n");
}

export function formatAiScreen(s: Graded<Screen>, memory: Memory, o: Ordering): string {
  const parts = [`${s.appName}${popularMark(o, s.appId)}`, screenUrl(s.id), s.description];
  const tags = screenTags(s.screenPatterns, s.screenElements);
  if (tags) parts.push(tags);
  const flow = flowContext(memory.screens.get(s.id));
  if (flow) parts.push(flow);
  if (s.restricted) parts.push("restricted");
  return `- ${parts.join(" — ")}`;
}

// The full text of one AI search page: true counts, grade-grouped spread results, and what the next page costs.
export async function aiSearchText(searches: AiSearches, memory: Memory, q: AiQuery, o: Ordering, page: number, limit: number): Promise<string> {
  const start = (page - 1) * limit;
  const inScope = (i: AiItem) => !o.excluded.has(i.appId);
  const { state, run } = await searches.ensure<Graded<Screen> | Graded<Flow>>(q, start + limit, inScope);
  const noun = q.contentType;
  const cap = noun === "screens" ? SCREENS_PER_APP : FLOWS_PER_APP;
  const ordered = state.batches.flatMap((b) => arrangeBatch(b.filter(inScope), cap, o));
  const shown = ordered.slice(start, start + limit);

  const all = state.batches.flat();
  const what = `${quote(q.query)}${q.textInScreenshotQuery ? ` with on-screen text ${quote(q.textInScreenshotQuery)}` : ""} (${q.platform})`;
  const batches = state.batches.length > 1 ? ` in ${state.batches.length} batches` : "";
  const counts = gradeCounts(all);
  const apps = new Set(ordered.map((i) => i.appId)).size;
  const hidden = all.length - ordered.length;
  const kept = `kept ${all.length}${counts ? ` (${counts})` : ""} from ${apps} apps${hidden ? `; ${hidden} from excluded apps hidden` : ""}`;
  const showing = shown.length ? `Showing ${start + 1}–${start + shown.length}.` : `Nothing to show from ${start + 1} on.`;
  const cost = run
    ? `This call ran 1 AI batch: ${run.costUsd === null ? "cost not reported by Mobbin (~$0.016)" : `$${run.costUsd.toFixed(4)}`} of Mobbin AI credits, ${(run.ms / 1000).toFixed(1)} s.`
    : "Served from cache: no AI cost.";
  const header = `Mobbin AI checked ${state.evaluated.size} candidate ${noun} for ${what}${batches}, ${kept}. ${showing} ${cost}\n${orderNote(o, q.platform, cap, noun, "within each grade")}`;

  let body: string;
  if (q.contentType === "screens") {
    const screens = shown as Graded<Screen>[];
    memory.rememberScreens(screens);
    body = groupByGrade(screens, (s) => formatAiScreen(s, memory, o), "\n");
  } else {
    const flows = shown as Graded<Flow>[];
    memory.rememberFlows(flows);
    body = groupByGrade(flows, (f) => flowLine(f, o), "\n");
  }

  const footer: string[] = [];
  const end = start + shown.length;
  if (shown.length < limit && !state.end) {
    footer.push(`This page has ${shown.length} of ${limit}: page=${page} again runs another AI batch (${AI_BATCH_COST}) to fill it.`);
  } else if (ordered.length >= end + limit || (ordered.length > end && state.end)) {
    footer.push(`Next: page=${page + 1} (cached, no AI cost).`);
  } else if (!state.end) {
    footer.push(`Next: page=${page + 1} runs a new AI batch (${AI_BATCH_COST}) over unchecked candidates.`);
  } else {
    footer.push(`No more results: ${state.end}.`);
  }
  footer.push(
    noun === "screens"
      ? "Images: mobbin_get_screen_images with the screen URLs you pick. A promising app: mobbin_open_app lists all its flows, free."
      : "Steps: mobbin_open_flow with a flow id. A promising app: mobbin_open_app lists all its flows, free.",
  );
  return `${header}\n\n${body || `(no ${noun})`}\n\n${footer.join(" ")}`;
}

// ---------- open app: one app's whole catalogue, ranked against a query ----------

const MATCHING_SCREENS_SHOWN = 3;
const TAGS_IN_SUMMARY = 12;

export function openAppText(content: AppContent, cat: Catalog, query: string | null, page: number, limit: number): string {
  const { app } = content;
  const tagged = content.screens.size === content.screenCount ? "" : ` (tags read for ${content.screens.size})`;
  const head = `${app.appName} (${app.platform}), app id ${app.id}: ${content.flowCount} flows, ${content.screenCount} screens on Mobbin${tagged}. Read from the app's Mobbin page: free, no AI cost.`;
  const tags = tagSummary(content, TAGS_IN_SUMMARY);
  const tagLine = `Screen tags (screens per tag): patterns: ${tags.patterns || "none"}; elements: ${tags.elements || "none"}.`;
  const flowName = (f: Flow) => `${f.name} (${f.screens.length})`;

  if (!query) {
    const lines = content.flows.map((f, i) => `${i + 1}. ${f.name} (${f.screens.length} steps)${f.actions.length ? ` — ${f.actions.join(", ")}` : ""}`);
    return [
      head,
      `All ${content.flows.length} flows, Mobbin's order (name, steps, action tags):`,
      ...lines,
      "",
      tagLine,
      `Next: query ranks these flows and their screens against an idea; mobbin_open_flow with app "${app.appName}" and a flow name gives its steps.`,
    ].join("\n");
  }

  const q = parseRankQuery(query, rankTags(cat, app.platform), app.appName);
  const ranked = rankFlows(q, content.flows, content.screens);
  const start = (page - 1) * limit;
  const shown = ranked.slice(start, start + limit);
  const out = [
    `${head} ${ranked.length} of ${content.flows.length} flows match ${quote(query)}, best first${ranked.length ? `; showing ${shown.length ? `${start + 1}–${start + shown.length}` : `none from ${start + 1}`}` : ""}.`,
  ];
  shown.forEach(({ flow, matches }, i) => {
    out.push(`${start + i + 1}. ${flow.name} — ${flow.screens.length} steps — flow ${flow.id}`);
    if (flow.actions.length) out.push(`   actions: ${flow.actions.join(", ")}`);
    out.push(`   matched: ${describeMatches(q, matches)}`);
    const hits = flow.screens
      .map((st) => ({ st, m: screenMatches(q, content.screens.get(st.screenId)) }))
      .filter((x) => x.m.size)
      .slice(0, MATCHING_SCREENS_SHOWN)
      .map(({ st, m }) => `step ${st.order + 1} ${screenUrl(st.screenId)} (${[...new Set(m.values())].join(", ")})`);
    if (hits.length) out.push(`   screens: ${hits.join("; ")}`);
  });
  if (!ranked.length) out.push(`No flow name, action or screen tag in ${app.appName} matches ${quote(query)}; try other words, or read the flow names below.`);

  const inFlows = new Set(content.flows.flatMap((f) => f.screens.map((s) => s.screenId)));
  const loose = [...content.screens.values()].filter((s) => !inFlows.has(s.id) && screenMatches(q, s).size);
  if (loose.length) {
    out.push(`Matching screens in no flow: ${loose.slice(0, 5).map((s) => `${screenUrl(s.id)} (${[...new Set(screenMatches(q, s).values())].join(", ")})`).join("; ")}${loose.length > 5 ? ` (+${loose.length - 5} more)` : ""}.`);
  }

  const shownIds = new Set(shown.map((r) => r.flow.id));
  const rest = content.flows.filter((f) => !shownIds.has(f.id));
  out.push("", `${shown.length ? "Other" : "All"} flows (name, steps): ${rest.map(flowName).join(" · ")}`, "", tagLine);
  const next: string[] = [];
  if (ranked.length > start + shown.length) next.push(`page=${page + 1} for more matching flows (free)`);
  next.push(`mobbin_open_flow with a flow id (or app "${app.appName}" and a flow name) for its steps`);
  next.push("mobbin_get_screen_images for screens");
  out.push(`Next: ${next.join("; ")}.`);
  return out.join("\n");
}

// ---------- schemas ----------

const platformSchema = z.enum(["ios", "android", "web"]).default("ios").describe("Platform: ios, android or web. Default ios.");
const modeSchema = z
  .enum(["ai", "fast"])
  .default("ai")
  .describe(
    '"ai" (default): Mobbin\'s AI judges each candidate and keeps only relevant ones, graded and described; each new batch costs ~$0.016 of the user\'s Mobbin AI credits and ~10 s. "fast": plain ranking, instant, free, noisier. Applies to free-text `query` only.',
  );
const preferSchema = z
  .enum(["distinctive", "popular"])
  .default("distinctive")
  .describe(
    '"distinctive" (default): apps outside Mobbin\'s ~120 most popular for the platform come first and popular ones are marked (popular). "popular": Mobbin\'s order, which favours the best-known apps.',
  );
const excludeAppsSchema = z
  .array(z.string())
  .optional()
  .describe('Exact app names to leave out, e.g. ["ChatGPT", "Notion"]: apps already studied or that the user wants to avoid.');
const appCategoriesSchema = z
  .array(z.string())
  .optional()
  .describe('App category tags, e.g. ["Finance"]. Exact names from mobbin_lookup_tags kind app_categories. Switches to tag-filter mode.');
const pageSchema = z.number().int().min(1).default(1).describe("1-based page number. Each response says whether the next page is free or costs a new AI batch.");

// Unknown arguments fail instead of being silently dropped: the message names the tool's real
// parameters and, for a known leftover, the tool that takes it.
function strictInput<S extends z.ZodRawShape>(tool: string, shape: S, redirect: Record<string, string> = {}) {
  return z.strictObject(shape, {
    error: (iss) => {
      if (iss.code !== "unrecognized_keys") return undefined;
      const keys = iss.keys as string[];
      const hints = [...new Set(keys.map((k) => redirect[k]).filter(Boolean))];
      return (
        `Unknown argument${keys.length > 1 ? "s" : ""} ${keys.map(quote).join(", ")} for ${tool}, which takes: ${Object.keys(shape).join(", ")}.` +
        (hints.length ? ` ${hints.join(" ")}` : "")
      );
    },
  });
}

// The cross-app searches have no app parameter: one app's content comes from mobbin_open_app.
const APP_REDIRECT = {
  app: 'To look inside one app, call mobbin_open_app {"app": "<exact name or id>", "platform": "<ios|android|web>", "query": "<what you want to see>"}: free, and it lists every flow of the app.',
};

// ---------- registration ----------

// One user's tool state: their Mobbin client, what their searches taught us about screens and flows,
// and their cached AI searches. Lives across requests; each request registers the tools on a fresh McpServer.
export interface ToolContext {
  client: MobbinClient;
  memory: Memory;
  ai: AiSearches;
}

export function createToolContext(client: MobbinClient): ToolContext {
  return { client, memory: new Memory(), ai: new AiSearches(client) };
}

const APP_SORT = { popular: "popularity", latest: "publishedAt", rating: "rating" } as const;
const SITE_SORT = { popular: "popularity", latest: "publishedAt" } as const;

export function registerTools(server: McpServer, { client, memory, ai }: ToolContext) {
  const annotations = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    "mobbin_find_apps",
    {
      title: "Find Mobbin apps",
      description:
        "Start here to choose apps to study. Searches Mobbin's app library and returns one line per app: name, tagline, platform, rating when Mobbin has one, and the app id that mobbin_open_app takes. Free, no AI cost, 24 apps per page. " +
        "`query` is free text over app names and descriptions (e.g. \"AI app builder\"); without it, apps are listed by `sort`, optionally within `app_categories`. " +
        "Apps among Mobbin's ~120 most popular for the platform are marked (popular), and with `prefer` \"distinctive\" (default) each page lists them after the rest: the best-known app is rarely the only good reference, so open a few. Next: mobbin_open_app.",
      inputSchema: strictInput("mobbin_find_apps", {
        query: z.string().optional().describe('What the app is or does, e.g. "AI app builder". Not combinable with app_categories.'),
        app_categories: z.array(z.string()).optional().describe('App category tags, e.g. ["AI"]. Exact names from mobbin_lookup_tags kind app_categories.'),
        platform: platformSchema,
        sort: z
          .enum(["popular", "latest", "rating"])
          .default("popular")
          .describe('Order without a query: "popular" (default), "latest" (newest on Mobbin), "rating". A query uses Mobbin\'s relevance order.'),
        prefer: preferSchema,
        page: z.number().int().min(1).default(1).describe("1-based page of 24 apps."),
      }),
      annotations,
    },
    (a) =>
      run(async () => {
        const query = a.query?.trim() || null;
        const cat = await client.tagCatalog();
        const c = resolveTags(cat, a.platform, "app_categories", a.app_categories);
        if (query && c.names) throw new InputError('query and app_categories can\'t be combined: Mobbin searches apps by text or by category. Example: {"app_categories": ["AI"], "platform": "web"}');
        const q: AppsQuery = query
          ? { contentType: "apps", platform: a.platform, type: "free_text_search", mode: "standard", query, textInScreenshotQuery: null, hasAnimation: null }
          : { contentType: "apps", platform: a.platform, type: "filters", activeFilterTags: [], categories: c.names, sortBy: APP_SORT[a.sort] };
        const [r, o] = await Promise.all([client.searchApps(q, a.page - 1), makeOrdering(client, a.platform, a.prefer, undefined)]);
        const apps = o.popular ? [...r.data.filter((x) => !o.popular!.has(x.id)), ...r.data.filter((x) => o.popular!.has(x.id))] : r.data;
        const what = query ? `matching ${quote(query)}` : `${c.names ? `in ${c.names.join(" + ")}, ` : ""}by ${a.sort}`;
        const start = (a.page - 1) * API_PAGE;
        const range = apps.length ? `${start + 1}–${start + apps.length}` : "none";
        const popularNote = o.popular ? ` Apps outside Mobbin's ${o.popularCount} most popular ${a.platform} apps first on this page.` : "";
        const notes = c.notes.length ? ` Note: ${c.notes.join("; ")}.` : "";
        const header = `${r.totalCount} ${a.platform} apps ${what}. Showing ${range}.${popularNote}${notes}`;
        const line = (x: AppSummary) =>
          `- ${x.appName}${popularMark(o, x.id)}${x.appTagline ? ` — ${x.appTagline}` : ""}${x.average_rating ? ` — rated ${x.average_rating.toFixed(1)}` : ""}${x.isRestricted ? " — restricted" : ""} — id ${x.id}`;
        const footer = [r.hasNextPage ? `Next: page=${a.page + 1}.` : "", "Open one: mobbin_open_app with the name or id (free: all its flows and screen tags)."].filter(Boolean);
        return text(`${header}\n${apps.map(line).join("\n") || "(no apps)"}\n${footer.join(" ")}`);
      }),
  );

  server.registerTool(
    "mobbin_open_app",
    {
      title: "Open a Mobbin app",
      description:
        "After mobbin_find_apps, or when the user names an app: opens that app's complete Mobbin catalogue, read from its app page: every flow (name, step count, action tags) and a summary of its screen tags. Free, no AI cost. " +
        "With `query`, the app's flows are ranked against it first (by words and tags in flow names, flow actions and the flows' screens), each with its flow id, what matched, and its best-matching screens; every other flow follows by name. " +
        "Use this rather than the search tools whenever you know which app to look at: they rank across all apps and return only a sliver of one app. Next: mobbin_open_flow for a flow's steps, mobbin_get_screen_images for screens.",
      inputSchema: strictInput("mobbin_open_app", {
        app: z.string().describe('Exact app name (e.g. "Base44") or the app id from mobbin_find_apps.'),
        platform: platformSchema,
        query: z.string().optional().describe('What you want to see in this app, e.g. "agent building the app in chat". Omit to list every flow.'),
        page: z.number().int().min(1).default(1).describe("1-based page of matching flows."),
        limit: z.number().int().min(1).max(30).default(8).describe("Matching flows per page. Default 8, max 30."),
      }),
      annotations,
    },
    (a) =>
      run(async () => {
        const app = await resolveApp(client, a.platform, a.app);
        const [content, cat] = await Promise.all([client.appContent(app), client.tagCatalog()]);
        memory.rememberApp(content);
        return text(openAppText(content, cat, a.query?.trim() || null, a.page, a.limit));
      }),
  );

  server.registerTool(
    "mobbin_open_flow",
    {
      title: "Open a Mobbin flow",
      description:
        "After mobbin_open_app or mobbin_search_flows: one flow's ordered steps, each with its screen id, its pattern/element tags when known, and where the user tapped, in words; plus the flow's app, platform and action tags. Free. " +
        "Pass the flow id those tools printed, or the exact flow name together with `app`. Next: mobbin_get_screen_images with the step screen ids you want to see.",
      inputSchema: strictInput("mobbin_open_flow", {
        flow: z.string().describe('Flow id (or https://mobbin.com/flows/<id>), or the exact flow name with `app`, e.g. "Creating an app with AI".'),
        app: z.string().optional().describe("Exact app name or app id; needed only when `flow` is a name."),
        platform: platformSchema,
      }),
      annotations,
    },
    (a) =>
      run(async () => {
        const id = UUID_RE.exec(a.flow)?.[0]?.toLowerCase();
        if (id) {
          const known = memory.flows.get(id);
          if (!known) {
            throw new InputError(
              `Flow ${id} hasn't come up in this session, so its steps aren't known. Open its app first (mobbin_open_app), or find it with mobbin_search_flows, then call again; or pass the flow's exact name with app.`,
            );
          }
          memory.rememberFlows([known]); // its screens' flow context now names this flow
          return text(formatFlow(known, memory));
        }
        if (!a.app) throw new InputError(`"${a.flow}" is not a flow id; to open a flow by name, also pass app. Example: {"flow": "Creating an app with AI", "app": "Base44", "platform": "web"}`);
        const app = await resolveApp(client, a.platform, a.app);
        const content = await client.appContent(app);
        memory.rememberApp(content);
        const hit = content.flows.find((f) => norm(f.name) === norm(a.flow));
        if (!hit) {
          const want = new Set(words(a.flow).map(stem));
          const close = content.flows.filter((f) => words(f.name).some((w) => want.has(stem(w)))).slice(0, 8);
          throw new InputError(
            `${app.appName} (${app.platform}) has no flow named "${a.flow}".` +
              (close.length ? ` Flows sharing a word: ${close.map((f) => f.name).join(", ")}.` : "") +
              ` mobbin_open_app lists all ${content.flows.length}.`,
          );
        }
        const flow = memory.flows.get(hit.id) ?? hit;
        memory.rememberFlows([flow]);
        return text(formatFlow(flow, memory));
      }),
  );

  server.registerTool(
    "mobbin_search_screens",
    {
      title: "Search screens across apps",
      description:
        "Cross-app search: finds real screens matching a UI idea across all Mobbin apps and returns a compact list, one line per screen: app, screen URL, Mobbin AI's one-line description, tags, flow step when known. Use it to compare how different apps solve the same screen; when a promising app turns up, mobbin_open_app lists that app's whole catalogue for free. " +
        "Mobbin's own order favours its most popular apps, so by default (`prefer` \"distinctive\") less-mainstream apps come first within each grade, Mobbin's ~120 most popular apps are marked (popular), and a page shows at most 2 screens per app before an app repeats. Compare several apps rather than stopping at the first big name; a second query from a different angle is fine, and `exclude_apps` hides apps already seen. " +
        "mode \"ai\" (default): Mobbin's AI checks ~90 candidates per batch for `query` and keeps relevant ones as Strong matches (grade 3) and Related (grade 2); each batch costs ~$0.016 of the user's Mobbin AI credits and ~10 s, paging through fetched results is free, and each response says whether the next page needs a new batch. mode \"fast\": plain word ranking, instant, free, noisier. " +
        "Tag filters `patterns`, `elements`, `app_categories` (exact names from mobbin_lookup_tags) replace `query`, ignore `mode`, and report a true total. `on_screen_text` matches words visible in the screenshot. No images here: mobbin_get_screen_images for the few you pick.",
      inputSchema: strictInput("mobbin_search_screens", {
        query: z.string().optional().describe('What the screen shows, in plain words, e.g. "device pairing screen". Ignored when tags are given.'),
        on_screen_text: z.string().optional().describe('Words that appear in the screenshot itself, e.g. "pair" or "Face ID".'),
        patterns: z.array(z.string()).optional().describe('Screen pattern tags, e.g. ["Login"]. Exact names from mobbin_lookup_tags.'),
        elements: z.array(z.string()).optional().describe('UI element tags, e.g. ["Bottom Sheet"]. Exact names from mobbin_lookup_tags.'),
        app_categories: appCategoriesSchema,
        exclude_apps: excludeAppsSchema,
        prefer: preferSchema,
        mode: modeSchema,
        platform: platformSchema,
        page: pageSchema,
        limit: z.number().int().min(1).max(40).default(15).describe("Screens per page. Default 15, max 40."),
      }, APP_REDIRECT),
      annotations,
    },
    (a) =>
      run(async () => {
        const cat = await client.tagCatalog();
        const p = resolveTags(cat, a.platform, "patterns", a.patterns);
        const e = resolveTags(cat, a.platform, "elements", a.elements);
        const c = resolveTags(cat, a.platform, "app_categories", a.app_categories);
        const query = a.query?.trim() || null;
        const ocr = a.on_screen_text?.trim() || null;
        const filterMode = Boolean(p.names || e.names || c.names || (!query && ocr));
        if (!filterMode && !query) {
          throw new InputError('Give at least one of query, on_screen_text, patterns, elements, app_categories. Example: {"query": "device pairing screen", "on_screen_text": "pair"}');
        }
        const o = await makeOrdering(client, a.platform, a.prefer, a.exclude_apps);
        if (!filterMode && a.mode === "ai") {
          const q: AiQuery = { contentType: "screens", platform: a.platform, type: "free_text_search", mode: "deep", query: query!, textInScreenshotQuery: ocr, hasAnimation: null };
          return text(await aiSearchText(ai, memory, q, o, a.page, a.limit));
        }
        const q = filterMode
          ? {
              contentType: "screens" as const,
              platform: a.platform,
              type: "filters" as const,
              activeFilterTags: [] as [],
              categories: c.names,
              screenElements: e.names,
              screenPatterns: p.names,
              textInScreenshotQuery: ocr,
              hasAnimation: null,
              sortBy: "trending" as const,
            }
          : ({
              contentType: "screens",
              platform: a.platform,
              type: "free_text_search",
              mode: "standard",
              query: query!,
              textInScreenshotQuery: ocr,
              hasAnimation: null,
            } satisfies FreeTextQuery);

        const desc = [
          filterMode ? `tags ${[...(p.names ?? []), ...(e.names ?? []), ...(c.names ?? [])].join(" + ") || "(none)"}` : `free text ${quote(query!)}`,
          ocr ? `on-screen text ${quote(ocr)}` : "",
          a.platform,
        ].filter(Boolean);
        const notes = [...p.notes, ...e.notes, ...c.notes];
        if (filterMode && query) notes.push(`query ${quote(query)} not used in tag mode`);

        // Fast free-text results carry few tags; the matching flows (same query) name what a
        // screen is part of, so their steps annotate any screen that appears in both.
        const flowContext = () =>
          q.type === "free_text_search"
            ? client.searchFlows({ ...q, contentType: "flows", textInScreenshotQuery: null }, 0).then((r) => memory.rememberFlows(r.data))
            : Promise.resolve();

        const start = (a.page - 1) * a.limit;
        const [r] = await Promise.all([apiSlice((i) => client.searchScreens(q, i), start, a.limit), flowContext()]);
        const kept = r.items.filter((s) => !o.excluded.has(s.appId));
        const items = spread(kept, SCREENS_PER_APP, o.popular);
        memory.rememberScreens(items);
        const range = r.items.length ? `${start + 1}–${start + r.items.length}` : "none";
        const hidden = r.items.length - kept.length;
        let header: string;
        if (filterMode) {
          header = `${r.total} screens (${desc.join(", ")}). Rows ${range} in Mobbin's trending order${hidden ? `, ${hidden} from excluded apps hidden` : ""}.`;
        } else {
          // Mobbin's free-text count is a cap, not a count, so none is printed.
          const tagged = items.filter((s) => s.screenPatterns?.length || s.screenElements?.length).length;
          header = `Fast mode, ranked results, page ${a.page} (${desc.join(", ")}): rows ${range}, ${tagged} tagged${hidden ? `, ${hidden} from excluded apps hidden` : ""}.`;
        }
        if (notes.length) header += ` Note: ${notes.join("; ")}.`;
        header += `\n${orderNote(o, a.platform, SCREENS_PER_APP, "screens", "within this page")}`;
        const footer: string[] = [];
        if (r.hasMore) footer.push(`Next: page=${a.page + 1}.`);
        footer.push("Images: mobbin_get_screen_images with the screen URLs you pick. A promising app: mobbin_open_app, free.");
        return text(`${header}\n${formatScreenList(items, memory, o) || "(no screens)"}\n${footer.join(" ")}`);
      }),
  );

  server.registerTool(
    "mobbin_search_flows",
    {
      title: "Search flows across apps",
      description:
        "Cross-app search for multi-step user flows (onboarding, checkout, device pairing…) across all Mobbin apps: one line per flow with its app, name, step count, action tags, Mobbin AI's one-line description, and the flow id for mobbin_open_flow, which gives the steps. Use it when the sequence matters and you want to compare apps; once an app looks promising, mobbin_open_app lists all its flows for free. " +
        "Mobbin's own order favours its most popular apps, so by default (`prefer` \"distinctive\") less-mainstream apps come first within each grade, Mobbin's ~120 most popular apps are marked (popular), and a page shows 1 flow per app before an app repeats. Compare several apps rather than stopping at the first big name; a second query from a different angle is fine, and `exclude_apps` hides apps already seen. " +
        "mode \"ai\" (default): Mobbin's AI checks ~25 candidate flows per batch for `query` and keeps relevant ones as Strong matches (grade 3) and Related (grade 2); each batch costs ~$0.016 of the user's Mobbin AI credits and ~10 s, paging through fetched results is free, and each response says whether the next page needs a new batch. mode \"fast\": plain ranking, instant, free, noisier. " +
        "`actions` (flow action tags such as \"Connecting & Linking\", exact names from mobbin_lookup_tags kind flow_actions) and `app_categories` switch to tag-filter mode, replace `query`, ignore `mode`, and report a true total.",
      inputSchema: strictInput("mobbin_search_flows", {
        query: z.string().optional().describe('What the flow does, in plain words, e.g. "pairing a bluetooth device". Ignored when tags are given.'),
        actions: z.array(z.string()).optional().describe('Flow action tags, e.g. ["Connecting & Linking"]. Exact names from mobbin_lookup_tags.'),
        app_categories: appCategoriesSchema,
        exclude_apps: excludeAppsSchema,
        prefer: preferSchema,
        mode: modeSchema,
        platform: platformSchema,
        page: pageSchema,
        limit: z.number().int().min(1).max(30).default(10).describe("Flows per page. Default 10, max 30."),
      }, APP_REDIRECT),
      annotations,
    },
    (a) =>
      run(async () => {
        const cat = await client.tagCatalog();
        const act = resolveTags(cat, a.platform, "flow_actions", a.actions);
        const c = resolveTags(cat, a.platform, "app_categories", a.app_categories);
        const query = a.query?.trim() || null;
        const filterMode = Boolean(act.names || c.names);
        if (!filterMode && !query) {
          throw new InputError('Give query, actions, or app_categories. Example: {"query": "pairing a bluetooth device"}');
        }
        const o = await makeOrdering(client, a.platform, a.prefer, a.exclude_apps);
        if (!filterMode && a.mode === "ai") {
          const q: AiQuery = { contentType: "flows", platform: a.platform, type: "free_text_search", mode: "deep", query: query!, textInScreenshotQuery: null, hasAnimation: null };
          return text(await aiSearchText(ai, memory, q, o, a.page, a.limit));
        }
        const q = filterMode
          ? {
              contentType: "flows" as const,
              platform: a.platform,
              type: "filters" as const,
              activeFilterTags: [] as [],
              categories: c.names,
              flowActions: act.names,
              sortBy: "trending" as const,
            }
          : ({
              contentType: "flows",
              platform: a.platform,
              type: "free_text_search",
              mode: "standard",
              query: query!,
              textInScreenshotQuery: null,
              hasAnimation: null,
            } satisfies FreeTextQuery);
        const desc = [
          filterMode ? `tags ${[...(act.names ?? []), ...(c.names ?? [])].join(" + ")}` : `free text ${quote(query!)}`,
          a.platform,
        ].join(", ");
        const notes = [...act.notes, ...c.notes];
        if (filterMode && query) notes.push(`query ${quote(query)} not used in tag mode`);

        const start = (a.page - 1) * a.limit;
        const r = await apiSlice((i) => client.searchFlows(q, i), start, a.limit);
        const kept = r.items.filter((f) => !o.excluded.has(f.appId));
        const items = spread(kept, FLOWS_PER_APP, o.popular);
        memory.rememberFlows(items);
        const range = r.items.length ? `${start + 1}–${start + r.items.length}` : "none";
        const hidden = r.items.length - kept.length;
        const hiddenNote = hidden ? `, ${hidden} from excluded apps hidden` : "";
        // Mobbin's free-text count is a cap, not a count, so fast mode prints none.
        let header = filterMode
          ? `${r.total} flows (${desc}). Rows ${range} in Mobbin's trending order${hiddenNote}.`
          : `Fast mode, ranked results, page ${a.page} (${desc}): rows ${range}${hiddenNote}.`;
        if (notes.length) header += ` Note: ${notes.join("; ")}.`;
        header += `\n${orderNote(o, a.platform, FLOWS_PER_APP, "flows", "within this page")}`;
        const footer: string[] = [];
        if (r.hasMore) footer.push(`Next: page=${a.page + 1}.`);
        footer.push("Steps: mobbin_open_flow with a flow id. A promising app: mobbin_open_app, free.");
        return text(`${header}\n\n${items.map((f) => flowLine(f, o)).join("\n") || "(no flows)"}\n\n${footer.join(" ")}`);
      }),
  );

  server.registerTool(
    "mobbin_find_sites",
    {
      title: "Find Mobbin websites",
      description:
        "Start here for marketing-website references (landing, pricing, about pages), not in-product app screens: searches Mobbin's websites library and returns one line per site with its name, tagline and URL. Free, 24 sites per page. " +
        "`query` is free text (e.g. \"fintech\"); without it, sites are listed by `sort`. For page sections across sites (hero, pricing table, footer…) use mobbin_search_sections; for apps use mobbin_find_apps.",
      inputSchema: strictInput("mobbin_find_sites", {
        query: z.string().optional().describe('What the company or site is about, e.g. "AI note taking". Omit to browse by sort.'),
        sort: z.enum(["popular", "latest"]).default("popular").describe('Order without a query: "popular" (default) or "latest" (newest on Mobbin).'),
        page: z.number().int().min(1).default(1).describe("1-based page of 24 sites."),
      }),
      annotations,
    },
    (a) =>
      run(async () => {
        const query = a.query?.trim() || null;
        const q: SitesQuery = query
          ? { contentType: "sites", type: "free_text_search", mode: "standard", query }
          : { contentType: "sites", type: "filters", activeFilterTags: [], categories: null, styles: null, pageAndSectionPatterns: null, sortBy: SITE_SORT[a.sort] };
        const r = await client.searchSites(q, a.page - 1);
        const start = (a.page - 1) * API_PAGE;
        const range = r.data.length ? `${start + 1}–${start + r.data.length}` : "none";
        const line = (s: Site) =>
          `- ${s.name}${s.tagline ? ` — ${s.tagline.trim()}` : ""}${s.url ? ` — ${s.url}` : ""}${s.is_defunct ? " — defunct" : ""}${s.isRestricted ? " — restricted" : ""}`;
        const footer = [r.hasNextPage ? `Next: page=${a.page + 1}.` : "", "Sections across sites: mobbin_search_sections."].filter(Boolean);
        return text(`${r.totalCount} sites ${query ? `matching ${quote(query)}` : `by ${a.sort}`}. Showing ${range}.\n${r.data.map(line).join("\n") || "(no sites)"}\n${footer.join(" ")}`);
      }),
  );

  server.registerTool(
    "mobbin_search_sections",
    {
      title: "Search website sections",
      description:
        "Searches sections of marketing websites (hero, pricing table, testimonials, footer…) across Mobbin's websites library: one line per section with its site, section tags, page URL when known, and a section id that mobbin_get_screen_images accepts. Free. " +
        "`query` is free text (e.g. \"pricing table\"); `patterns` (exact section names from mobbin_lookup_tags kind sections) filter instead and follow `sort`. For in-app screens use mobbin_search_screens.",
      inputSchema: strictInput("mobbin_search_sections", {
        query: z.string().optional().describe('What the section shows, e.g. "pricing table with monthly toggle". Ignored when patterns are given.'),
        patterns: z.array(z.string()).optional().describe('Website section tags, e.g. ["Pricing"]. Exact names from mobbin_lookup_tags kind sections.'),
        sort: z.enum(["popular", "trending"]).default("popular").describe('Order for pattern filters: "popular" (default) or "trending".'),
        page: z.number().int().min(1).default(1).describe("1-based page number."),
        limit: z.number().int().min(1).max(40).default(15).describe("Sections per page. Default 15, max 40."),
      }),
      annotations,
    },
    (a) =>
      run(async () => {
        const query = a.query?.trim() || null;
        const s = resolveTags(await client.tagCatalog(), "web", "sections", a.patterns);
        if (!query && !s.names) throw new InputError('Give query or patterns. Example: {"query": "pricing table"}');
        const q: SectionsQuery = s.names
          ? {
              contentType: "sections",
              type: "filters",
              activeFilterTags: [],
              categories: null,
              styles: null,
              pageAndSectionPatterns: s.names,
              textInScreenshotQuery: null,
              sortBy: a.sort === "popular" ? "popularity" : "trending",
            }
          : { contentType: "sections", type: "free_text_search", mode: "standard", query: query!, textInScreenshotQuery: null };
        const start = (a.page - 1) * a.limit;
        const r = await apiSlice((i) => client.searchSections(q, i), start, a.limit);
        memory.rememberSections(r.items);
        const range = r.items.length ? `${start + 1}–${start + r.items.length}` : "none";
        const notes = [...s.notes];
        if (s.names && query) notes.push(`query ${quote(query)} not used with patterns`);
        // A free-text total is Mobbin's cap, not a count.
        const header = s.names
          ? `${r.total} sections tagged ${s.names.join(" + ")}, by ${a.sort}. Showing ${range}.`
          : `Sections matching ${quote(query!)}, Mobbin's ranking: rows ${range}.`;
        const line = (x: Section) =>
          `- ${x.site_version.site.name} — ${x.patterns.join(", ") || "untagged"}${x.page_url ? ` — ${x.page_url}` : ""}${x.restricted ? " — restricted" : ""} — section ${x.id}`;
        const footer = [r.hasMore ? `Next: page=${a.page + 1}.` : "", "Images: mobbin_get_screen_images with section ids."].filter(Boolean);
        return text(`${header}${notes.length ? ` Note: ${notes.join("; ")}.` : ""}\n${r.items.map(line).join("\n") || "(no sections)"}\n${footer.join(" ")}`);
      }),
  );

  server.registerTool(
    "mobbin_lookup_tags",
    {
      title: "Look up Mobbin tags",
      description:
        "Maps a UI intent to Mobbin's exact tag names, with definitions, synonyms and content counts: screen patterns (Login, Subscription & Paywall…), UI elements (Button, Bottom Sheet…), flow actions (Creating Account…), app categories (Finance, AI…), and website sections, categories and styles. Synonyms are accepted by the other tools too (\"Sign In\" → Login). " +
        "Use it when you want tag filters: call it before passing tag names to any tool (patterns, elements, actions, app_categories, section patterns), since names must match exactly. With no query, lists every name of the chosen kind. " +
        "No match means Mobbin has no tag for the idea: search it as free text instead.",
      inputSchema: strictInput("mobbin_lookup_tags", {
        query: z.string().optional().describe('Intent in plain words, e.g. "sign in" or "pricing table". Omit to list all names.'),
        kind: z
          .enum(["all", ...ALL_KINDS] as ["all", ...TagKind[]])
          .default("all")
          .describe("Tag family: patterns, elements, flow_actions, app_categories (apps); sections, site_categories, site_styles (websites). Default all."),
        platform: platformSchema,
        limit: z.number().int().min(1).max(40).default(10).describe("Max matches returned for a query. Default 10."),
      }),
      annotations: { ...annotations, openWorldHint: false },
    },
    (a) =>
      run(async () => {
        const kinds: TagKind[] = a.kind === "all" ? ALL_KINDS : [a.kind];
        return text(lookupTags(await client.tagCatalog(), a.platform, kinds, a.query, a.limit));
      }),
  );

  server.registerTool(
    "mobbin_get_screen_images",
    {
      title: "Get Mobbin screen images",
      description:
        "Last step: loads the screenshots of screens (or website sections) you have picked from the other tools. Use it when you need to see a few chosen screens, never to browse. Accepts screen ids, https://mobbin.com/screens/… URLs, and section ids from mobbin_search_sections, up to 8 per call. " +
        "size 360w (default) is enough to judge layout; 720w to read small text; 1920w only for pixel-level detail.",
      inputSchema: strictInput("mobbin_get_screen_images", {
        screens: z.array(z.string()).min(1).max(8).describe("Screen ids, https://mobbin.com/screens/<id> URLs, or section ids."),
        size: z.enum(["360w", "720w", "1920w"]).default("360w").describe("Image width. Default 360w."),
      }),
      annotations,
    },
    (a) =>
      run(async () => {
        const content: CallToolResult["content"] = [];
        let ok = 0;
        for (const [i, ref] of a.screens.entries()) {
          const id = UUID_RE.exec(ref)?.[0]?.toLowerCase();
          if (!id) {
            content.push({ type: "text", text: `${i + 1}. "${ref}" is not a screen id or URL (expected https://mobbin.com/screens/<uuid>).` });
            continue;
          }
          try {
            let known = memory.screens.get(id);
            if (!known?.img) {
              const info = await client.screenInfo(id);
              const img = findImgSources(info);
              if (!img) throw new Error(`fetch-screen-info returned no image sources (keys: ${Object.keys((info ?? {}) as object).join(", ")})`);
              known = { ...known, appName: known?.appName ?? findString(info, "appName") ?? "unknown app", img };
              memory.screens.set(id, known);
            }
            const { url, got } = pickSize(known.img!, a.size);
            const image = await client.fetchImage(url);
            const flow = flowContext(known) ? ` — ${flowContext(known)}` : "";
            content.push({ type: "text", text: `${i + 1}. ${known.appName} — ${known.section ? `section ${id}` : screenUrl(id)}${flow} (${got})` });
            content.push({ type: "image", data: image.data, mimeType: image.mimeType });
            ok++;
          } catch (e) {
            content.push({ type: "text", text: `${i + 1}. ${screenUrl(id)}: ${(e as Error).message}` });
          }
        }
        return { content, isError: ok === 0 };
      }),
  );
}

function pickSize(img: ImgSources, size: string): { url: string; got: string } {
  const exact = img.srcSet.find((s) => s.descriptor === size);
  if (exact) return { url: exact.url, got: size };
  const want = parseInt(size, 10);
  const nearest = [...img.srcSet].sort((x, y) => Math.abs(parseInt(x.descriptor, 10) - want) - Math.abs(parseInt(y.descriptor, 10) - want))[0];
  return nearest ? { url: nearest.url, got: `${nearest.descriptor}, ${size} not offered` } : { url: img.src, got: "default size" };
}

function findImgSources(v: unknown): ImgSources | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const direct = o.screenCdnImgSources as ImgSources | undefined;
  if (direct?.srcSet) return direct;
  for (const child of Object.values(o)) {
    const hit = findImgSources(child);
    if (hit) return hit;
  }
  return null;
}

function findString(v: unknown, key: string): string | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o[key] === "string") return o[key] as string;
  for (const child of Object.values(o)) {
    const hit = findString(child, key);
    if (hit) return hit;
  }
  return null;
}
