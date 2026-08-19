import { z } from "zod";
import {
  JOB_POSTING_STATUSES,
  PROFILE_STATUSES,
  WORKER_STATUSES,
  type JobPostingStatus,
  type ProfileStatus,
  type WorkerStatus,
} from "@badabhai/types";
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
 * ── PROVIDER LABELS ARE RAW, AND NOT AN ENUM ────────────────────────────────────────────
 * `platform_ai_cost_totals.provider` is a `text` column fed from `AICallMetadata.provider`,
 * which the ai-service derives with `provider_for_model()`. The values that function can
 * actually produce today are `"google"`, `"anthropic"`, `"openai"` and `"unknown"` — plus the
 * literal `"unknown"` that `AiCostRecorder` substitutes for an empty label. So:
 *
 *   - Gemini  → `"google"`
 *   - Claude  → `"anthropic"`
 *   - Sarvam  → **`"unknown"`**. Sarvam STT is priced per call, not per token, and its model
 *     name (`saarika:v2.5`) matches none of `provider_for_model`'s substring rules, so every
 *     rupee of STT spend lands in the `unknown` bucket. That is a defect in the ai-service's
 *     label derivation (out of this module's boundary — apps/ai-service is not ours to edit),
 *     and it is REPORTED rather than papered over: mapping `unknown → Sarvam` here would be a
 *     read-layer guess that also silently mislabels every genuinely-unlabelled call.
 *
 * `by_task_type` is what makes that bucket readable in the meantime — STT spend is exactly the
 * `stt_transcription` row — which is why the (provider, task_type) PK's other half is surfaced
 * rather than dropped. This DTO does NOT hardcode either list: both are open sets, and an enum
 * here would silently drop the first provider added after it was written.
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
  cap_breaches: {
    window_days: number;
    total: number;
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

export interface AdminVolumeSummary {
  workers: {
    total: number;
    by_status: AdminCountBucket<WorkerStatus>[];
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
    by_status: AdminCountBucket<ProfileStatus>[];
  };
  job_postings: {
    total: number;
    by_status: AdminCountBucket<JobPostingStatus>[];
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
    by_role: AdminCountBucket<PayerRole>[];
    by_status: AdminCountBucket<PayerStatus>[];
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
