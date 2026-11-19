import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import {
  AUDIENCE_FILTERS,
  AUDIENCE_OUTCOMES,
  JOB_AUDIENCES,
  SHOWN_TO,
  type AudienceFilter,
  type JobAudience,
} from "./job-audience-vocabulary";
import type { PostingReasonCode } from "./company-vocabulary";

/**
 * #2956 / #2958 — WHERE A JOB SHOWS, decided by an admin (owner direction of 19 Nov 2026, ADR-0068):
 * Campus only (`rvm_students`), both, or BadaBhai only (`badabhai_workers`). The API is
 * `apps/api/src/admin-postings/admin-posting-audience.*` and `admin-campus-trades.*`, behind
 * `ADMIN_JOB_AUDIENCE_ENABLED` (a 404 while it is off).
 *
 * Every write goes through the BULK route, even for one job: one shape for the job page and the
 * list, and each posting comes back with its own outcome.
 */

export const audienceListItemSchema = z.object({
  posting_id: z.string(),
  company_id: z.string().nullable(),
  company_label: z.string(),
  title: z.string(),
  city: z.string().nullable(),
  role_kind: z.string().nullable(),
  trade_ready: z.boolean(),
  taught_at_campus: z.boolean(),
  vacancy_band: z.string(),
  status: z.string(),
  hidden: z.boolean(),
  audience: z.enum(JOB_AUDIENCES),
  shown_to: z.enum(SHOWN_TO),
  rvm_branch_ids: z.array(z.number()),
  rvm_course_ids: z.array(z.string()),
  rvm_review_state: z.enum(["pending", "approved", "rejected"]).nullable(),
  campus_origin: z.enum(["campus_posted", "campus_imported"]).nullable(),
  decided_by_admin_id: z.string().nullable(),
  decided_at: z.string().nullable(),
  changed_since_decision: z.boolean(),
  created_at: z.string(),
});
export type AudienceListItem = z.infer<typeof audienceListItemSchema>;

const listSchema = z.object({
  postings: z.array(audienceListItemSchema),
  next_cursor: z.string().nullable(),
});
export type AudienceListPage = z.infer<typeof listSchema>;

export const audienceResultSchema = z.object({
  posting_id: z.string(),
  outcome: z.enum(AUDIENCE_OUTCOMES),
  shown_to: z.enum(SHOWN_TO).nullable(),
});
export type AudienceResult = z.infer<typeof audienceResultSchema>;

const bulkSchema = z.object({ results: z.array(audienceResultSchema) });

export async function getAudienceList(
  input: { filter?: AudienceFilter; cursor?: string; limit?: number } = {},
): Promise<AudienceListPage> {
  const qs = new URLSearchParams();
  qs.set("filter", input.filter ?? AUDIENCE_FILTERS[0]);
  if (input.cursor) qs.set("cursor", input.cursor);
  if (input.limit !== undefined) qs.set("limit", String(input.limit));
  return adminFetch(`/admin/postings/audience?${qs.toString()}`, { schema: listSchema });
}

export async function setAudience(input: {
  postingIds: string[];
  audience: JobAudience;
  reasonCode: PostingReasonCode;
  reasonText: string;
}): Promise<AudienceResult[]> {
  const res = await adminFetch("/admin/postings/audience", {
    method: "POST",
    body: {
      posting_ids: input.postingIds,
      audience: input.audience,
      reason_code: input.reasonCode,
      reason_text: input.reasonText,
    },
    schema: bulkSchema,
  });
  return res.results;
}

// ── #2957: the trades RVM trains ────────────────────────────────────────────────────────────

export const campusTradeSchema = z.object({
  trade_key: z.string(),
  taught_at_campus: z.boolean(),
  added_by_admin_id: z.string().nullable(),
  added_at: z.string().nullable(),
  removed_at: z.string().nullable(),
});
export type CampusTrade = z.infer<typeof campusTradeSchema>;

const tradesSchema = z.object({ trades: z.array(campusTradeSchema) });
const tradesPutSchema = tradesSchema.extend({
  added: z.array(z.string()),
  removed: z.array(z.string()),
});
export type CampusTradesWrite = z.infer<typeof tradesPutSchema>;

export async function getCampusTrades(): Promise<CampusTrade[]> {
  const res = await adminFetch("/admin/campus-trades", { schema: tradesSchema });
  return res.trades;
}

export async function setCampusTrades(input: {
  tradeKeys: string[];
  reasonCode: PostingReasonCode;
  reasonText: string;
}): Promise<CampusTradesWrite> {
  return adminFetch("/admin/campus-trades", {
    method: "PUT",
    body: {
      trade_keys: input.tradeKeys,
      reason_code: input.reasonCode,
      reason_text: input.reasonText,
    },
    schema: tradesPutSchema,
  });
}
