import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import { POSTING_REASON_CODES, type PostingReasonCode } from "./company-vocabulary";

/**
 * #2891 — BadaBhai worker visibility of Campus-origin postings.
 *
 * Mirrors `apps/api/src/admin-postings/admin-posting-worker-visibility.*`. Gated on
 * `manage_postings`. Every write carries a closed reason code and a 15–500 character reason.
 */

export const WORKER_VISIBILITY_FILTERS = ["waiting", "off", "on"] as const;
export type WorkerVisibilityFilter = (typeof WORKER_VISIBILITY_FILTERS)[number];

export const WORKER_VISIBILITY_OUTCOMES = [
  "changed",
  "unchanged",
  "trade_required",
  "audience_excludes_workers",
  "not_campus_origin",
] as const;
export type WorkerVisibilityOutcome = (typeof WORKER_VISIBILITY_OUTCOMES)[number];

export const campusPostingSchema = z.object({
  posting_id: z.string(),
  company_id: z.string().nullable(),
  company_label: z.string(),
  title: z.string(),
  city: z.string().nullable(),
  role_kind: z.string().nullable(),
  trade_ready: z.boolean(),
  status: z.string(),
  hidden: z.boolean(),
  audience: z.string().nullable(),
  rvm_review_state: z.string().nullable(),
  origin: z.string(),
  worker_visibility: z.enum(["off", "on"]),
  decided_by_admin_id: z.string().nullable(),
  decided_at: z.string().nullable(),
  arrived_at: z.string(),
});
export type CampusPosting = z.infer<typeof campusPostingSchema>;

export const campusPostingsPageSchema = z.object({
  postings: z.array(campusPostingSchema),
  next_cursor: z.string().nullable(),
});
export type CampusPostingsPage = z.infer<typeof campusPostingsPageSchema>;

export function listCampusPostings(filter: WorkerVisibilityFilter, cursor?: string) {
  const q = new URLSearchParams({ filter });
  if (cursor) q.set("cursor", cursor);
  return adminFetch(`/admin/postings/worker-visibility?${q.toString()}`, {
    schema: campusPostingsPageSchema,
  });
}

const resultSchema = z.object({
  posting_id: z.string(),
  outcome: z.enum(WORKER_VISIBILITY_OUTCOMES),
  state: z.enum(["on", "off"]).nullable(),
});

export function setCampusPostingVisibility(
  postingId: string,
  state: "on" | "off",
  reasonCode: PostingReasonCode,
  reasonText: string,
) {
  return adminFetch(`/admin/postings/${encodeURIComponent(postingId)}/worker-visibility`, {
    method: "POST",
    body: { state, reason_code: reasonCode, reason_text: reasonText },
    schema: resultSchema,
  });
}

export function setCampusPostingsVisibility(
  postingIds: string[],
  state: "on" | "off",
  reasonCode: PostingReasonCode,
  reasonText: string,
) {
  return adminFetch("/admin/postings/worker-visibility", {
    method: "POST",
    body: {
      posting_ids: postingIds,
      state,
      reason_code: reasonCode,
      reason_text: reasonText,
    },
    schema: z.object({ results: z.array(resultSchema) }),
  });
}

export function campusOutcomeCopy(outcome: WorkerVisibilityOutcome): string {
  switch (outcome) {
    case "changed":
      return "Changed";
    case "unchanged":
      return "Already that way";
    case "trade_required":
      return "Set its trade first";
    case "audience_excludes_workers":
      return "Company limited it to RVM students";
    case "not_campus_origin":
      return "Not a Campus job";
  }
}

export { POSTING_REASON_CODES };
