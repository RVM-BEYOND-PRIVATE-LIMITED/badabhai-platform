import { z } from "zod";
import { WORKER_FEEDBACK_CATEGORIES, type WorkerFeedbackCategory } from "@badabhai/types";

/**
 * GET /admin/feedback — the worker Feedback screen (#997).
 *
 * ── THE ONE NON-FACELESS ADMIN READ, AND WHY IT IS SANCTIONED ────────────────────────────
 * Every other read on this surface is faceless by construction (see `admin-entities.dto.ts`).
 * This one projects `message`, which is worker-authored free text and MAY contain the worker's
 * own PII. That is the feature: #997 rules that storing it and showing it to admins is fine,
 * because the worker chose to say it TO US. What is NOT sanctioned, and does not happen here:
 *   * no worker NAME or PHONE is resolved or joined — a worker is an opaque id, exactly as on
 *     every other admin list. The single sanctioned identity egress remains
 *     `POST /admin/workers/:id/reveal-contact`, with its own capability, default-off flag,
 *     reason code, audit-before-decrypt and rate cap. Nothing here goes near it.
 *   * no free-text SEARCH over `message`. Filtering is by `category` only. A substring search
 *     is a PII discovery tool ("find every worker who typed a phone number") wearing the
 *     costume of a convenience feature.
 *
 * ── PAGINATION ──────────────────────────────────────────────────────────────────────────
 * KEYSET on `(created_at, id)` DESC, never OFFSET, hard-capped page size — the same scheme as
 * every other admin list, served by `worker_feedback_admin_keyset_idx` (and, when `category`
 * is set, by the category-leading composite). Offset paging on an append-only table skips and
 * repeats rows as new feedback lands mid-read, which on this screen looks like feedback
 * vanishing.
 */

/** Hard upper bound on a single feedback page. */
export const ADMIN_FEEDBACK_PAGE_MAX = 100;
export const ADMIN_FEEDBACK_PAGE_DEFAULT = 50;

/**
 * The one query DTO. `.strict()` for the same reason every sibling is strict: silently
 * dropping an unknown filter is how a screen ends up showing an unfiltered list while its URL
 * claims otherwise — a wrong answer that looks like a right one.
 *
 * An unknown `category` is a 400, not a coercion and not an ignored filter. The vocabulary is
 * shared with the DB CHECK and the submit DTO via `WORKER_FEEDBACK_CATEGORIES`, so "a value
 * the reader accepts that the writer cannot produce" is unrepresentable.
 */
export const AdminFeedbackQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_FEEDBACK_PAGE_MAX)
      .optional()
      .default(ADMIN_FEEDBACK_PAGE_DEFAULT),
    category: z.enum(WORKER_FEEDBACK_CATEGORIES).optional(),
  })
  .strict();
export type AdminFeedbackQueryDto = z.infer<typeof AdminFeedbackQuerySchema>;

/**
 * One row on the Feedback screen. Row fields are snake_case; the envelope key is camelCase —
 * the shipped admin convention (see {@link import("./admin-entities.dto").AdminPage}).
 *
 * This interface is the ENTIRE contract, exactly as on the faceless reads: a field absent here
 * is a field the admin surface cannot show, because the repository selects exactly these
 * columns. `worker_id` is an opaque id and stays one — there is deliberately no `worker_name`,
 * no `phone`, and no join that could grow one.
 */
export interface AdminFeedbackListItem {
  id: string;
  worker_id: string;
  /** Null when the worker did not tag their message — "untagged", never coerced to "other". */
  category: WorkerFeedbackCategory | null;
  /** The worker's own words. The sanctioned exception — see the header. */
  message: string;
  /** The `x-app-build` stamp (#966), or null when it was absent or malformed at submit time. */
  app_build: string | null;
  created_at: Date;
}
