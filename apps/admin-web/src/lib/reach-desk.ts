import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * #2750 items 7 and 8 — the worker desk (`/admin/desk/reach-cases`).
 *
 * A company reports it could not reach a worker it opened; the desk calls him and closes the
 * case. Mirrors `apps/api/src/reach-desk/*`. Capability `work_reach_desk` for every route;
 * the worker's number only comes from the existing reveal (`reveal_pii`), never from here.
 */

export const REACH_CASE_STATUSES = ["open", "resolved", "all"] as const;
export type ReachCaseStatus = (typeof REACH_CASE_STATUSES)[number];

export const REACH_ATTEMPT_RESULTS = [
  "no_answer",
  "busy",
  "switched_off",
  "wrong_number",
  "other",
] as const;
export type ReachAttemptResult = (typeof REACH_ATTEMPT_RESULTS)[number];

export const REACH_OUTCOMES = [
  "reached_interested",
  "reached_declined",
  "not_reached",
] as const;
export type ReachOutcome = (typeof REACH_OUTCOMES)[number];

const caseStateSchema = z.enum([
  "open",
  "reached_interested",
  "reached_declined",
  "not_reached",
]);

export const reachCaseSchema = z.object({
  case_id: z.string(),
  unlock_id: z.string(),
  status: caseStateSchema,
  reported_at: z.string(),
  deadline_at: z.string(),
  resolved_at: z.string().nullable(),
  credits_returned: z.number(),
  payer_id: z.string(),
  worker_id: z.string().nullable(),
  reported_by: z.string(),
  resolved_by: z.string().nullable(),
  resolved_by_admin_id: z.string().nullable(),
  attempts: z.number(),
});
export type ReachCase = z.infer<typeof reachCaseSchema>;

export const reachCaseDetailSchema = reachCaseSchema.extend({
  attempt_log: z.array(
    z.object({
      attempt_id: z.string(),
      admin_id: z.string(),
      result: z.enum(REACH_ATTEMPT_RESULTS),
      attempted_at: z.string(),
    }),
  ),
});
export type ReachCaseDetail = z.infer<typeof reachCaseDetailSchema>;

export const reachCaseListSchema = z.object({
  cases: z.array(reachCaseSchema),
  next_cursor: z.string().nullable(),
});
export type ReachCaseList = z.infer<typeof reachCaseListSchema>;

export function listReachCases(filter: {
  status: ReachCaseStatus;
  cursor?: string;
  limit?: number;
}): Promise<ReachCaseList> {
  const q = new URLSearchParams({ status: filter.status });
  if (filter.cursor) q.set("cursor", filter.cursor);
  if (filter.limit !== undefined) q.set("limit", String(filter.limit));
  return adminFetch(`/admin/desk/reach-cases?${q.toString()}`, { schema: reachCaseListSchema });
}

export function getReachCase(caseId: string): Promise<ReachCaseDetail> {
  return adminFetch(`/admin/desk/reach-cases/${encodeURIComponent(caseId)}`, {
    schema: reachCaseDetailSchema,
  });
}

export function logReachAttempt(caseId: string, result: ReachAttemptResult) {
  return adminFetch(`/admin/desk/reach-cases/${encodeURIComponent(caseId)}/attempts`, {
    method: "POST",
    body: { result },
    schema: reachCaseDetailSchema,
  });
}

export function resolveReachCase(caseId: string, outcome: ReachOutcome, reasonText: string) {
  return adminFetch(`/admin/desk/reach-cases/${encodeURIComponent(caseId)}/resolve`, {
    method: "POST",
    body: { outcome, reason_text: reasonText },
    schema: reachCaseDetailSchema,
  });
}

export function reachCaseLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "reached_interested":
      return "Reached — interested";
    case "reached_declined":
      return "Reached — declined";
    case "not_reached":
      return "Not reached";
    default:
      return status.replace(/_/g, " ");
  }
}

/** Whole hours/minutes left from `now` to `deadline`; "overdue" once past. */
export function timeLeft(deadline: string, now: number): string {
  const ms = new Date(deadline).getTime() - now;
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "Overdue";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 1) return `${hours}h ${minutes % 60}m left`;
  return `${minutes}m left`;
}
