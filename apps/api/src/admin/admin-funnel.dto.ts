import { z } from "zod";

/**
 * Zod DTO + projections for `GET /admin/funnel/onboarding` (B14, #2568) — the
 * onboarding funnel across ALL workers: how many sit at each of the 7 journey steps
 * and where they stopped, split by trade / city / language / app version.
 *
 * ── THE SAME 7 STEPS AS THE PER-WORKER JOURNEY, AND THAT IS A REQUIREMENT ──────────
 * Every status rule here mirrors `AdminWorkerJourneyService.getJourneySummary` for the
 * same worker state — `progressStatus` for profiling, `confirmed` for the profile,
 * `applied > 0` for search/apply, photo presence, kit downloads, login always done.
 * The rules are restated (not imported) because the per-worker code reads one worker's
 * rows and this reads the whole base in grouped aggregates; what keeps the two from
 * drifting is not a shared helper but the parity gate:
 * `admin-funnel.parity.db.test.ts` seeds one cohort, runs BOTH surfaces, and asserts
 * the totals match the per-worker summaries worker for worker.
 *
 * ── PII ────────────────────────────────────────────────────────────────────────────
 * COUNTS, STEP KEYS AND SPLIT LABELS ONLY. No worker id, no name, no phone, no prompt,
 * no answer value. City and app-version labels are worker-provided strings, so split
 * cells below the k-anon floor report NOTHING (not even their count) — the same floor
 * `AdminEventsService` applies to its funnel (`K_ANON_FLOOR = 5`), for the same reason:
 * a count of 1 in a cell is a named worker to anyone who knows the base.
 *
 * ── WHY `read_entities` AND NOT `read_events` OR A NEW CAPABILITY ──────────────────
 * The dashboard's documented call: aggregates over platform state, no subject pivot.
 * The two spine signals (search counts, kit downloads) arrive pre-aggregated per
 * worker through the single spine reader; nothing here pivots the spine by subject.
 *
 * ── NO AUDIT EVENT ─────────────────────────────────────────────────────────────────
 * A read is not a state change (dashboard and metrics reads emit nothing). The
 * per-worker journey emits `admin.worker_journey_viewed` because it returns one
 * person's behavioural profile at full granularity. This returns k-anon'd aggregates
 * over the base — the dashboard's data class, not the journey's.
 */

/** Closed set of test-account handling — deny-by-default, like every other enum here. */
export const ADMIN_FUNNEL_TEST_ACCOUNTS = ["exclude", "include", "only"] as const;
export type AdminFunnelTestAccounts = (typeof ADMIN_FUNNEL_TEST_ACCOUNTS)[number];

/**
 * The k-anon floor for split CELLS. Matches `AdminEventsService.K_ANON_FLOOR` (and the
 * agency `MIN_BUCKET`) — one shared number for "too few workers to report", so a cell
 * this portal suppresses and a funnel cell the events explorer suppresses agree on
 * what "few" means. A separate constant (rather than an import of the service) because
 * this file is the wire contract; the comment is what keeps the two values together.
 */
export const ADMIN_FUNNEL_K_ANON_FLOOR = 5;

/** Hard cap on distinct values per OPEN split (city, app version) — the tail folds into `other`. */
export const ADMIN_FUNNEL_SPLIT_VALUE_MAX = 100;
export const ADMIN_FUNNEL_OTHER_BUCKET = "other" as const;

/** Unrecorded split dimension — the honest bucket, never a dropped worker. */
export const ADMIN_FUNNEL_UNKNOWN_BUCKET = "unknown" as const;

/**
 * GET /admin/funnel/onboarding query. `signupFrom`/`signupTo` scope the cohort to a
 * sign-up window (inclusive from, exclusive to); absent means the whole base.
 * `testAccounts` excludes test traffic by default.
 */
export const AdminFunnelQuerySchema = z
  .object({
    signupFrom: z.coerce.date().optional(),
    signupTo: z.coerce.date().optional(),
    testAccounts: z.enum(ADMIN_FUNNEL_TEST_ACCOUNTS).optional().default("exclude"),
  })
  .strict()
  .refine(
    (q) => q.signupFrom === undefined || q.signupTo === undefined || q.signupFrom <= q.signupTo,
    {
      message: "signupFrom must not be after signupTo",
    },
  );
export type AdminFunnelQueryDto = z.infer<typeof AdminFunnelQuerySchema>;

/** The 7 funnel steps, in order — the same keys the per-worker journey serves. */
export const ADMIN_FUNNEL_STEP_KEYS = [
  "login",
  "profiling",
  "resume",
  "profile_confirmed",
  "job_search_apply",
  "photo",
  "interview_kit",
] as const;
export type AdminFunnelStepKey = (typeof ADMIN_FUNNEL_STEP_KEYS)[number];

/** Where a worker stopped: the first step (in order) that is not `done` — or `completed`. */
export type AdminFunnelStopKey = AdminFunnelStepKey | "completed";

/** One step's counts across the cohort. */
export interface AdminFunnelStepCounts {
  key: AdminFunnelStepKey;
  order: number;
  done: number;
  in_progress: number;
  not_done: number;
}

/** One stop bucket: how many workers are currently held at this step (or finished all). */
export interface AdminFunnelStopBucket {
  key: AdminFunnelStopKey;
  count: number;
}

/** One split cell. Below the k-anon floor the cell reports nothing but its label. */
export interface AdminFunnelSplitCell {
  value: string;
  total: number;
  suppressed: boolean;
  stopped_at: AdminFunnelStopBucket[];
}

export type AdminFunnelSplits = Record<
  "trade" | "city" | "language" | "app_version",
  AdminFunnelSplitCell[]
>;

export interface AdminOnboardingFunnel {
  /** When this snapshot was computed. The reads are not transactionally consistent with it. */
  generated_at: Date;
  /** The cohort bound, echoed so a number can never be read against the wrong window. */
  signup_from: Date | null;
  signup_to: Date | null;
  test_accounts: AdminFunnelTestAccounts;
  /** Cohort size — the denominator every step count below divides into. */
  total_workers: number;
  /** Always all seven steps, in order. */
  steps: AdminFunnelStepCounts[];
  /** Always all seven stop keys plus `completed` — a stop is never omitted, only zero. */
  stopped_at: AdminFunnelStopBucket[];
  splits: AdminFunnelSplits;
  /**
   * Honest-absence channel (the journey's `JOURNEY_CAVEATS` vocabulary). Today always
   * `["interview_kit_attribution_since_0079"]` — kit downloads carry a worker id only
   * from migration 0079, so a zero there is "no ATTRIBUTED download", never "no kit".
   */
  caveats: string[];
}
