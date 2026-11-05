import { z } from "zod";
import type {
  AiAlertsStatus,
  AiRecentAlert,
  AiSpendCapStatus,
  AiTaskAlertStatus,
} from "../ai/ai-alerts.service";

/**
 * Zod DTO + projections for `GET /admin/ai-alerts` (B13, #2567) — the LOUD AI alert
 * surface: per-task fallback posture over a stated window, spend-cap trips, and the
 * recent-alerts feed.
 *
 * ── WHY `read_entities` AND NOT `read_events` OR A NEW CAPABILITY ────────────────────
 * The same call `AdminDashboardController` makes, for the same reason: the response is
 * an aggregate over platform state (counts, shares, thresholds) plus the already-PII-free
 * verdict rows — no worker, payer, session or trace identity anywhere. `read_events` is
 * the append-only audit spine keyed by subject; this names no subject at all.
 *
 * ── PII ──────────────────────────────────────────────────────────────────────────────
 * COUNTS, SHARES, ENUM LABELS AND TIMESTAMPS ONLY. There is not one id in the task or
 * spend blocks; the recent feed carries spine row ids (opaque event uuids) plus task
 * labels and breach reasons. Nothing here can single anybody out.
 *
 * ── THE RESPONSE CONTRACT IS THE ADMIN-WEB CONTRACT ──────────────────────────────────
 * `apps/admin-web/src/lib/ai-alerts.ts` mirrors these shapes (compared, never assumed).
 * Additive changes only: a client that ignores a new key sees exactly the response it
 * saw before (§3 backward compatibility).
 */

/** Hard cap on the alert window (hours). A year of spine is not an alert question. */
export const ADMIN_AI_ALERTS_WINDOW_HOURS_MAX = 168;
export const ADMIN_AI_ALERTS_RECENT_MAX = 100;

/**
 * GET /admin/ai-alerts query. `windowHours` scopes the per-task posture, the spend-cap
 * count AND the recent feed to the same trailing window — one stated window for the
 * whole page, echoed back as `window_hours` so a number can never be read against the
 * wrong one. Defaults to the configured `AI_FALLBACK_ALERT_WINDOW_HOURS`.
 */
export const AdminAiAlertsQuerySchema = z
  .object({
    windowHours: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_AI_ALERTS_WINDOW_HOURS_MAX)
      .optional(),
  })
  .strict();
export type AdminAiAlertsQueryDto = z.infer<typeof AdminAiAlertsQuerySchema>;

/** One task's fallback posture — the wire shape of {@link AiTaskAlertStatus}. */
export type AdminAiTaskAlert = AiTaskAlertStatus;

/** Spend-cap trips — the wire shape of {@link AiSpendCapStatus}. */
export type AdminAiSpendCapAlert = AiSpendCapStatus;

/** One row of the recent-alerts feed — the wire shape of {@link AiRecentAlert}. */
export type AdminAiRecentAlert = AiRecentAlert;

export type AdminAiAlertsStatus = AiAlertsStatus;
