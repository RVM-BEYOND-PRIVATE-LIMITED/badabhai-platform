import { z } from "zod";
import { ADMIN_POSTING_REASON_CODES, AdminPostingReasonText } from "./admin-postings.dto";

/**
 * #2891 — the admin contract for a Campus-origin posting's BadaBhai worker visibility.
 *
 * Ruling of 17 Nov 2026: every Campus job comes to BadaBhai, and shows to BadaBhai workers only
 * after an admin turns its worker visibility on. Per posting, with a bulk action; there is no
 * global "always visible" setting. Every change carries the same written reason as the #2566
 * posting controls (closed code + 15–500 chars, no hard identifiers) and writes `audit_logs`.
 */

/** Which Campus-origin postings the list shows. `waiting` = held, and no admin has decided yet. */
export const WORKER_VISIBILITY_LIST_FILTERS = ["waiting", "off", "on"] as const;
export type WorkerVisibilityListFilter = (typeof WORKER_VISIBILITY_LIST_FILTERS)[number];

export const WorkerVisibilityListQuerySchema = z
  .object({
    filter: z.enum(WORKER_VISIBILITY_LIST_FILTERS).default("waiting"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type WorkerVisibilityListQueryDto = z.infer<typeof WorkerVisibilityListQuerySchema>;

const VisibilityState = z.enum(["on", "off"]);

export const WorkerVisibilitySetSchema = z
  .object({
    state: VisibilityState,
    reason_code: z.enum(ADMIN_POSTING_REASON_CODES),
    reason_text: AdminPostingReasonText,
  })
  .strict();
export type WorkerVisibilitySetDto = z.infer<typeof WorkerVisibilitySetSchema>;

/** At most this many postings in one bulk call; each is its own transaction and audit row. */
export const WORKER_VISIBILITY_BULK_MAX = 100;

export const WorkerVisibilityBulkSchema = z
  .object({
    posting_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(WORKER_VISIBILITY_BULK_MAX)
      .refine((ids) => new Set(ids).size === ids.length, "posting_ids must not repeat"),
    state: VisibilityState,
    reason_code: z.enum(ADMIN_POSTING_REASON_CODES),
    reason_text: AdminPostingReasonText,
  })
  .strict();
export type WorkerVisibilityBulkDto = z.infer<typeof WorkerVisibilityBulkSchema>;

/**
 * What one posting's change came to.
 *  - `changed` — the state (or the first decision on a waiting posting) was written.
 *  - `unchanged` — already decided this way; nothing written.
 *  - `not_campus_origin` — the posting has no visibility row (it did not come from Campus) or does
 *    not exist. Never created here: the control exists only for Campus-origin postings.
 *  - `audience_excludes_workers` — `on` was asked, but the posting's own audience is RVM students
 *    only (the company narrowed it), so turning it on would change nothing a worker sees.
 *  - `trade_required` — `on` was asked, but the posting names none of the 16 trades. A posting on
 *    a worker surface must name one (#2635, owner ruling 2026-11-04; the same gate a company
 *    publish and a company widening to BadaBhai workers pass). Set its trade with
 *    `PATCH admin/postings/:id/edit` (`role_kind`), then turn it on.
 */
export type WorkerVisibilityOutcome =
  | "changed"
  | "unchanged"
  | "not_campus_origin"
  | "audience_excludes_workers"
  | "trade_required";

export interface WorkerVisibilityResult {
  posting_id: string;
  outcome: WorkerVisibilityOutcome;
  state: "on" | "off" | null;
}
