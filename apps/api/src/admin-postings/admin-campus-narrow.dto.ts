import { z } from "zod";
import { tradeLevelSchema } from "../common/trade-fields.schemas";
import { ADMIN_POSTING_REASON_CODES, AdminPostingReasonText } from "./admin-postings.dto";

/**
 * #3033 — the admin contract for narrowing an old Campus job off the general CNC skill.
 *
 * Standing decision 3 of the CEO pack: a Campus job whose role was "Machine Operator" or
 * "CNC Operator" arrives on the live general CNC skill (`mskill_cnc_operator_general`) and
 * waits for an admin to narrow it to ONE of these six machine trades, from the job text.
 * The screen (#3050) offers exactly these six, with an optional level from that trade's
 * ladder; the dialog closes by its buttons only, and on save the row leaves the queue.
 *
 * The write reuses the #2566 edit path (`prepareAdminEdit` → `normalizeSelection` → reach
 * rebuild → audit + `posting_edited`), so narrowing runs the SAME validation a company edit
 * runs. A trade whose posting switch is off (#3002, e.g. Injection Moulding before #3013
 * switches Wave 1 on) is refused with `trade_not_released`: the translation table never
 * attaches a Campus job to a trade companies cannot post (#3014).
 */

/** The six machine trades an admin may narrow a general-CNC Campus job to (pack codes). */
export const NARROWABLE_ROLE_KINDS = [
  "cnc_turner",
  "vmc_milling",
  "cnc_grinding",
  "sheet_metal_worker",
  "press_operator",
  "injection_moulding_operator",
] as const;
export type NarrowableRoleKind = (typeof NARROWABLE_ROLE_KINDS)[number];

export const NarrowQueueQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type NarrowQueueQueryDto = z.infer<typeof NarrowQueueQuerySchema>;

/** One queued job as the admin screen reads it. */
export interface NarrowQueueItem {
  posting_id: string;
  company_id: string | null;
  company_label: string;
  /** The posting's title — for a Campus job this IS the Campus role text it came with. */
  title: string;
  /** The Campus role text the job came with (the title a Campus writer stored). */
  campus_role_text: string;
  origin: "campus_posted" | "campus_imported";
  /** When the posting became worker-visible, else when it was created. */
  posted_at: string;
}

/** Narrow one posting: the trade, optionally its ladder rung, and the written reason. */
export const NarrowTradeSchema = z
  .object({
    role_kind: z.enum(NARROWABLE_ROLE_KINDS),
    trade_level: tradeLevelSchema.optional(),
    reason_code: z.enum(ADMIN_POSTING_REASON_CODES),
    reason_text: AdminPostingReasonText,
  })
  .strict();
export type NarrowTradeDto = z.infer<typeof NarrowTradeSchema>;

/**
 * What one narrowing came to. Every refusal stores nothing:
 *  - `changed` — the trade replaced the general skill; the row left the queue.
 *  - `not_found` — no such posting.
 *  - `not_campus_origin` — the posting has no Campus hold row (it did not come from Campus).
 *  - `not_narrowable` — closed, or a status that never queues, or the posting no longer
 *    carries exactly the general skill (already narrowed, or never general).
 *  - `posting_closed` — closed postings are not changed.
 *  - `trade_not_released` — one of the six, but its posting switch is off (or its form is
 *    not seeded yet): narrowing waits for the owner to switch the wave on.
 */
export type NarrowTradeOutcome =
  | "changed"
  | "not_found"
  | "not_campus_origin"
  | "not_narrowable"
  | "posting_closed"
  | "trade_not_released";

export interface NarrowTradeResult {
  posting_id: string;
  outcome: NarrowTradeOutcome;
  /** The posting's trade and match skills after the call (null when it does not exist). */
  role_kind: string | null;
  match_skill_ids: string[] | null;
}
