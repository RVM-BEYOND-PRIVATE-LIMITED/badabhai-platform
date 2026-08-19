import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * The DASHBOARD data layer — `GET /admin/dashboard/summary` (BP-5): what the platform has
 * SPENT on AI, and how big it is.
 *
 * Its own module rather than a block inside `entities.ts`, for the same reason `events.ts` is
 * its own: one module per admin API surface, so a controller's contract has exactly one
 * mirror on this side. Everything else here follows `entities.ts`/`events.ts` verbatim —
 * `server-only`, `adminFetch`, and every response parsed rather than trusted.
 *
 * ── THREE FIELDS ARE NOT DECORATION, AND THE SCHEMA TREATS THEM AS REQUIRED ──────────────
 * `accruing_since`, `is_lifetime_total` and `caveat` are the API's honesty markers: the spend
 * figures accrue only from migration 0077 forward with NO backfill, so they are "spend since
 * <date>" and never a lifetime total. A response that dropped one of them would let this
 * portal render a partial figure as authoritative, so the schema REQUIRES all three and the
 * read fails closed instead. See `describeAiCostBasis` in `ai-cost.ts` for the rendering rule.
 *
 * ── WHAT IS A STRING AND WHAT IS A NUMBER ───────────────────────────────────────────────
 * Every ₹ amount on this surface is a decimal STRING (`numeric(16,6)`, serialised verbatim)
 * and stays one all the way to the formatter. Counts are plain numbers. Coercing the money to
 * a number here would throw away the exactness the column type exists to provide, one step
 * before it is displayed.
 *
 * ── OPEN SETS STAY OPEN ─────────────────────────────────────────────────────────────────
 * `provider`, `task_type` and the breach `reason` are `z.string()`, not enums. The API DTO is
 * explicit that all three are open sets read out of stored rows — an enum here would reject
 * the whole response the first time a new provider is added, blanking the page over a value
 * the UI could simply have displayed.
 */

// ---------------------------------------------------------------------------
// AI cost
// ---------------------------------------------------------------------------

const providerCostBucketSchema = z.object({
  /** The RAW stored label — `sarvam`, `google`, `anthropic`, `openai`, `unknown`, or newer. */
  provider: z.string(),
  total_cost_inr: z.string(),
  call_count: z.number(),
  real_call_count: z.number(),
  first_recorded_at: z.string(),
});
export type ProviderCostBucket = z.infer<typeof providerCostBucketSchema>;

const taskCostBucketSchema = z.object({
  task_type: z.string(),
  total_cost_inr: z.string(),
  call_count: z.number(),
  real_call_count: z.number(),
});
export type TaskCostBucket = z.infer<typeof taskCostBucketSchema>;

const capBreachBucketSchema = z.object({ reason: z.string(), count: z.number() });
export type CapBreachBucket = z.infer<typeof capBreachBucketSchema>;

/** Exported so tests can parse a captured payload through the REAL schema, not around it. */
export const aiCostSummarySchema = z.object({
  /** Null ⇒ nothing has ever accrued. NOT "the platform has spent ₹0 in its lifetime". */
  accruing_since: z.string().nullable(),
  /**
   * `z.boolean()`, not `z.literal(false)`.
   *
   * The API pins it to `false` today and says so in the type, but the field exists precisely
   * because a backfill would one day make it true — and a `z.literal(false)` would turn that
   * intended change into a portal-wide parse failure. Boolean parses both; the renderer
   * switches on it, so the day it flips the caption is already correct.
   */
  is_lifetime_total: z.boolean(),
  /** A stable machine code the caption is keyed off — never prose to be parsed. */
  caveat: z.string(),
  total_cost_inr: z.string(),
  total_calls: z.number(),
  real_calls: z.number(),
  by_provider: z.array(providerCostBucketSchema),
  by_task_type: z.array(taskCostBucketSchema),
  cap_breaches: z.object({
    window_days: z.number(),
    total: z.number(),
    /** WHICH surfaces this count covers. A bare `0` would read as "nothing anywhere". */
    scope: z.string(),
    by_reason: z.array(capBreachBucketSchema),
  }),
});
export type AiCostSummary = z.infer<typeof aiCostSummarySchema>;

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/**
 * One enum bucket. The server densifies every closed enum — every member, zeros included,
 * plus a trailing `other` bucket for stored values the enum does not name.
 *
 * `key` is `z.string()` rather than a mirrored enum on purpose: the members come from
 * `@badabhai/types`, the portal has no business re-declaring them, and a status added
 * server-side must appear here the day it ships rather than rejecting the response.
 */
const countBucketSchema = z.object({ key: z.string(), count: z.number() });
export type CountBucket = z.infer<typeof countBucketSchema>;

/** Exported so tests can parse a captured payload through the REAL schema. */
export const volumeSummarySchema = z.object({
  workers: z.object({
    total: z.number(),
    by_status: z.array(countBucketSchema),
    pending_deletion: z.number(),
  }),
  worker_profiles: z.object({
    workers_with_profile: z.number(),
    by_status: z.array(countBucketSchema),
  }),
  job_postings: z.object({ total: z.number(), by_status: z.array(countBucketSchema) }),
  applications: z.object({ total: z.number(), applied: z.number() }),
  payers: z.object({
    total: z.number(),
    by_role: z.array(countBucketSchema),
    by_status: z.array(countBucketSchema),
  }),
  unlocks: z.object({ issued: z.number() }),
  resumes: z.object({ total: z.number() }),
});
export type VolumeSummary = z.infer<typeof volumeSummarySchema>;

export const dashboardSummarySchema = z.object({
  generated_at: z.string(),
  ai_cost: aiCostSummarySchema,
  volume: volumeSummarySchema,
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

/**
 * Platform AI spend + volume. Requires `read_entities`.
 *
 * `windowDays` (1..90) scopes ONLY the cap-breach counts; the cost totals and every volume
 * count are all-time by construction. The response repeats the window inside the breach block,
 * and that echoed value — never the argument passed here — is what the UI renders.
 */
export function getDashboardSummary(windowDays?: number) {
  const q = windowDays ? `?windowDays=${windowDays}` : "";
  return adminFetch(`/admin/dashboard/summary${q}`, { schema: dashboardSummarySchema });
}
