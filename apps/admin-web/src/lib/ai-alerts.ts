import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * The LOUD-AI-ALERTS data layer — `GET /admin/ai-alerts` (B13, #2567): per-task
 * fallback posture over a stated window, spend-cap trips, and the recent-alerts feed.
 *
 * Its own module rather than a block inside `dashboard.ts`, for the same reason
 * `events.ts` is its own: one module per admin API surface, so a controller's contract
 * has exactly one mirror on this side. Everything else here follows `dashboard.ts`
 * verbatim — `server-only`, `adminFetch`, and every response parsed rather than trusted.
 *
 * ── MIRRORED FROM `apps/api/src/admin/admin-ai-alerts.dto.ts` ─────────────────────────
 * Compared, never assumed — the same rule `ai-cost.ts` states for the dashboard codes:
 * the server owns the contract, this file re-states it in zod, and a field the server
 * adds must appear here the day it ships. Screens arrive separately (#2580); this is
 * the typed fetch + the pure copy helpers the screens will read.
 *
 * ── OPEN SETS STAY OPEN ────────────────────────────────────────────────────────────────
 * `task_type` and the breach `reason` are `z.string()`, not enums — the API DTO is
 * explicit that both are read out of stored rows. An enum here would reject the whole
 * response the first time a new task ships, blanking the page over a value the UI could
 * simply have displayed.
 */

// ---------------------------------------------------------------------------
// Wire shapes (mirrored)
// ---------------------------------------------------------------------------

const aiTaskAlertSchema = z.object({
  task_type: z.string(),
  window_hours: z.number(),
  total_calls: z.number(),
  real_calls: z.number(),
  fallback_calls: z.number(),
  fallback_share: z.number(),
  breaching: z.boolean(),
  last_alert: z.enum(["raised", "cleared"]).nullable(),
  active: z.boolean(),
});
export type AdminAiTaskAlert = z.infer<typeof aiTaskAlertSchema>;

const aiSpendCapAlertSchema = z.object({
  window_hours: z.number(),
  breach_count: z.number(),
  active: z.boolean(),
});
export type AdminAiSpendCapAlert = z.infer<typeof aiSpendCapAlertSchema>;

const aiRecentAlertSchema = z.object({
  id: z.string(),
  event_name: z.string(),
  occurred_at: z.string(),
  task_type: z.string().nullable(),
  reason: z.string().nullable(),
});
export type AdminAiRecentAlert = z.infer<typeof aiRecentAlertSchema>;

/** Exported so tests can parse a captured payload through the REAL schema. */
export const aiAlertsStatusSchema = z.object({
  generated_at: z.string(),
  window_hours: z.number(),
  thresholds: z.object({ min_calls: z.number(), fallback_share: z.number() }),
  tasks: z.array(aiTaskAlertSchema),
  spend_cap: aiSpendCapAlertSchema,
  recent_alerts: z.array(aiRecentAlertSchema),
});
export type AdminAiAlertsStatus = z.infer<typeof aiAlertsStatusSchema>;

/**
 * Active + recent AI alerts. Requires `read_entities`.
 *
 * `windowHours` (1..168) scopes EVERY block to the same trailing window; the response
 * repeats the window, and that echoed value — never the argument passed here — is what
 * the UI renders.
 */
export function getAiAlertsStatus(windowHours?: number) {
  const q = windowHours ? `?windowHours=${windowHours}` : "";
  return adminFetch(`/admin/ai-alerts${q}`, { schema: aiAlertsStatusSchema });
}

// ---------------------------------------------------------------------------
// Pure copy helpers (no DOM, no fetch — testable like `ai-cost.ts`)
// ---------------------------------------------------------------------------

/**
 * What a task's fallback share actually says.
 *
 * A `0` with no recorded calls is not an all-clear — it is "no RECORDED call fell
 * back" (a total transport failure emits no cost row at all). The sentence says which,
 * so a quiet window during an outage cannot be read as health.
 */
export function describeTaskFallback(task: {
  task_type: string;
  total_calls: number;
  fallback_calls: number;
  fallback_share: number;
  breaching: boolean;
}): string {
  const pct = (task.fallback_share * 100).toFixed(1);
  if (task.total_calls === 0) {
    return `${task.task_type}: no recorded calls in the window — silence, not an all-clear.`;
  }
  const verdict = task.breaching ? "BREACHING" : "within threshold";
  return (
    `${task.task_type}: ${task.fallback_calls}/${task.total_calls} recorded calls fell back ` +
    `(${pct}% — ${verdict}).`
  );
}

/**
 * The spend-cap block as a sentence. A `0` here is "no recorded trip", and — like the
 * dashboard's breach scope — it covers only surfaces that emit `ai.spend_cap_exceeded`.
 */
export function describeSpendCap(spend: { breach_count: number; window_hours: number }): string {
  if (spend.breach_count === 0) {
    return `No spend-cap trip recorded in the last ${spend.window_hours}h.`;
  }
  const trips = spend.breach_count === 1 ? "trip" : "trips";
  return `${spend.breach_count} spend-cap ${trips} in the last ${spend.window_hours}h.`;
}
