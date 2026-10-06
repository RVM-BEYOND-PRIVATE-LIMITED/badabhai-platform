import { formatTimestamp } from "./format";

/**
 * The ENGINE VIEW's client-safe shapes and presenters. Pure, so every rule is testable in the
 * node env, and — the load-bearing half — importable by the live client components without
 * pulling `lib/match-engine.ts` (`server-only`, the module that calls `adminFetch`) toward the
 * browser bundle. The same split `ai-trace-view.ts` makes for the AI-calls filter bar.
 *
 * The interfaces below are what the screen RENDERS. `match-engine.ts` checks its Zod schemas
 * against them (`satisfies`), so the two cannot drift: a field dropped here or renamed there
 * fails typecheck rather than rendering `undefined` on a projector.
 *
 * ══ NOTHING HERE DECIDES ANYTHING ══════════════════════════════════════════════════════════
 * Feed order, tiers, the funnel counts and the "why" line are the SERVER's — the same code path
 * the worker feed runs. This module labels them and works out what CHANGED between two polls;
 * it never re-ranks, re-tiers or re-counts (invariant #9). A funnel that does not add up is
 * surfaced as a defect, not quietly balanced.
 */

// ---------------------------------------------------------------------------
// Shapes (mirrors the three `/admin/match/engine/*` responses)
// ---------------------------------------------------------------------------

export interface EngineRecentWorker {
  worker_id: string;
  /** The first 8 hex of the id — the ONLY handle this screen shows for a worker. */
  short_ref: string;
  created_at: string;
  trade_label: string | null;
}

export interface EngineSkill {
  skill_id: string;
  label: string;
  wants: boolean;
  months_bucketed: number;
  /** `derived_coarse` | `interview` | `ops` today; an open set here (see `skillSourceLabel`). */
  source: string;
}

export interface EngineFunnel {
  open_postings: number;
  reached_direct: number;
  reached_related: number;
  hidden: number;
  already_actioned: number;
}

export interface EngineCard {
  rank: number;
  job_posting_id: string;
  role_title: string;
  role_kind: string | null;
  city: string | null;
  match_tier: number;
  matched_skill_id: string;
  matched_skill_label: string | null;
  boosted: boolean;
  published_at: string | null;
  /** Server-written: `direct: <skill>` | `related: <skill> → <posted skill>`. Shown verbatim. */
  why: string;
}

export interface EngineWorker {
  worker_id: string;
  short_ref: string;
  skills: EngineSkill[];
  funnel: EngineFunnel;
  /** EXACT V1 feed order. Rendered as received, never sorted here. */
  cards: EngineCard[];
  card_cap: number;
  generated_at: string;
}

export interface EngineSkillRef {
  skill_id: string;
  label: string;
}

export interface EngineCandidate {
  rank: number;
  worker_id: string;
  short_ref: string;
  application_id: string;
  match_tier: number | null;
  effective_tier: number | null;
  skill_months: number | null;
  industry_months: number | null;
  last_worked_at: string | null;
  matched_skill_label: string | null;
}

export interface EnginePosting {
  job_posting_id: string;
  role_title: string;
  role_kind: string | null;
  status: string;
  city: string | null;
  posted_skills: EngineSkillRef[];
  related_skills: EngineSkillRef[];
  reach: { total: number; tier1: number; tier2: number };
  candidates: EngineCandidate[];
  tier_floor_months: number;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * A card's tier, in the demo's two words. 1 = matched on a skill the posting asked for, 2 = on a
 * related one (the same split `matchTierLabel` spells out on the posting pages). A tier this
 * build was not taught reads as itself rather than being forced into one of the two.
 */
export function tierBadgeLabel(tier: number | null): string {
  if (tier === 1) return "Direct";
  if (tier === 2) return "Related";
  return tier === null ? "—" : `Tier ${tier}`;
}

/** The badge's modifier class; an unknown tier is muted, never dressed as a direct match. */
export function tierBadgeTone(tier: number | null): "direct" | "related" | "unknown" {
  if (tier === 1) return "direct";
  if (tier === 2) return "related";
  return "unknown";
}

const SKILL_SOURCE_LABELS: Readonly<Record<string, string>> = {
  derived_coarse: "Derived",
  interview: "Interview",
  ops: "Ops",
};

/** Where a skill row came from. An unknown source is de-snaked, not dropped. */
export function skillSourceLabel(source: string): string {
  return SKILL_SOURCE_LABELS[source] ?? deSnake(source);
}

/** `24` → "24 months"; the API buckets the figure, so it is labelled as approximate. */
export function monthsLabel(months: number | null): string {
  if (months === null) return "—";
  if (months === 0) return "under a month";
  return `~${months} ${months === 1 ? "month" : "months"}`;
}

/** A role kind for the art slot's caption: `machine_operator` → "Machine operator". */
export function roleKindLabel(kind: string | null): string {
  return kind ? deSnake(kind) : "Role";
}

/** `2026-09-30T10:12:00Z` → `2026-09-30`. The picker's created date. */
export function dateOnly(iso: string): string {
  const ts = formatTimestamp(iso);
  return ts === "—" ? ts : ts.slice(0, 10);
}

/** `2026-09-30T10:12:03.456Z` → `10:12:03 UTC`. The live indicator's last-updated time. */
export function clockTime(iso: string): string {
  const ts = formatTimestamp(iso);
  return ts === "—" ? ts : `${ts.slice(11, 19)} UTC`;
}

function deSnake(s: string): string {
  const words = s.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : s;
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

export type FunnelKey = "open_postings" | "reached_direct" | "reached_related" | "hidden";

export interface FunnelStep {
  key: FunnelKey;
  label: string;
  blurb: string;
  value: number;
  /** Share of open postings, 0..100, for the bar's width. 0 when there are no open postings. */
  share: number;
}

/** The four steps, top to bottom, as the centre column draws them. */
export function funnelSteps(f: EngineFunnel): FunnelStep[] {
  const pct = (n: number) =>
    f.open_postings > 0 ? Math.max(0, Math.min(100, (n / f.open_postings) * 100)) : 0;
  return [
    {
      key: "open_postings",
      label: "Open postings",
      blurb: "Every posting live right now",
      value: f.open_postings,
      share: f.open_postings > 0 ? 100 : 0,
    },
    {
      key: "reached_direct",
      label: "Direct",
      blurb: "Asks for a skill they have",
      value: f.reached_direct,
      share: pct(f.reached_direct),
    },
    {
      key: "reached_related",
      label: "Related",
      blurb: "Asks for a skill next to theirs",
      value: f.reached_related,
      share: pct(f.reached_related),
    },
    {
      key: "hidden",
      label: "Hidden",
      blurb: "Not relevant, so never shown",
      value: f.hidden,
      share: pct(f.hidden),
    },
  ];
}

/**
 * Does the server's funnel add up (`open = direct + related + hidden`)? The API guarantees it;
 * when it does not, the screen SAYS so — a demo funnel that silently fails arithmetic is worse
 * than one that flags it, and re-balancing it here would hide a backend defect (invariant #9).
 */
export function funnelBalances(f: EngineFunnel): boolean {
  return f.open_postings === f.reached_direct + f.reached_related + f.hidden;
}

// ---------------------------------------------------------------------------
// What changed between two polls
// ---------------------------------------------------------------------------

export interface CardDiff {
  /** Posting ids on the new feed that were not on the old one. */
  entered: Set<string>;
  /** Cards on the old feed that are gone, with their old position, so they can leave in place. */
  exited: { card: EngineCard; index: number }[];
}

/** Which cards arrived and which left. Keyed by posting id: a re-ranked card is neither. */
export function diffCards(prev: readonly EngineCard[], next: readonly EngineCard[]): CardDiff {
  const nextIds = new Set(next.map((c) => c.job_posting_id));
  const prevIds = new Set(prev.map((c) => c.job_posting_id));
  return {
    entered: new Set(
      next.filter((c) => !prevIds.has(c.job_posting_id)).map((c) => c.job_posting_id),
    ),
    exited: prev
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => !nextIds.has(card.job_posting_id)),
  };
}

/** Funnel numbers that moved — each flashes once. `already_actioned` included (it is shown). */
export function changedFunnelKeys(prev: EngineFunnel, next: EngineFunnel): Set<keyof EngineFunnel> {
  const keys: (keyof EngineFunnel)[] = [
    "open_postings",
    "reached_direct",
    "reached_related",
    "hidden",
    "already_actioned",
  ];
  return new Set(keys.filter((k) => prev[k] !== next[k]));
}

/**
 * The feed as drawn: the server's cards in the server's order, with each departing card slotted
 * back at its old position so it can animate out where it stood instead of jumping. A departed
 * card is marked; the live cards' order is untouched.
 */
export function withExiting(
  next: readonly EngineCard[],
  exited: readonly { card: EngineCard; index: number }[],
): { card: EngineCard; exiting: boolean }[] {
  const out = next.map((card) => ({ card, exiting: false }));
  for (const { card, index } of [...exited].sort((a, b) => a.index - b.index)) {
    out.splice(Math.min(index, out.length), 0, { card, exiting: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The screen's URL — the selection lives in the query, so a demo state is a link
// ---------------------------------------------------------------------------

export const ENGINE_PATH = "/matching/engine";

export type EngineTab = "worker" | "posting";

export interface EngineSelection {
  worker?: string;
  tab?: EngineTab;
  posting?: string;
}

/**
 * The engine view's URL for a selection. `tab=worker` is the default and is left out; empty
 * values are dropped. Values are percent-encoded by `URLSearchParams`, so an id carrying `&` or
 * `#` cannot truncate the query into a different selection.
 */
export function engineHref(sel: EngineSelection): string {
  const q = new URLSearchParams();
  if (sel.worker) q.set("worker", sel.worker);
  if (sel.tab === "posting") q.set("tab", "posting");
  if (sel.posting) q.set("posting", sel.posting);
  const s = q.toString();
  return s ? `${ENGINE_PATH}?${s}` : ENGINE_PATH;
}
