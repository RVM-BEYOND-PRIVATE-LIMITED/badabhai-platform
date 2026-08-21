import { z } from "zod";
import {
  JOB_POSTING_STATUSES,
  PROFILE_STATUSES,
  WORKER_STATUSES,
  type JobPostingStatus,
  type ProfileStatus,
  type WorkerStatus,
} from "@badabhai/types";
import type { AiCostTaskType } from "@badabhai/event-schema";
import type { PayerRole, PayerStatus } from "@badabhai/db";

/**
 * Zod DTO + projections for `GET /admin/dashboard/summary` (BP-5) — what the platform has
 * SPENT on AI, and how big it is.
 *
 * ── THE HONESTY MARKER IS PART OF THE CONTRACT, NOT A NICETY ────────────────────────────
 * `platform_ai_cost_totals` starts EMPTY at migration 0077 and accrues forward; the spend
 * already on the event spine was never backfilled (the schema header says so in as many
 * words, and no backfill script has run). So the number this endpoint returns is
 * **"spend since <accruing_since>"**, and it is NOT a lifetime total.
 *
 * {@link AdminAiCostSummary} therefore carries THREE fields whose only job is to stop that
 * being mis-read: `accruing_since` (the earliest `first_recorded_at` in the table — null when
 * nothing has accrued at all), `is_lifetime_total` (a constant `false` until a backfill
 * lands), and `caveat` (a stable machine code the UI can key a caption off, rather than
 * parsing prose). A partial figure rendered as authoritative is the same class of failure as
 * a mock rupee rendered as a real one — which is why the finance surface carries
 * `PaymentsPosture` in band for exactly the same reason.
 *
 * ── ₹ CROSSES THE WIRE AS AN EXACT DECIMAL STRING ───────────────────────────────────────
 * `total_cost_inr` is `numeric(16,6)` summed IN POSTGRES and serialized verbatim, e.g.
 * `"12.480000"`. It is deliberately not coerced to a JS `number`: a single embed call costs a
 * small fraction of a paisa, `numeric` is exact, and IEEE-754 is not — the schema header picked
 * `numeric` precisely so that "the read layer that formats rupees decides where to lose
 * precision". A client that wants a float writes `Number(total_cost_inr)` and owns that choice.
 * Integer COUNTS are plain numbers; only the money is a string.
 *
 * ── A RATIO IS TWO CLAIMS, AND BOTH OF THEM CAN BE WRONG SILENTLY ───────────────────────
 * {@link AdminCostPerProfile} answers "what does a finished profile cost us". Its numerator is
 * the PROFILING slice of spend and not the platform total ({@link PROFILING_TASK_TYPES} — a
 * résumé is rendered from a profile that already exists and must not be billed to producing
 * one), and its denominator is scoped to the bound THAT SLICE begins at — which is NOT
 * `accruing_since`, because the table-wide minimum can belong to a task type the numerator
 * excludes. Neither error changes the shape of the output; both change the number, and the
 * second one was measured at 22× before it was closed. The three stable codes it ships —
 * {@link COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED}, {@link COST_PER_PROFILE_WINDOW_EDGE_SKEW}
 * and {@link COST_PER_PROFILE_ERASURE_BIAS} — say what the figure counts, what the window edges
 * do to it, and what DPDP erasure does to it, for the same reason `caveat` exists one field away.
 *
 * ── PROVIDER LABELS ARE RAW, AND NOT AN ENUM ────────────────────────────────────────────
 * `platform_ai_cost_totals.provider` is a `text` column fed from `AICallMetadata.provider`,
 * which the ai-service derives with `provider_for_model()`. The values that function can
 * produce are `"google"`, `"anthropic"`, `"openai"`, `"sarvam"` and `"unknown"` — plus the
 * literal `"unknown"` that `AiCostRecorder` substitutes for an empty label. So:
 *
 *   - Gemini  → `"google"`
 *   - Claude  → `"anthropic"`
 *   - Sarvam  → `"sarvam"` — as of the `provider_for_model` fix that matches the model FAMILY
 *     (`saarika`/`saaras` STT, `bulbul` TTS, `mayura` translate). Before that fix every Sarvam
 *     call fell through to `"unknown"`.
 *
 * SARVAM SPEND IS THEREFORE SPLIT ACROSS TWO BUCKETS, AND WILL STAY THAT WAY. This table is a
 * running SUM with no backfill, so rupees accrued before that fix deployed remain filed under
 * `"unknown"` for ever; only calls made after it land under `"sarvam"`. A reader looking at
 * historical STT spend must expect it in the `unknown` row. NO REMAPPING IS APPLIED HERE:
 * rewriting `unknown → sarvam` at read time would also silently relabel every genuinely
 * unlabelled call (an unrecognised model id still falls through to `"unknown"`, which is the
 * honest fallback), and it would move money between buckets after the fact.
 *
 * `by_task_type` is what makes the historical `unknown` bucket readable — pre-fix STT spend is
 * exactly its `stt_transcription` row — which is why the (provider, task_type) PK's other half
 * is surfaced rather than dropped. This DTO does NOT hardcode either list: both are open sets,
 * and an enum here would silently drop the first provider added after it was written.
 */

/** Hard cap on the breach-count window (mirrors the finance summary's cap). */
export const ADMIN_DASHBOARD_WINDOW_DAYS_MAX = 90;
export const ADMIN_DASHBOARD_WINDOW_DAYS_DEFAULT = 30;

/**
 * The machine-readable caveat code for the AI-cost figures. A STABLE STRING, not prose: the
 * portal keys a caption off it, and prose that changes shape breaks a caption silently.
 */
export const AI_COST_CAVEAT_SINCE_0077 = "totals_accrue_from_migration_0077_no_backfill" as const;

/**
 * The machine-readable SCOPE marker for the cap-breach counts — the same device as
 * {@link AI_COST_CAVEAT_SINCE_0077}, for the same reason, on the block one field away.
 *
 * `ai.spend_cap_exceeded` has exactly ONE emitter in `apps/api` today:
 * `ProfileExtractionProcessor`. So `cap_breaches.total: 0` means "profile extraction hit no
 * cap", NOT "no surface anywhere hit a cap" — the profiling-chat, résumé, embedding and
 * payer-chat surfaces have no emitter yet. A UI given a bare `0` renders the second reading,
 * which is the strongest possible claim and the wrong one. Widening the coverage is an
 * EMITTER-side change; until it lands, the number ships with its scope attached.
 *
 * A STABLE STRING, not prose: the portal keys a caption off it. When another surface starts
 * emitting, this constant changes value (and this is the line that says so) — it is not a
 * boolean that silently keeps meaning something narrower than it reads.
 */
export const CAP_BREACH_SCOPE_PROFILE_EXTRACTION =
  "cap_breaches_cover_profile_extraction_only" as const;

// ---------------------------------------------------------------------------
// Cost per profile — the two classifications the ratio is built out of
// ---------------------------------------------------------------------------

/**
 * WHICH SPEND BELONGS TO PRODUCING A PROFILE — the NUMERATOR of {@link AdminCostPerProfile},
 * and the reason that figure is not `total_cost_inr / profiles`.
 *
 * THE TOTAL IS THE WRONG NUMERATOR, AND THAT IS MEASURED, NOT ARGUED. Production read ₹77.4583
 * of platform spend, of which ₹5.629 is `resume_generation` — a résumé is rendered FROM a
 * profile that already exists, so billing it to the profiling average charges the cost of
 * producing a profile with work that produced none. The remaining ₹71.8293 is exactly
 * `profiling_chat_turn` (₹59.3202) + `profile_extraction` (₹12.5091) + `profile_parse` (₹0.00),
 * and 77.4583 − 71.8293 = 5.629 to the paisa — so this split is exhaustive against the table as
 * it stands, not an estimate of it.
 *
 * A `Record` OVER THE WHOLE ENUM, NOT THREE STRING LITERALS IN A `WHERE`. Every member of
 * `AiCostTaskType` must be classified here, so a task type added to the event enum FAILS THIS
 * BUILD until somebody decides which side of the ratio it falls on. That is the same
 * exhaustiveness device `PAYER_ROLE_KEYS` uses further down, chosen for the same reason a
 * `satisfies readonly AiCostTaskType[]` list would not do: that form accepts any SUBSET, so a
 * newly-added task type would default to "not profiling" with nothing anywhere to notice it.
 *
 * AN UNCLASSIFIED *STORED* VALUE IS EXCLUDED, NEVER SWEPT IN. `platform_ai_cost_totals.task_type`
 * is a plain `text` column with NO check constraint (verified against `\d platform_ai_cost_totals`:
 * the only two constraints are the non-negative count and cost guards), so the stored set is not
 * pinned to this enum by the database. `AiCostRecorder.record` does take `taskType: AiCostTaskType`
 * and pass it through unmodified — its `|| "unknown"` fallbacks are on `provider` and `model`
 * ONLY, never on the task type — so today's writer cannot produce an unclassified value. What can
 * is an older deploy, a manual `UPDATE`, or `AiCostTaskType` GAINING a member that this map has
 * not classified. The subtotal is therefore an
 * ALLOWLIST (`task_type IN (...)`) and not a denylist: such a row lands in neither half of the
 * ratio, so the average UNDERSTATES rather than absorbing spend it cannot attribute. Understating
 * is the survivable direction — a rupee wrongly inside the numerator is invisible, while a rupee
 * left out is still recoverable from `by_task_type`, which carries every bucket raw.
 *
 * THE OPEN CLASSIFICATION, STATED RATHER THAN LEFT TO BE DISCOVERED. `stt_transcription` and
 * `tts_synthesis` are the VOICE interview and `domain_match` runs inside extraction; a case can
 * be made that all three produce profiles. All three are ₹0.000000 today (voice is dormant, and
 * `domain_match`/`tts_synthesis` have no apps/api emitter at all — see `KNOWN_UNLEDGERED` in
 * ai-cost-coverage.test.ts), so no measurement can separate them and none is guessed at here.
 * They are classified `false`, which is the choice that changes nothing today. THE DAY VOICE
 * PROFILING ACCRUES, THIS AVERAGE UNDERSTATES until `stt_transcription` is flipped to `true` —
 * `stt_transcription` already HAS a live emitter, so that day needs no new wiring to arrive.
 * This map is the one line to flip, which is the whole point of it being a map.
 */
const PROFILING_TASK_TYPE_KEYS: Record<AiCostTaskType, boolean> = {
  // The interview loop, the extraction job, and the single Phase-8 parse call that replaced
  // twelve per-turn ones: everything spent turning a conversation into a stored profile.
  profiling_chat_turn: true,
  profile_extraction: true,
  profile_parse: true,
  // Rendered FROM a finished profile, not spent to produce one (₹5.629 of the ₹77.4583).
  resume_generation: false,
  // ₹0.000000 today — the open classification in the header above.
  domain_match: false,
  stt_transcription: false,
  tts_synthesis: false,
  // PAYER-side calls: a job posting's skill embedding and the posting composer. No worker and
  // no profile is involved in either, which is why the platform table exists at all.
  skill_embedding: false,
  job_posting_chat_turn: false,
};

/** The profiling allowlist itself — derived from the map so the two cannot disagree. */
export const PROFILING_TASK_TYPES: readonly AiCostTaskType[] = (
  Object.keys(PROFILING_TASK_TYPE_KEYS) as AiCostTaskType[]
).filter((task) => PROFILING_TASK_TYPE_KEYS[task]);

/**
 * WHAT "A PROFILE WAS PRODUCED" MEANS — the DENOMINATOR's predicate, and the field name
 * `profiles_extracted_or_confirmed` says which of the three candidate answers this is.
 *
 * NOT `confirmed` ALONE, though that is what the worker-journey funnel calls step 4
 * (`AdminJourneyProfileStep`). Confirmation is a FREE TAP in the worker app: it costs the
 * platform nothing, it happens long after the spend, and a large share of extracted profiles
 * never receive one. Dividing profiling spend by confirmations would attribute an entire
 * interview to a UI action the platform does not control and would overstate the cost of
 * producing a profile by however many good profiles are simply never confirmed.
 *
 * NOT `<> 'draft'` EITHER, even though that is the expression `CURRENT_PROFILE_ORDER` ranks by.
 * There it is a RANKING term — "prefer a row that extracted something over one that did not" —
 * and reusing it as a completeness PREDICATE quietly widens it: `extracting` is a declared
 * member of `PROFILE_STATUSES` and means an extraction IN FLIGHT, which has produced nothing.
 * No code path writes it today (`ProfileExtractionProcessor.decideProfileStatus` returns only
 * `draft | extracted`, and `ProfilesRepository.confirm` writes `confirmed`), and that is
 * precisely what makes the negation the dangerous form: it is correct today and becomes wrong
 * SILENTLY on the day something starts writing it. The same argument, in this same folder,
 * is why `countUnlocksIssued` lists `('granted','revealed')` instead of `<> 'denied'`.
 *
 * SO: the positive set. `extracted` = the extraction produced content; `confirmed` = the worker
 * was shown a profile and accepted it. Both are outcomes the AI spend actually bought.
 */
const PROFILE_COMPLETED_KEYS: Record<ProfileStatus, boolean> = {
  // Nothing was produced: an empty placeholder from an ai-service outage, or a fail-closed
  // `blocked` pseudonymization result.
  draft: false,
  // In flight. Declared on the enum, written by nothing today — see the header.
  extracting: false,
  extracted: true,
  confirmed: true,
};

/** The completed set itself — derived from the map so the two cannot disagree. */
export const PROFILE_COMPLETED_STATUSES: readonly ProfileStatus[] = (
  Object.keys(PROFILE_COMPLETED_KEYS) as ProfileStatus[]
).filter((status) => PROFILE_COMPLETED_KEYS[status]);

/**
 * WHAT THE AVERAGE IS — a stable machine code, the same device as
 * {@link AI_COST_CAVEAT_SINCE_0077} and {@link CAP_BREACH_SCOPE_PROFILE_EXTRACTION}, on a figure
 * that is even easier to misread than either.
 *
 * THE NUMERATOR AND THE DENOMINATOR COVER DIFFERENT POPULATIONS, AND THAT IS CORRECT. The
 * numerator carries the spend of every interview in the window INCLUDING the ones that were
 * abandoned and produced no profile; the denominator counts only the profiles that completed.
 * The figure therefore means:
 *
 *     "what it costs the platform to produce one finished profile, including the cost of
 *      everyone who started and did not finish"
 *
 * It is NOT "what it costs to profile one worker" — that number is smaller. Let `S` be the
 * profiling spend, `P` the profiles completed and `W` the workers who started, with `P ≤ W`.
 * This figure is `S/P`; the cost per worker PUT THROUGH the funnel is `S/W ≤ S/P`. So the figure
 * is EXACTLY RIGHT for forecasting the spend of producing the next N profiles, and too LARGE for
 * forecasting the spend of putting the next N workers through the funnel — by the reciprocal of
 * the completion rate. At 100 starts to 50 finishes, forecasting N workers at this rate predicts
 * TWICE the spend that will actually occur.
 *
 * (An earlier revision of this comment said UNDER-forecast. It was wrong in the direction that
 * matters — `S/P` is the LARGEST of the candidate rates, so no reading of it under-states — and
 * it is recorded here because this paragraph is what a future maintainer reads before deciding
 * how the number may be used. The portal deliberately asserts NO direction and states only what
 * the figure is and is not; that remains the safer copy for an operator.)
 *
 * The two readings cannot be told apart from the number, so the distinction ships in band with it
 * and the portal keys its caption off this code.
 */
export const COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED =
  "profiling_spend_per_completed_profile_incl_abandoned_interviews" as const;

/**
 * WHAT THE WINDOW EDGES DO TO IT — the second stable code, for a second and unrelated caveat.
 *
 * An interview is not instantaneous, so some of them STRADDLE the accrual bound. A worker whose
 * interview began before `accruing_since` but whose profile row was written after it lands in
 * the denominator with only the tail of its cost in the numerator (the turns spent before the
 * bound were never accrued — the table starts empty at migration 0077 and nothing was
 * backfilled). The mirror case sits at the other edge: an interview running right now has its
 * spend in the numerator and no completed profile yet.
 *
 * OVER A WINDOW THIS SHORT THAT SKEW IS MATERIAL, and it is not a rounding note. It shrinks as
 * the accrual window lengthens — the straddling interviews stay a roughly constant count while
 * the interior grows — which is the one caveat here that a backfill or the passage of time will
 * actually retire. It is a separate code from {@link COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED}
 * for that reason: that one is definitional and permanent, this one has an expiry.
 */
export const COST_PER_PROFILE_WINDOW_EDGE_SKEW =
  "interviews_straddling_the_accrual_bound_are_split" as const;

/**
 * WHAT DPDP ERASURE DOES TO IT — the third stable code, and a THIRD kind of caveat that neither
 * of the two above covers.
 *
 * ERASURE MOVES THE DENOMINATOR AND NEVER THE NUMERATOR. `worker_profiles` cascades on a
 * `workers` delete, so an erased worker's completed profile leaves the count. The spend does not
 * leave with it: `platform_ai_cost_totals` has no worker linkage AT ALL — by design, and the
 * schema header says so in as many words ("this table survives a DSAR deletion intact, which is
 * correct — the money was spent whether or not the subject remains"). So the money that produced
 * that profile stays in the numerator while the profile it produced disappears from the
 * denominator, and the average rises.
 *
 * MEASURED against the local verification database: ₹10.000000 over 22 completed profiles read
 * ₹0.454545; erasing ONE worker moved it to ₹0.476190 with no change whatsoever in what the
 * platform spent or produced.
 *
 * IT IS A SEPARATE CODE BECAUSE IT IS A SEPARATE SHAPE. {@link
 * COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED} is definitional and permanent;
 * {@link COST_PER_PROFILE_WINDOW_EDGE_SKEW} is real but has an expiry, shrinking as the window
 * lengthens. This one is permanent AND ACCUMULATING: it is one-directional (always upward),
 * unbounded, and it GROWS with every erasure rather than washing out with time. There is no
 * honest arithmetic fix — keeping an erased worker in the denominator would mean retaining a
 * record of them — so it ships as a disclosure, which is the only correct treatment.
 */
export const COST_PER_PROFILE_ERASURE_BIAS =
  "erased_workers_leave_the_count_but_not_the_spend" as const;

/**
 * GET /admin/dashboard/summary
 *
 * `windowDays` scopes ONLY the AI cap-breach counts (an operational "is this happening now?"
 * question). The cost totals and every volume count are all-time by construction — they are
 * running totals and live table states, neither of which has a window to apply. The response
 * repeats `window_days` inside the breach block so it is impossible to read the windowed
 * number as if it covered everything else.
 */
export const AdminDashboardSummaryQuerySchema = z
  .object({
    windowDays: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_DASHBOARD_WINDOW_DAYS_MAX)
      .optional()
      .default(ADMIN_DASHBOARD_WINDOW_DAYS_DEFAULT),
  })
  .strict();
export type AdminDashboardSummaryQueryDto = z.infer<typeof AdminDashboardSummaryQuerySchema>;

// ---------------------------------------------------------------------------
// Projections — AI cost
// ---------------------------------------------------------------------------

/** One provider's slice of platform spend. `provider` is the RAW stored label (see header). */
export interface AdminProviderCostBucket {
  provider: string;
  /** Exact decimal ₹, `numeric(16,6)` — never a float. */
  total_cost_inr: string;
  call_count: number;
  /** How many of those calls actually reached a provider (the rest were the mock posture). */
  real_call_count: number;
  /** When this provider first cost anything — i.e. when ITS accrual started. */
  first_recorded_at: Date;
}

/** One task type's slice of platform spend (the other half of the table's PK). */
export interface AdminTaskCostBucket {
  task_type: string;
  total_cost_inr: string;
  call_count: number;
  real_call_count: number;
}

/**
 * One spend-cap breach reason and how often it tripped in the window.
 *
 * WHY THE SPLIT MATTERS OPERATIONALLY. The existing dashboard shows ONE `ai.spend_cap_exceeded`
 * count, and that number conflates two unrelated incidents: `user_daily_cap_exceeded` is one
 * worker exhausting their own budget (routine, self-limiting), while `cumulative_cap_exceeded`
 * or `kill_switch_engaged` means the PLATFORM stopped calling providers (an outage in all but
 * name). A single counter cannot tell an operator which of those happened.
 *
 * `reason` is typed as a plain string, not `AiSpendCapReason`: the value is read from a stored
 * jsonb payload, so the closed set was true at WRITE time. Narrowing it here would be a claim
 * about historical rows that this read cannot verify, and an unknown value must surface rather
 * than be silently dropped or crash the page.
 */
export interface AdminCapBreachBucket {
  reason: string;
  count: number;
}

/**
 * ₹ PER PROFILE PRODUCED, over the window the PROFILING spend actually covers.
 *
 * THE WHOLE BLOCK IS NULL WHEN THERE IS NO WINDOW — and the window is the PROFILING one.
 * `since` is `min(first_recorded_at)` over {@link PROFILING_TASK_TYPES} ONLY, and it is NULL when
 * no profiling task type has ever accrued: an empty table, a fresh database, or — and this is the
 * case that is easy to miss — a platform whose only recorded spend so far is `resume_generation`
 * or a payer-side `skill_embedding`. There is then no period for a "profiles in the same period"
 * count to cover, so the block is absent rather than a division by zero and rather than ₹0.00
 * over a real profile count, which would read as "profiles are free" — a measurement nobody took.
 *
 * ── `since` IS *NOT* `accruing_since`, AND THAT IS THE CORRECTION ────────────────────────
 * An earlier revision set this field from `accruing_since` — the table-wide
 * `min(first_recorded_at)` the section renders "Since …" from — on the reasoning that both halves
 * must share the one bound the page already displays. Sharing A bound is necessary; sharing the
 * WRONG one is still wrong. `platform_ai_cost_totals` is keyed on `(provider, task_type)` and
 * every row carries its own `first_recorded_at`, so a numerator filtered to the profiling task
 * types begins where THOSE rows begin. When anything else accrued first — `skill_embedding` and
 * `job_posting_chat_turn` are payer-side and involve no worker at all — the table-wide bound is
 * EARLIER, and the denominator then counts profiles from a stretch of time the numerator has no
 * spend for. Measured on the local verification database: a payer-side row at 2020-01-01 against
 * profiling spend starting 2026-08-19 reported ₹0.454545 where the truth was ₹10.000000.
 *
 * So both halves are scoped to THIS bound, which is read off the same aggregate that produced the
 * numerator (`AdminProfilingCostSubtotal.since`) and can therefore not describe a different
 * period from it. `accruing_since` keeps its own meaning one field up — it is the bound of the
 * SECTION's ₹ figures, which do cover every task type — and the two are expected to differ. The
 * invariant that holds is `accruing_since <= since`: a minimum over a subset is never smaller
 * than the minimum over the whole. The portal renders THIS field's bound on both of this block's
 * tiles, and treats the reverse inequality as the server contradicting itself.
 */
export interface AdminCostPerProfile {
  /**
   * The lower bound BOTH halves are scoped to: `min(first_recorded_at)` over
   * {@link PROFILING_TASK_TYPES} only. Always at or after `accruing_since`, never before it.
   */
  since: Date;
  /** Exactly which task types the numerator summed — in band, so the split is auditable. */
  profiling_task_types: readonly AiCostTaskType[];
  /** Exact decimal ₹ over {@link PROFILING_TASK_TYPES} only — NOT the platform total. */
  profiling_cost_inr: string;
  /** Calls behind that subtotal, so the reader can see what the average is over. */
  profiling_calls: number;
  /** How many of those actually reached a provider (the rest were the mock posture). */
  profiling_real_calls: number;
  /**
   * WORKERS whose current profile reached `extracted` or `confirmed` and was created at or
   * after `since` — one per worker, never one per `worker_profiles` row. The name carries the
   * predicate on purpose: see {@link PROFILE_COMPLETED_STATUSES} for why it is neither
   * `confirmed` alone nor `<> 'draft'`.
   */
  profiles_extracted_or_confirmed: number;
  /**
   * `profiling_cost_inr / profiles_extracted_or_confirmed`, to six places — or NULL when that
   * denominator is 0.
   *
   * NULL, NOT "0.000000". A window with spend in it and no completed profile means every
   * interview is still in flight or was abandoned; the honest answer is "there is no average
   * yet", and a rendered zero says "profiles are free", which is the strongest available claim
   * and the wrong one. Same device, same reason, as `accruing_since` refusing to coalesce.
   *
   * A "0.000000" HERE IS ALWAYS A MEASURED ZERO, never a rounded-away one. The block does not
   * exist at all unless profiling spend has accrued, so the remaining ways to reach a zero
   * quotient are a numerator that genuinely IS ₹0 — every call mocked (`real_call=False` is
   * priced at ₹0 at source by `cost_tracker.build_call_metadata`, so a fully-mocked posture
   * accrues real call counts against zero rupees), or a free-tier model — and those are facts
   * about the table worth showing. The one case that is NOT a measured zero is a positive
   * quotient below ₹0.000001; see the clamp in `AdminDashboardService.perProfile`.
   */
  cost_per_profile_inr: string | null;
  /** Stable code — what this average IS. See {@link COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED}. */
  basis: typeof COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED;
  /** Stable code — the window-edge skew. See {@link COST_PER_PROFILE_WINDOW_EDGE_SKEW}. */
  window_caveat: typeof COST_PER_PROFILE_WINDOW_EDGE_SKEW;
  /** Stable code — the DPDP erasure bias. See {@link COST_PER_PROFILE_ERASURE_BIAS}. */
  erasure_caveat: typeof COST_PER_PROFILE_ERASURE_BIAS;
}

export interface AdminAiCostSummary {
  /**
   * The earliest `first_recorded_at` across the whole table — i.e. the date every ₹ figure
   * below is "since". NULL means nothing has ever accrued (a fresh database, or a deploy where
   * no AI call has yet been recorded), in which case the zeros are genuine zeros.
   */
  accruing_since: Date | null;
  /**
   * ALWAYS `false` today, and typed as such. Historical spend on the event spine predates
   * migration 0077 and no backfill has run; when one does, this becomes a real boolean.
   */
  is_lifetime_total: false;
  /** Stable machine code for the caveat above — see {@link AI_COST_CAVEAT_SINCE_0077}. */
  caveat: typeof AI_COST_CAVEAT_SINCE_0077;
  /** Exact decimal ₹ across EVERY recorded call, worker-attributed or not. */
  total_cost_inr: string;
  total_calls: number;
  real_calls: number;
  by_provider: AdminProviderCostBucket[];
  by_task_type: AdminTaskCostBucket[];
  /**
   * What a finished profile costs — NULL when no PROFILING task type has ever accrued and there
   * is therefore no window to compute it over. Its window is its own (`per_profile.since`) and
   * is at or after `accruing_since`, never the same field: see {@link AdminCostPerProfile}.
   * Additive: every field beside it keeps its name, type and meaning (§3 backward
   * compatibility), and a client that ignores this key sees exactly the response it saw before.
   */
  per_profile: AdminCostPerProfile | null;
  cap_breaches: {
    window_days: number;
    total: number;
    /**
     * WHICH SURFACES THIS COUNT COVERS — see {@link CAP_BREACH_SCOPE_PROFILE_EXTRACTION}. In
     * band, next to the number, because a `0` with no scope reads as "nothing anywhere hit a
     * cap" and only one surface emits the event today.
     */
    scope: typeof CAP_BREACH_SCOPE_PROFILE_EXTRACTION;
    by_reason: AdminCapBreachBucket[];
  };
}

// ---------------------------------------------------------------------------
// Projections — volume
// ---------------------------------------------------------------------------

/**
 * A count bucket over a CLOSED enum. The service emits EVERY member of the enum, including the
 * ones at zero, so the UI renders "suspended: 0" instead of omitting the row — an absent bucket
 * and a zero bucket look identical to a client and mean different things to a reader.
 */
export interface AdminCountBucket<K extends string> {
  key: K;
  count: number;
}

/**
 * The catch-all bucket for a stored value that is NOT a member of the enum.
 *
 * WHY IT EXISTS. Of the five enums this dashboard densifies, exactly ONE is enforced in the
 * database: `job_postings_status_chk`. `workers.status`, `worker_profiles.profile_status`,
 * `payers.role` and `payers.status` are plain `text` columns typed only in TypeScript
 * (`$type<...>()`), so a bad write, a migration, a manual `UPDATE` or an older deploy can put a
 * value there that no member matches. Dropping such a row — the original behaviour — removed it
 * from `by_status` AND from `total`, because the totals are summed from the densified buckets.
 * The headline then quietly stopped equalling `count(*)`: the same silent-undercount failure
 * this whole surface exists to prevent for spend.
 *
 * ALWAYS EMITTED, zero included, for the same reason every enum member is: an absent bucket and
 * a zero bucket are the same JSON. Its presence is what makes `total === count(*)` structural
 * rather than conditional — the total is still summed from the buckets the response carries, so
 * it cannot disagree with its own breakdown, and now it cannot silently shrink either. A client
 * may hide the row while it is zero; it must NOT hide a non-zero one, which is data corruption
 * asking to be looked at.
 */
export const DASHBOARD_OTHER_BUCKET = "other" as const;
export type DashboardOtherBucket = typeof DASHBOARD_OTHER_BUCKET;

/**
 * The densified bucket list for a closed enum: every member, plus {@link DASHBOARD_OTHER_BUCKET}.
 * The `"other"` member is part of the UNION on purpose — a client switch-casing on the key is
 * forced by the type to handle it, rather than meeting it at runtime.
 */
export type AdminEnumBuckets<K extends string> = AdminCountBucket<K | DashboardOtherBucket>[];

export interface AdminVolumeSummary {
  workers: {
    /**
     * `count(*)` over the table, and provably so: it is summed from `by_status`, which now
     * carries an `other` bucket for out-of-enum values, so no row can fall out of the total.
     */
    total: number;
    by_status: AdminEnumBuckets<WorkerStatus>;
    /** Workers with a deletion scheduled (DPDP erasure in flight) — a real operational number. */
    pending_deletion: number;
  };
  /**
   * Profile progress, ONE ROW PER WORKER. Resolved through `CURRENT_PROFILE_ORDER`, not by
   * counting `worker_profiles` rows: a worker gets a new row per extraction job, so a naive
   * count double-counts every re-interviewed worker and lets a placeholder row written during
   * an ai-service outage outrank the real profile beside it.
   */
  worker_profiles: {
    workers_with_profile: number;
    by_status: AdminEnumBuckets<ProfileStatus>;
  };
  job_postings: {
    total: number;
    by_status: AdminEnumBuckets<JobPostingStatus>;
  };
  applications: {
    /** Every decision row — applies AND skips. */
    total: number;
    /** `action = 'applied'` only. The growth metric; a skip is not an application. */
    applied: number;
  };
  payers: {
    total: number;
    /** `employer` = company, `agent` = agency. */
    by_role: AdminEnumBuckets<PayerRole>;
    by_status: AdminEnumBuckets<PayerStatus>;
  };
  /**
   * Contact unlocks ISSUED (`granted` or `revealed`) — the demand side of the marketplace.
   * Not the row count: a `denied` unlock issued nothing and was charged for nothing.
   */
  unlocks: { issued: number };
  /** Résumés generated — the artefact the worker product exists to produce. */
  resumes: { total: number };
}

export interface AdminDashboardSummary {
  /** When this snapshot was taken (the counts are not transactionally consistent with it). */
  generated_at: Date;
  ai_cost: AdminAiCostSummary;
  volume: AdminVolumeSummary;
}

/**
 * The closed enums the service densifies against. Imported from `@badabhai/types` (and the two
 * payer literals from the schema) rather than re-listed, so a new status appears on the
 * dashboard the day it is added to the domain instead of the day someone remembers this file.
 */
export const DASHBOARD_WORKER_STATUSES = WORKER_STATUSES;
export const DASHBOARD_PROFILE_STATUSES = PROFILE_STATUSES;
export const DASHBOARD_JOB_POSTING_STATUSES = JOB_POSTING_STATUSES;
/**
 * `PayerRole` / `PayerStatus` are bare TypeScript unions on the schema (`text().$type<...>()`)
 * with no runtime array to import, unlike the `@badabhai/types` enums above — so the list has
 * to be written out here.
 *
 * VIA A `Record<Union, true>`, NOT `satisfies readonly PayerRole[]`. The `satisfies` form
 * accepts any SUBSET, so dropping a member (or adding one to the union and forgetting this
 * line) still compiles and the bucket silently stops being reported. A `Record` keyed on the
 * union is EXHAUSTIVE: omit a member and this file fails to build.
 */
const PAYER_ROLE_KEYS: Record<PayerRole, true> = { employer: true, agent: true };
const PAYER_STATUS_KEYS: Record<PayerStatus, true> = {
  pending: true,
  active: true,
  suspended: true,
};
export const DASHBOARD_PAYER_ROLES = Object.keys(PAYER_ROLE_KEYS) as readonly PayerRole[];
export const DASHBOARD_PAYER_STATUSES = Object.keys(PAYER_STATUS_KEYS) as readonly PayerStatus[];
