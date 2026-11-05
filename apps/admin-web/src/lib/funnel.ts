import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * The ONBOARDING-FUNNEL data layer — `GET /admin/funnel/onboarding` (B14, #2568): the
 * 7 journey steps counted across the whole base, where workers stop, split by trade /
 * city / language / app version.
 *
 * Its own module rather than a block inside `dashboard.ts`, for the same reason
 * `events.ts` is its own: one module per admin API surface, so a controller's contract
 * has exactly one mirror on this side. Everything else here follows `dashboard.ts`
 * verbatim — `server-only`, `adminFetch`, and every response parsed rather than trusted.
 *
 * ── MIRRORED FROM `apps/api/src/admin/admin-funnel.dto.ts` ─────────────────────────
 * Compared, never assumed — the same rule `ai-cost.ts` states for the dashboard codes:
 * the server owns the contract, this file re-states it in zod, and a field the server
 * adds must appear here the day it ships. Screens arrive separately (#2580); this is
 * the typed fetch + the pure copy helpers the screens will read.
 *
 * ── OPEN SETS STAY OPEN ─────────────────────────────────────────────────────────────
 * Split values, task labels and stop keys are `z.string()`, never enums — the API DTO
 * is explicit that task types and city/app-version labels are read out of stored rows.
 * An enum here would reject the whole response the first time a new trade ships,
 * blanking the page over a value the UI could simply have displayed.
 */

// ---------------------------------------------------------------------------
// Wire shapes (mirrored)
// ---------------------------------------------------------------------------

const funnelStepCountsSchema = z.object({
  key: z.string(),
  order: z.number(),
  done: z.number(),
  in_progress: z.number(),
  not_done: z.number(),
});
export type AdminFunnelStepCounts = z.infer<typeof funnelStepCountsSchema>;

const funnelStopBucketSchema = z.object({ key: z.string(), count: z.number() });
export type AdminFunnelStopBucket = z.infer<typeof funnelStopBucketSchema>;

const funnelSplitCellSchema = z.object({
  value: z.string(),
  total: z.number(),
  suppressed: z.boolean(),
  stopped_at: z.array(funnelStopBucketSchema),
});
export type AdminFunnelSplitCell = z.infer<typeof funnelSplitCellSchema>;

/** Exported so tests can parse a captured payload through the REAL schema. */
export const onboardingFunnelSchema = z.object({
  generated_at: z.string(),
  signup_from: z.string().nullable(),
  signup_to: z.string().nullable(),
  test_accounts: z.string(),
  total_workers: z.number(),
  steps: z.array(funnelStepCountsSchema),
  stopped_at: z.array(funnelStopBucketSchema),
  splits: z.object({
    trade: z.array(funnelSplitCellSchema),
    city: z.array(funnelSplitCellSchema),
    language: z.array(funnelSplitCellSchema),
    app_version: z.array(funnelSplitCellSchema),
  }),
  caveats: z.array(z.string()),
});
export type AdminOnboardingFunnel = z.infer<typeof onboardingFunnelSchema>;

/**
 * Onboarding funnel across all workers. Requires `read_entities`.
 *
 * `signupFrom`/`signupTo` scope the cohort to a sign-up window (ISO strings; absent =
 * the whole base); `testAccounts` is `exclude` (default) | `include` | `only`. The
 * response echoes the cohort bound back — the UI renders the echoed value, never the
 * argument passed here.
 */
export function getOnboardingFunnel(opts?: {
  signupFrom?: string;
  signupTo?: string;
  testAccounts?: string;
}) {
  const q = new URLSearchParams();
  if (opts?.signupFrom) q.set("signupFrom", opts.signupFrom);
  if (opts?.signupTo) q.set("signupTo", opts.signupTo);
  if (opts?.testAccounts) q.set("testAccounts", opts.testAccounts);
  const qs = q.toString();
  return adminFetch(`/admin/funnel/onboarding${qs ? `?${qs}` : ""}`, {
    schema: onboardingFunnelSchema,
  });
}

// ---------------------------------------------------------------------------
// Pure copy helpers (no DOM, no fetch — testable like `ai-cost.ts`)
// ---------------------------------------------------------------------------

/**
 * Where a cohort is held, as one sentence. `stopped_at` is the first non-done step,
 * so the top bucket IS the answer to "where do we lose people".
 */
export function describeFunnelStop(stop: { key: string; count: number }, total: number): string {
  if (total === 0) return "No workers in this cohort — nothing to describe.";
  if (stop.key === "completed") {
    return `${stop.count}/${total} finished every step.`;
  }
  return `${stop.count}/${total} are held at ${stop.key}.`;
}

/**
 * Why a split cell may carry no numbers. A suppressed cell (`total: 0, suppressed`)
 * is a k-anon floor, not a zero — rendering it as "0 workers" would turn a privacy
 * rule into a false measurement, the same silence-means-zero failure the caveats on
 * the dashboard exist to stop.
 */
export function describeSplitCell(cell: {
  value: string;
  total: number;
  suppressed: boolean;
}): string {
  if (cell.suppressed) return `${cell.value}: too few workers to report.`;
  return `${cell.value}: ${cell.total} workers.`;
}
