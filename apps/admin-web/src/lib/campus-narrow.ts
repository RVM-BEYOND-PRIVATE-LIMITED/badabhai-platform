import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import { POSTING_REASON_CODES, type PostingReasonCode } from "./company-vocabulary";
import { NARROWABLE_ROLE_KINDS, type NarrowableRoleKind } from "./campus-narrow-view";

/**
 * #3033 / #3050 — the Campus narrow queue.
 *
 * Mirrors `apps/api/src/admin-postings/admin-campus-narrow.*`:
 *
 *   GET  /admin/postings/campus-narrow-queue   open Campus jobs on the general CNC skill only
 *   POST /admin/postings/:id/narrow-trade      narrow one to one of six machine trades
 *
 * Both sit on `manage_postings`. The queue is read-only; the write runs the same edit path a
 * company edit runs and records who narrowed the job and from what.
 */

export const NARROW_QUEUE_ORIGINS = ["campus_posted", "campus_imported"] as const;
export type NarrowQueueOrigin = (typeof NARROW_QUEUE_ORIGINS)[number];

export const NARROW_TRADE_OUTCOMES = [
  "changed",
  "not_found",
  "not_campus_origin",
  "not_narrowable",
  "posting_closed",
  "trade_not_released",
] as const;
export type NarrowTradeOutcome = (typeof NARROW_TRADE_OUTCOMES)[number];

export const narrowQueueItemSchema = z.object({
  posting_id: z.string(),
  company_id: z.string().nullable(),
  company_label: z.string(),
  title: z.string(),
  campus_role_text: z.string(),
  origin: z.enum(NARROW_QUEUE_ORIGINS),
  posted_at: z.string(),
});
export type NarrowQueueItem = z.infer<typeof narrowQueueItemSchema>;

export const narrowQueuePageSchema = z.object({
  postings: z.array(narrowQueueItemSchema),
  next_cursor: z.string().nullable(),
});
export type NarrowQueuePage = z.infer<typeof narrowQueuePageSchema>;

/** The API's own page-size ceiling. */
const NARROW_QUEUE_MAX_LIMIT = 200;

export function listNarrowQueue(cursor?: string, limit?: number) {
  const q = new URLSearchParams();
  if (cursor) q.set("cursor", cursor);
  if (limit !== undefined) q.set("limit", String(limit));
  const qs = q.toString();
  return adminFetch(`/admin/postings/campus-narrow-queue${qs ? `?${qs}` : ""}`, {
    schema: narrowQueuePageSchema,
  });
}

/**
 * The number waiting, for the navigation badge. The API's page carries a cursor rather than a
 * total, so the count is a walk of the pages — the queue is small and a page is one read. A
 * cursor that repeats stops the walk instead of looping; a failed read is the caller's to
 * hide, never a zero that claims the queue is empty.
 */
export async function countNarrowQueue(): Promise<number> {
  let cursor: string | undefined;
  let total = 0;
  const seen = new Set<string>();
  for (;;) {
    const page = await listNarrowQueue(cursor, NARROW_QUEUE_MAX_LIMIT);
    total += page.postings.length;
    const next = page.next_cursor;
    if (!next || page.postings.length === 0 || seen.has(next)) return total;
    seen.add(next);
    cursor = next;
  }
}

export const narrowTradeResultSchema = z.object({
  posting_id: z.string(),
  outcome: z.enum(NARROW_TRADE_OUTCOMES),
  role_kind: z.string().nullable(),
  match_skill_ids: z.array(z.string()).nullable(),
});
export type NarrowTradeResult = z.infer<typeof narrowTradeResultSchema>;

export interface NarrowTradeBody {
  role_kind: NarrowableRoleKind;
  trade_level?: string;
  reason_code: PostingReasonCode;
  reason_text: string;
}

export function narrowPosting(postingId: string, body: NarrowTradeBody) {
  return adminFetch(`/admin/postings/${encodeURIComponent(postingId)}/narrow-trade`, {
    method: "POST",
    body,
    schema: narrowTradeResultSchema,
  });
}

export { NARROWABLE_ROLE_KINDS, POSTING_REASON_CODES };
