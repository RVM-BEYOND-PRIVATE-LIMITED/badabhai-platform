import { formatTimestamp } from "./format";

/**
 * How AI spend is ALLOWED to be described. Pure, so the rule is testable without a DOM.
 *
 * ══ THE ONE RULE THIS MODULE EXISTS FOR ═════════════════════════════════════════════════
 * The ₹ figures on `/admin/dashboard/summary` are NOT a lifetime total. `platform_ai_cost_totals`
 * starts empty at migration 0077 and accrues forward; the spend already on the event spine was
 * never backfilled. The API says so in band on every response — `is_lifetime_total: false`,
 * `accruing_since`, and a stable `caveat` code — and this module is the single place that turns
 * those three fields into words. A "Total AI spend" tile with no "since" on it is a wrong number
 * presented as a right one, which on an operations console is worse than no tile at all.
 *
 * Three shapes, and they are genuinely different claims:
 *
 *  - `accruing_since === null` — NOTHING HAS ACCRUED. There is no measurement here at all, so
 *    the zeros must be described rather than displayed: a ₹0.00 tile reads as "we measured the
 *    platform and it cost nothing", which is the strongest possible claim and one nobody made.
 *  - `is_lifetime_total === false` — spend SINCE a date, and the date ships with every figure.
 *  - `is_lifetime_total === true` — reachable only after a backfill lands. Handled today so the
 *    caption is already right on the day it flips, rather than silently under-claiming.
 */

/**
 * The API's stable caveat/scope codes, mirrored from `apps/api/src/admin/admin-dashboard.dto.ts`.
 *
 * MIRRORED AS CONSTANTS, and the value is compared rather than assumed: the API DTO states that
 * `CAP_BREACH_SCOPE_PROFILE_EXTRACTION` CHANGES VALUE when another surface starts emitting the
 * breach event. So an unrecognised code must render as "this portal does not know what this
 * scope covers" — visible and honest — instead of silently reusing the old sentence, which would
 * be this portal asserting a narrowing the server had just withdrawn.
 */
export const AI_COST_CAVEAT_SINCE_0077 = "totals_accrue_from_migration_0077_no_backfill";
export const CAP_BREACH_SCOPE_PROFILE_EXTRACTION = "cap_breaches_cover_profile_extraction_only";

export type AiCostBasis =
  | { kind: "nothing_accrued"; headline: string; detail: string; sinceIso: null }
  | { kind: "since"; headline: string; detail: string; sinceIso: string }
  | { kind: "lifetime"; headline: string; detail: string; sinceIso: null };

/** Just the fields the basis depends on — so a caller cannot pass "some cost-ish object". */
export interface AiCostBasisInput {
  accruing_since: string | null;
  is_lifetime_total: boolean;
  caveat: string;
}

/**
 * Describe what the ₹ figures beside this actually measure.
 *
 * `accruing_since === null` is checked FIRST and beats everything, including a `true`
 * `is_lifetime_total`: "the lifetime total of a table with no rows in it" is not a figure worth
 * printing under either caption.
 */
export function describeAiCostBasis(input: AiCostBasisInput): AiCostBasis {
  if (input.accruing_since === null) {
    return {
      kind: "nothing_accrued",
      sinceIso: null,
      headline: "No AI spend recorded yet",
      detail:
        "Nothing has ever been written to the AI cost table, so there is no measurement to " +
        "show — this is not a measured ₹0. Recording begins at migration 0077 and only " +
        "accrues forward; spend before that was never backfilled and is not counted here.",
    };
  }
  if (input.is_lifetime_total) {
    return {
      kind: "lifetime",
      sinceIso: null,
      headline: "All time",
      detail: "The server reports these figures as a lifetime total.",
    };
  }
  return {
    kind: "since",
    sinceIso: input.accruing_since,
    headline: `Since ${formatTimestamp(input.accruing_since).slice(0, 10)}`,
    detail:
      `Not a lifetime total. These figures accrue from ${formatTimestamp(input.accruing_since)} ` +
      "forward (migration 0077) and nothing before that was backfilled, so real spend from " +
      "earlier is missing from every number in this section.",
  };
}

/**
 * The caveat code as a sentence. An unknown code is shown RAW rather than dropped — the same
 * rule `creditReasonLabel` follows, and for the same reason: a code this portal has not been
 * taught about is a reason to look, not a reason to render nothing.
 */
export function describeAiCostCaveat(caveat: string): string {
  if (caveat === AI_COST_CAVEAT_SINCE_0077) {
    return "Totals accrue from migration 0077 forward. No backfill has run.";
  }
  return `The server attached a caveat this portal does not recognise: ${caveat}`;
}

/**
 * What the cap-breach count actually covers.
 *
 * `ai.spend_cap_exceeded` has ONE emitter today (profile extraction), so a `0` means "profile
 * extraction hit no cap", NOT "no surface anywhere hit a cap". The number never ships without
 * this sentence beside it.
 */
export function describeCapBreachScope(scope: string): string {
  if (scope === CAP_BREACH_SCOPE_PROFILE_EXTRACTION) {
    return (
      "Covers PROFILE EXTRACTION only — it is the one surface that emits this event today. " +
      "Profiling chat, résumés, embeddings and payer chat have no emitter yet, so a zero here " +
      "is not an all-clear for them."
    );
  }
  return `The server reports a breach scope this portal does not recognise: ${scope}`;
}

/**
 * Human names for the RAW provider labels — the ai-service's `provider_for_model` produces
 * `google`, `anthropic`, `openai`, `sarvam` and `unknown`.
 *
 * ⚠ `unknown` IS LABELLED, NEVER HIDDEN OR MERGED. `platform_ai_cost_totals` is a running sum
 * with no backfill, so every rupee that accrued before `provider_for_model` learned the Sarvam
 * model families stays filed under `unknown` for ever. Folding that row into "Sarvam" would
 * move money between buckets after the fact AND relabel every genuinely unrecognised model id;
 * dropping it would understate the platform total by exactly that amount. So it renders, with
 * its own explanation attached.
 */
const PROVIDER_LABELS: Record<string, string> = {
  google: "Google (Gemini)",
  anthropic: "Anthropic (Claude)",
  sarvam: "Sarvam",
  openai: "OpenAI",
  unknown: "Unknown provider",
};

/**
 * The provider label. The set is OPEN — a provider added after this build ships renders with its
 * raw value de-snaked rather than being dropped or crashing the section.
 */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.replace(/_/g, " ");
}

/** The explanation the `unknown` bucket carries, or null for a provider that needs none. */
export function providerNote(provider: string): string | null {
  if (provider === "unknown") {
    return (
      "Calls whose model id the cost recorder could not attribute — including all Sarvam " +
      "speech spend from before the provider fix, which stays here permanently because a " +
      "running total is never backfilled. Read it with the task-type split below."
    );
  }
  if (PROVIDER_LABELS[provider] === undefined) {
    return "A provider label this portal has not been taught about. The figure is the server's.";
  }
  return null;
}

/** `stt_transcription` → `stt transcription`. An open set: de-snaked, never mapped. */
export function taskTypeLabel(taskType: string): string {
  return taskType.replace(/_/g, " ");
}

/**
 * Human names for `AI_SPEND_CAP_REASONS`. The split is the operationally load-bearing part: one
 * worker exhausting their own budget is routine and self-limiting, while a cumulative cap or the
 * kill switch means the PLATFORM stopped calling providers — an outage in all but name.
 */
const CAP_BREACH_REASON_LABELS: Record<string, string> = {
  user_daily_cap_exceeded: "One worker's daily budget",
  daily_cap_exceeded: "Platform daily cap",
  cumulative_cap_exceeded: "Platform cumulative cap",
  kill_switch_engaged: "Kill switch engaged",
  retry_budget_exhausted: "Retry budget exhausted",
  cost_ceiling_exceeded: "Per-call cost ceiling",
};

/** Reasons that mean the PLATFORM stopped, not that one worker hit their own budget. */
const PLATFORM_WIDE_REASONS = new Set([
  "daily_cap_exceeded",
  "cumulative_cap_exceeded",
  "kill_switch_engaged",
]);

export function capBreachReasonLabel(reason: string): string {
  return CAP_BREACH_REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

/** True when this reason means provider calls stopped platform-wide, not per worker. */
export function isPlatformWideBreach(reason: string): boolean {
  return PLATFORM_WIDE_REASONS.has(reason);
}
