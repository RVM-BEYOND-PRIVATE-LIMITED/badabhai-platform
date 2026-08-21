import { formatCount, formatExactRupees, formatTimestamp } from "./format";

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

// ---------------------------------------------------------------------------
// Cost per profile
// ---------------------------------------------------------------------------

/**
 * The API's two stable codes for the cost-per-profile block, mirrored from
 * `apps/api/src/admin/admin-dashboard.dto.ts`. Compared, never assumed — same rule as
 * `AI_COST_CAVEAT_SINCE_0077` above: a code this build has not been taught about must render
 * as "this portal does not know what this means", not as the sentence for the old one.
 */
export const COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED =
  "profiling_spend_per_completed_profile_incl_abandoned_interviews";
export const COST_PER_PROFILE_WINDOW_EDGE_SKEW =
  "interviews_straddling_the_accrual_bound_are_split";
export const COST_PER_PROFILE_ERASURE_BIAS = "erased_workers_leave_the_count_but_not_the_spend";

/** The wire block, narrowed to the fields the copy depends on. */
export interface CostPerProfileInput {
  /**
   * The bound BOTH halves are scoped to — `min(first_recorded_at)` over the PROFILING task
   * types. NOT `accruing_since`: that one is table-wide and is at or before this one, because a
   * non-profiling task type can have accrued first. Every label in this block comes from HERE.
   */
  since: string;
  profiling_task_types: readonly string[];
  profiling_cost_inr: string;
  profiling_calls: number;
  profiling_real_calls: number;
  profiles_extracted_or_confirmed: number;
  cost_per_profile_inr: string | null;
  basis: string;
  window_caveat: string;
  erasure_caveat: string;
}

/**
 * Every sentence and every rendered value the cost-per-profile block is allowed to show.
 * Four of the fields are nullable because four of the caveats are CONDITIONAL — a caveat band
 * that renders on every load is a band operators learn to skip.
 */
export interface CostPerProfileView {
  /**
   * Goes in BOTH TILE LABELS — "since 2026-08-19" — so neither figure travels window-less.
   *
   * DERIVED FROM `per_profile.since` AND FROM NOTHING ELSE. An earlier revision took it from
   * the section's basis headline whenever the two bounds agreed, which put "all time" on a
   * count that is bounded in every case (`is_lifetime_total` is a claim about SPEND, and the
   * server never made it about this profile count), and put the COUNT's bound on the SPEND tile
   * in the fallback. One bound, one source, both tiles — the server guarantees the two halves
   * share it, so there is nothing here for a second source to be right about.
   */
  windowLabel: string;
  /** The headline claim, bolded by the caller. */
  basisHeadline: string;
  basisDetail: string;
  /** What the NUMERATOR summed, naming the task-type rows so the operator can add them up. */
  scopeSentence: string;
  /** What the DENOMINATOR counted, and by which column it is timed. */
  completedSentence: string;
  /** The exact bound, and what the window edges do to the ratio. */
  windowSentence: string;
  /** What DPDP erasure does to it — permanent, one-directional, and it accumulates. */
  erasureSentence: string;
  /** Pre-formatted — either an exact ₹ amount or the stated ABSENCE. Never "₹0.00" for null. */
  averageText: string;
  /** True ⇒ `averageText` is a statement, not a number, and must not be styled as one. */
  averageIsAbsent: boolean;
  averageAbsentSentence: string | null;
  mockPostureSentence: string | null;
  /**
   * Non-null ⇒ the section's ₹ figures start EARLIER than this block's, because a non-profiling
   * task type accrued first. Expected and benign — it is plain copy, not a warning.
   */
  sectionBoundSentence: string | null;
  /**
   * Non-null ⇒ the server contradicted itself (a profiling bound BEFORE the table-wide minimum,
   * which is impossible for a minimum over a subset) or sent a bound that will not parse. The
   * ratio is then not a ratio of anything and the caller escalates the whole band.
   */
  windowMismatchSentence: string | null;
}

/**
 * The three states this block can be in — a union, because they are three different answers and
 * a bare `null` cannot tell the last two apart.
 *
 * `unsupported` exists because `per_profile` is `.optional()` on the wire. A portal newer than
 * the API it is talking to must not take the WHOLE dashboard down over one analytics block
 * (`aiCostSummarySchema` is nested inside `dashboardSummarySchema`, so a hard requirement here
 * fails AI spend, volume, funnel — the page, not the block), and it must not silently render
 * nothing either, which is pixel-identical to `absent` and therefore a false claim about a
 * platform that is spending money. So it renders a sentence saying which of the two it is.
 */
export type CostPerProfileState =
  | { kind: "absent" }
  | { kind: "unsupported"; sentence: string }
  | { kind: "measured"; view: CostPerProfileView };

/** The one string the null average is allowed to render as. Pinned so a test can hold it. */
const NO_AVERAGE_TEXT = "No profile finished yet";

/**
 * Turn the cost-per-profile block into the only words it may be described with — or NULL when
 * there is no block to describe.
 *
 * ══ THE FOUR RULES THIS FUNCTION EXISTS FOR ═════════════════════════════════════════════
 *
 *  1. THE AVERAGE IS NOT A PER-WORKER UNIT COST. Its numerator carries the spend of every
 *     interview in the window INCLUDING the ones abandoned before a profile existed; its
 *     denominator counts only profiles that finished. So it answers "what does the platform
 *     pay for each profile it actually gets", abandonment included. The two readings cannot be
 *     told apart from the number, so the distinction is rendered ABOVE it, never beside it.
 *
 *  2. THE NUMERATOR IS NOT THE PLATFORM TOTAL, and the operator will try to reconcile it.
 *     `profiling_task_types` arrives in band precisely so the sum is auditable, so it is
 *     rendered VERBATIM from the response — never a hardcoded list of three, which would go
 *     silently stale the day the API classifies voice spend as profiling. It is also
 *     INTERSECTED with `by_task_type`: naming a row as reconcilable and then not rendering it
 *     is an instruction the operator cannot follow, and a classified task type with no accrued
 *     call has no row.
 *
 *  3. NULL AVERAGE IS A STATEMENT, NOT A ZERO. `cost_per_profile_inr === null` means spend in
 *     the window with no profile finished — every interview still running or abandoned. A
 *     rendered ₹0.00 would say profiling is free, which is the strongest available claim and
 *     one nobody measured. Same discipline as `formatSuppressible` and `describeAiCostBasis`.
 *
 *  4. `accruing_since === null` RETURNS `absent` BEFORE ANYTHING ELSE. Nothing has ever accrued,
 *     so there is no window for a profile count to cover and no ₹ may be rendered anywhere in
 *     this section (panel rule 2). Checking it HERE rather than in the panel is what makes
 *     that rule hold without a DOM: the block cannot be rendered into the nothing-accrued
 *     state even by a caller that forgets to gate it.
 *
 *  5. EVERY LABEL IS DATED FROM `per_profile.since`, WHICH IS NOT `accruing_since`. The server
 *     bounds this block at the first PROFILING accrual; the section above is bounded at the
 *     first accrual of any kind, and the two differ whenever something that is not profiling
 *     was paid for first. The section starting earlier is ordinary and gets plain copy; the
 *     reverse is arithmetically impossible for a subset and gets the alarm.
 */
export function describeCostPerProfile(
  cost: AiCostBasisInput & {
    per_profile?: CostPerProfileInput | null;
    by_task_type: readonly { task_type: string }[];
  },
): CostPerProfileState {
  const basis = describeAiCostBasis(cost);
  // Rule 4 — and it is checked on the BASIS, not on `per_profile`, so the two can never
  // disagree about whether this section has a measurement in it at all.
  if (basis.kind === "nothing_accrued") return { kind: "absent" };
  const perProfile = cost.per_profile;
  // MISSING and NULL are different answers, and only one of them is the server's. See
  // `CostPerProfileState`.
  if (perProfile === undefined) {
    return {
      kind: "unsupported",
      sentence:
        "This portal expects a cost-per-profile figure that the API it is talking to does not " +
        "send. That is a version skew — usually a rolling deploy in progress — and not a " +
        "statement that nothing was spent. Every other figure in this section is unaffected.",
    };
  }
  if (perProfile === null) return { kind: "absent" };

  /*
   * ── THE TWO BOUNDS ARE DIFFERENT FIELDS WITH DIFFERENT JOBS ────────────────────────────
   * `accruing_since` is `min(first_recorded_at)` over the WHOLE cost table and bounds the ₹
   * figures at the top of this section. `per_profile.since` is the same minimum over the
   * PROFILING task types only, and bounds both halves of this block. A minimum over a subset is
   * never smaller than the minimum over the whole, so:
   *
   *   - `countBound > spendBound` is ORDINARY — something that is not profiling (a résumé, a
   *     payer-side embedding) accrued first. Explained in plain copy, never warned about.
   *   - `countBound === spendBound` — the first money the platform spent was profiling money.
   *   - `countBound < spendBound` is IMPOSSIBLE and means the server is contradicting itself.
   *
   * Compared as INSTANTS rather than as strings: "…:05Z" and "…:05.000Z" are the same moment,
   * and a serializer change that reformatted one of them must not raise a false alarm.
   */
  const countBound = Date.parse(perProfile.since);
  const spendBound = cost.accruing_since === null ? Number.NaN : Date.parse(cost.accruing_since);
  const boundReadable = Number.isFinite(countBound);
  const boundsContradict = boundReadable && Number.isFinite(spendBound) && countBound < spendBound;
  const sectionStartsEarlier =
    boundReadable && Number.isFinite(spendBound) && countBound > spendBound;

  // ONE BOUND, ONE SOURCE, BOTH TILES — and never a bare em dash in a tile label: an
  // unreadable bound produces a neutral phrase plus the alarm below, not a figure captioned
  // with a dash the reader has to interpret.
  const windowLabel = boundReadable
    ? `since ${formatTimestamp(perProfile.since).slice(0, 10)}`
    : "in this period";

  const knownBasis = perProfile.basis === COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED;
  const knownWindowCaveat = perProfile.window_caveat === COST_PER_PROFILE_WINDOW_EDGE_SKEW;
  const knownErasureCaveat = perProfile.erasure_caveat === COST_PER_PROFILE_ERASURE_BIAS;
  const averageIsAbsent = perProfile.cost_per_profile_inr === null;
  const mockedCalls = perProfile.profiling_calls - perProfile.profiling_real_calls;

  /*
   * WHICH OF THE NAMED TASK TYPES ARE ACTUALLY IN THE TABLE BELOW. `by_task_type` is a GROUP BY
   * over the cost table, so a classified-as-profiling task type with no accrued row simply is
   * not there. Telling the operator to reconcile the numerator against "these rows below" and
   * then not rendering them is an instruction that cannot be followed, so only the types that
   * ARE below are named as rows, and the rest are reported as having recorded nothing.
   */
  const renderedBelow = new Set(cost.by_task_type.map((b) => b.task_type));
  const present = perProfile.profiling_task_types.filter((t) => renderedBelow.has(t));
  const absentTypes = perProfile.profiling_task_types.filter((t) => !renderedBelow.has(t));
  const label = (types: readonly string[]) => types.map(taskTypeLabel).join(", ");

  const view: CostPerProfileView = {
    windowLabel,

    basisHeadline: knownBasis
      ? "Cost to produce one finished profile — not a per-worker unit cost"
      : "Basis code not recognised",
    basisDetail: knownBasis
      ? "The spend side carries every interview in this period, including the ones abandoned " +
        "before any profile existed; the count side carries only the profiles that finished. " +
        "So it is what the platform pays for each profile it actually gets — not what " +
        "profiling one worker costs."
      : `The server reports a basis this portal does not recognise: ${perProfile.basis}. The ` +
        "figures are shown as sent; do not assume what they count.",

    scopeSentence:
      perProfile.profiling_task_types.length === 0
        ? "The server named no task types, so this spend cannot be reconciled against " +
          "By task type below."
        : present.length === 0
          ? "Profiling spend only — résumé generation and every other task type are excluded. " +
            `None of the task types this sums (${label(perProfile.profiling_task_types)}) has ` +
            "a row in By task type below, so there is nothing there to reconcile it against."
          : "Profiling spend only — résumé generation and every other task type are excluded. " +
            `It is exactly these rows of By task type below: ${label(present)}.` +
            (absentTypes.length > 0
              ? ` ${label(absentTypes)} ${
                  absentTypes.length === 1
                    ? "also counts as profiling spend but has recorded no call, so no row " +
                      "appears for it."
                    : "also count as profiling spend but have recorded no call, so no rows " +
                      "appear for them."
                }`
              : ""),

    completedSentence:
      "Completed means the worker's current profile reached extracted or confirmed — counted " +
      "once per worker, not once per re-interview, and timed by when that profile row was " +
      "first written. A profile extracted before this period and confirmed inside it is not " +
      "counted, because the spend that produced it happened before the period too.",

    windowSentence: !knownWindowCaveat
      ? `The server reports a window caveat this portal does not recognise: ${perProfile.window_caveat}`
      : (boundReadable
          ? `Both halves start at ${formatTimestamp(perProfile.since)}. `
          : "Both halves start at the same bound. ") +
        "An interview that straddles it — begun before, finished after — lands in the count " +
        "with only part of its cost in the spend; one still running has cost and no profile " +
        "yet. Over a period this short that skew is material, and it cuts both ways.",

    erasureSentence: knownErasureCaveat
      ? "Erasing a worker under DPDP removes their profile from the count but not their spend " +
        "from the total — the cost table holds no worker link by design. So this average " +
        "drifts upward with every erasure, permanently, and that drift only accumulates."
      : `The server reports an erasure caveat this portal does not recognise: ${perProfile.erasure_caveat}`,

    // Rule 3. `formatExactRupees` is never reached with a null, so a ₹0.00 is unreachable
    // rather than merely avoided.
    averageText: averageIsAbsent
      ? NO_AVERAGE_TEXT
      : formatExactRupees(perProfile.cost_per_profile_inr as string),
    averageIsAbsent,
    averageAbsentSentence: averageIsAbsent
      ? "No profile finished in this period, so there is no average to show. That is an " +
        "absent measurement, not a measured ₹0.00 — every interview here is still running " +
        "or was abandoned."
      : null,

    /*
     * Only when it is true — TD81's failure mode is a mocked figure quoted as production money,
     * and the platform tile above warns on the same comparison.
     *
     * AND IT POINTS THE OTHER WAY FROM WHAT THAT SUGGESTS. An earlier revision said "part of
     * this spend is simulated money", which is false: `cost_tracker.build_call_metadata` sets
     * `estimated = 0.0` for `real_call=False` BEFORE any override, so a mocked call contributes
     * exactly ₹0.000000 and none of the rupees above are fictional. The real hazard is the
     * mirror image — those calls are interviews that happened and cost nothing on paper, so
     * they pad the volume the average is taken over and the figure UNDERSTATES what the same
     * volume costs at real prices. `AI_REAL_CALL_TASKS` is a per-task allowlist that is empty
     * by default, so a partial or total mock posture is ordinary, not exotic.
     *
     * It says "this SPEND", not "this average", deliberately: it also renders in the state where
     * there is no average at all, and a sentence about a figure that is not on screen reads as a
     * bug in the console rather than as a caveat about the money.
     */
    mockPostureSentence:
      mockedCalls > 0
        ? `${formatCount(mockedCalls)} of ${formatCount(perProfile.profiling_calls)} profiling ` +
          "calls never reached a provider. Those are priced at ₹0 at source, so they add " +
          "nothing to this spend while still counting as interviews — the average understates " +
          "what this volume costs at real prices."
        : null,

    // Plain copy, not a warning: a subset's minimum is never earlier than the whole table's, so
    // this is the expected shape whenever the platform spent on something else first.
    sectionBoundSentence: sectionStartsEarlier
      ? `The section's ₹ figures above start earlier (${basis.headline.toLowerCase()}) because ` +
        "spend that is not profiling — a résumé, a payer-side embedding — accrued first. This " +
        "block deliberately starts later, at the first profiling call."
      : null,

    windowMismatchSentence: boundsContradict
      ? `The profile count is scoped to ${formatTimestamp(perProfile.since)}, which is EARLIER ` +
        `than the bound the whole cost table reports (${basis.headline}). That is impossible ` +
        "for a subset of the same rows, so the server is contradicting itself — read the raw " +
        "figures, not the ratio."
      : boundReadable
        ? null
        : `The server sent a bound this portal cannot read (${perProfile.since}), so neither ` +
          "figure here can be dated. Read the raw figures, not the ratio.",
  };

  return { kind: "measured", view };
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
