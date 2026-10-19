// Deterministic ranking of one app's own flows and screens against a query: query words (stemmed)
// and the tags whose names or synonyms carry them, matched against flow names, flow actions, and the
// pattern/element tags of each flow's screens. No AI, no network.
import type { AppContent, AppScreen, Flow, Tag } from "./api.js";
import { stem, words } from "./text.js";

const FUNCTION_WORDS = new Set(
  "a an and are as at be by for from how i in into is it its me my of on or our that the their them they this to us was we what when where which while who with you your screen screens page pages flow flows ui ux".split(" "),
);

// Everyday verbs for Mobbin's flow-action vocabulary, whose tags carry almost no synonyms of their own
// (e.g. "building the app" should reach "Creating an app" and the "Adding & Creating" action).
const EQUIVALENT = [
  ["build", "create", "make", "generate"],
  ["delete", "remove"],
  ["search", "find"],
  ["buy", "purchase"],
  ["edit", "modify"],
].map((g) => g.map(stem));
const equivalents = (t: string) => EQUIVALENT.find((g) => g.includes(t)) ?? [t];
const hits = (stems: Set<string>, token: string) => equivalents(token).some((e) => stems.has(e));

const W_NAME = 3;
const W_ACTION = 2;
const W_SCREEN_TAG = 1;
const W_PHRASE = 3; // two adjacent query words adjacent in the flow name ("building the app" ~ "Creating an app")

const contentWords = (s: string) => words(s).filter((w) => !FUNCTION_WORDS.has(w));

export interface RankQuery {
  text: string;
  tokens: string[]; // distinct stems, query order
  wordOf: Map<string, string>; // stem → the query word it came from
  tagTokens: Map<string, Set<string>>; // tag display name → query stems its name or synonyms carry
}

// Words that say nothing about which part of an app is meant. They may still match flow names
// ("building the app" ~ "Creating an app"), but never reach a tag: "app" would match every screen
// tagged Top Navigation Bar through its synonym "App Bar".
const GENERIC = new Set(["app", "apps", "application", "applications"].map(stem));

// `tags`: the platform's pattern, element and flow-action tags from Mobbin's catalogue. Words of the
// app's own name ("Base44") are dropped: inside that app they match nothing in particular.
export function parseRankQuery(text: string, tags: Tag[], appName: string): RankQuery {
  const nameStems = new Set(words(appName).map(stem));
  const wordOf = new Map<string, string>();
  for (const w of contentWords(text)) if (!nameStems.has(stem(w)) && !wordOf.has(stem(w))) wordOf.set(stem(w), w);
  const tokens = [...wordOf.keys()];
  const tagTokens = new Map<string, Set<string>>();
  for (const tag of tags) {
    const stems = new Set([tag.displayName, ...tag.synonyms].flatMap(contentWords).map(stem));
    const carried = tokens.filter((t) => !GENERIC.has(t) && hits(stems, t));
    if (carried.length) tagTokens.set(tag.displayName, new Set(carried));
  }
  return { text, tokens, wordOf, tagTokens };
}

export interface Match {
  weight: number;
  via: string; // "name", 'action "Chatting & Sending Messages"', 'screen tag "Chat Bot"'
}

export interface RankedFlow {
  flow: Flow;
  score: number;
  matches: Map<string, Match>; // query stem → its best match in this flow
  strong: boolean; // matched by name or action, not only through its screens' tags
}

const tagsOn = (s: AppScreen | undefined) => (s ? [...s.screenPatterns, ...s.screenElements] : []);

// Query stems a screen's own pattern/element tags carry, with the tag that carries each.
export function screenMatches(q: RankQuery, s: AppScreen | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of tagsOn(s)) q.tagTokens.get(tag)?.forEach((t) => out.has(t) || out.set(t, tag));
  return out;
}

// Flows with at least one match, best first; ties keep Mobbin's order. Each query word counts once
// per flow, at its best field, weighted by how rare it is across the app's flows (IDF).
export function rankFlows(q: RankQuery, flows: Flow[], screens: Map<string, AppScreen>): RankedFlow[] {
  const rows = flows.map((flow, index) => {
    const matches = new Map<string, Match>();
    const offer = (t: string, weight: number, via: string) => {
      if ((matches.get(t)?.weight ?? 0) < weight) matches.set(t, { weight, via });
    };
    const nameStems = contentWords(flow.name).map(stem);
    const nameSet = new Set(nameStems);
    for (const t of q.tokens) if (hits(nameSet, t)) offer(t, W_NAME, "name");
    for (const action of flow.actions) {
      const actionStems = new Set(contentWords(action).map(stem));
      for (const t of q.tokens) if (hits(actionStems, t) || q.tagTokens.get(action)?.has(t)) offer(t, W_ACTION, `action "${action}"`);
    }
    for (const st of flow.screens) {
      for (const [t, tag] of screenMatches(q, screens.get(st.screenId))) offer(t, W_SCREEN_TAG, `screen tag "${tag}"`);
    }
    let phrases = 0;
    for (let i = 0; i + 1 < q.tokens.length; i++) {
      for (let j = 0; j + 1 < nameStems.length; j++) {
        if (equivalents(q.tokens[i]).includes(nameStems[j]) && equivalents(q.tokens[i + 1]).includes(nameStems[j + 1])) phrases++;
      }
    }
    return { flow, index, matches, phrases, score: 0, strong: [...matches.values()].some((m) => m.weight > W_SCREEN_TAG) };
  });
  const df = new Map<string, number>();
  for (const r of rows) for (const t of r.matches.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + flows.length / df.get(t)!);
  for (const r of rows) {
    r.score = [...r.matches].reduce((sum, [t, m]) => sum + m.weight * idf(t), 0) + r.phrases * W_PHRASE;
  }
  return rows
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ flow, score, matches, strong }) => ({ flow, score, matches, strong }));
}

// "building (name), chat (action "Chatting & Sending Messages")"
export function describeMatches(q: RankQuery, matches: Map<string, Match>): string {
  return q.tokens
    .filter((t) => matches.has(t))
    .map((t) => `${q.wordOf.get(t)} (${matches.get(t)!.via})`)
    .join(", ");
}

// The most used pattern and element tags across the app's screens, as "Name n" lists.
export function tagSummary(content: AppContent, top: number): { patterns: string; elements: string } {
  const count = (pick: (s: AppScreen) => string[]) => {
    const n = new Map<string, number>();
    for (const s of content.screens.values()) for (const t of pick(s)) n.set(t, (n.get(t) ?? 0) + 1);
    const ranked = [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = ranked.slice(0, top).map(([t, c]) => `${t} ${c}`).join(", ");
    return ranked.length > top ? `${shown} (+${ranked.length - top} more)` : shown;
  };
  return { patterns: count((s) => s.screenPatterns), elements: count((s) => s.screenElements) };
}
