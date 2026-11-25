import { z } from "zod";
import { JOB_POSTING_AUDIENCES, audienceReachesRvmStudents } from "@badabhai/db";
import { BranchIdSchema, CourseIdSchema } from "../campus-link/campus-link.contract";
import { ADMIN_POSTING_REASON_CODES, AdminPostingReasonText } from "./admin-postings.dto";

/**
 * #2956 — the admin contract for WHERE A POSTING SHOWS (owner direction of 19 Nov 2026, #2959).
 *
 * An admin, not the company, decides who sees each job: Campus only (`rvm_students`), both
 * (`both`), or BadaBhai only (`badabhai_workers`) — the stored audience values, so one value means
 * one thing on every surface. Branch and course targeting go with a choice that includes Campus.
 * Every change carries the same written reason as the #2566 posting controls (closed code +
 * 15–500 chars, no hard identifiers) and writes `audit_logs`.
 */

const targetingFields = {
  // `[]` = every branch / every course. Bounds mirror `job_postings_rvm_targeting_chk`.
  rvm_branch_ids: z.array(BranchIdSchema).max(50).optional(),
  rvm_course_ids: z.array(CourseIdSchema).max(100).optional(),
} as const;

/** Targeting is only for a choice that includes Campus (`[]` is accepted: it says "none"). */
function targetingFitsAudience(o: {
  audience: (typeof JOB_POSTING_AUDIENCES)[number];
  rvm_branch_ids?: number[];
  rvm_course_ids?: string[];
}): boolean {
  if (audienceReachesRvmStudents(o.audience)) return true;
  return (o.rvm_branch_ids?.length ?? 0) === 0 && (o.rvm_course_ids?.length ?? 0) === 0;
}
const TARGETING_MESSAGE =
  "rvm_branch_ids and rvm_course_ids need an audience that includes RVM students";

export const AudienceSetSchema = z
  .object({
    audience: z.enum(JOB_POSTING_AUDIENCES),
    ...targetingFields,
    reason_code: z.enum(ADMIN_POSTING_REASON_CODES),
    reason_text: AdminPostingReasonText,
  })
  .strict()
  .refine(targetingFitsAudience, { message: TARGETING_MESSAGE, path: ["rvm_branch_ids"] });
export type AudienceSetDto = z.infer<typeof AudienceSetSchema>;

/** At most this many postings in one bulk call; each is its own transaction and audit row. */
export const AUDIENCE_BULK_MAX = 100;

export const AudienceBulkSchema = z
  .object({
    posting_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(AUDIENCE_BULK_MAX)
      .refine((ids) => new Set(ids).size === ids.length, "posting_ids must not repeat"),
    audience: z.enum(JOB_POSTING_AUDIENCES),
    ...targetingFields,
    reason_code: z.enum(ADMIN_POSTING_REASON_CODES),
    reason_text: AdminPostingReasonText,
  })
  .strict()
  .refine(targetingFitsAudience, { message: TARGETING_MESSAGE, path: ["rvm_branch_ids"] });
export type AudienceBulkDto = z.infer<typeof AudienceBulkSchema>;

/**
 * Which live (open or paused, non-agency) postings the list shows:
 *  - `to_decide` — no admin has decided where it shows, and either its trade is taught at Campus
 *    or it came from Campus (held from BadaBhai workers, waiting). The default tab.
 *  - `campus` / `both` / `badabhai` — where it shows NOW (a Campus-origin posting held from
 *    workers counts as Campus only, whatever its stored audience).
 *  - `changed` — an admin decided, and the company has changed what a student sees since
 *    (openings included), so the admin may want to look again.
 */
export const AUDIENCE_LIST_FILTERS = ["to_decide", "campus", "both", "badabhai", "changed"] as const;
export type AudienceListFilter = (typeof AUDIENCE_LIST_FILTERS)[number];

export const AudienceListQuerySchema = z
  .object({
    filter: z.enum(AUDIENCE_LIST_FILTERS).default("to_decide"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type AudienceListQueryDto = z.infer<typeof AudienceListQuerySchema>;

/** Where a posting shows now, as the admin screens name it. */
export type ShownTo = "campus" | "both" | "badabhai" | "nobody";

/**
 * What one posting's change came to.
 *  - `changed` — the audience, targeting, Campus hold or RVM approval was written (or the admin
 *    re-confirmed a job the company changed since the last decision).
 *  - `unchanged` — already decided exactly this way, for the content as it is now.
 *  - `not_found` — no such posting.
 *  - `twin_not_allowed` — an agency job's synced copy; it is BadaBhai only by a database rule.
 *  - `posting_closed` — closed postings are not changed.
 *  - `trade_required` — the choice reaches BadaBhai workers, and the posting is live, but it names
 *    no posting trade (#2635, `postingTradeFor`). Set its trade first
 *    (`PATCH admin/postings/:id/edit`).
 *    Also: a choice that includes Campus on a posting with no trade at all.
 *  - `trade_not_taught_at_campus` — the choice includes Campus, but RVM does not train the
 *    posting's trade (`campus_trades`, #2957). A Campus-origin posting is exempt.
 *  - `targeting_option_not_offered` — a branch or course id is not an active RVM option.
 */
export type AudienceOutcome =
  | "changed"
  | "unchanged"
  | "not_found"
  | "twin_not_allowed"
  | "posting_closed"
  | "trade_required"
  | "trade_not_taught_at_campus"
  | "targeting_option_not_offered";

export interface AudienceResult {
  posting_id: string;
  outcome: AudienceOutcome;
  /** Where the posting shows after the call (null when it does not exist). */
  shown_to: ShownTo | null;
}
