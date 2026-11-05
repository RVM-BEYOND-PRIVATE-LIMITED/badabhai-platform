import { z } from "zod";
import { containsHardIdentifier } from "../common/hard-identifier";

/**
 * #2566 — the admin posting-control contract.
 *
 * ONE route family serves company postings (`job_postings`) and agency jobs (`jobs`): the
 * service resolves the id to whichever row it names (a twin id resolves to its source job)
 * and validates `changes` with THAT table's own edit schema. Keeping the wire shape
 * table-native is deliberate — the admin drawer sends the same fields the payer/agency edit
 * form already sends, so a field cannot mean one thing on one surface and something else on
 * the other.
 */

/**
 * Why an admin edited, paused, resumed, closed, hid or unhid a posting. CLOSED codes only:
 * the free-text note also lives on `audit_logs`, and neither value ever rides the spine.
 */
export const ADMIN_POSTING_REASON_CODES = [
  "policy_violation",
  "misleading",
  "spam",
  "incorrect_details",
  "low_quality",
  "duplicate",
  "other",
] as const;
export type AdminPostingReasonCode = (typeof ADMIN_POSTING_REASON_CODES)[number];

/** Why an admin verified or rejected a posting's trust review. */
export const ADMIN_POSTING_VERIFICATION_REASON_CODES = [
  "meets_standards",
  "does_not_meet_standards",
  "policy_violation",
  "incorrect_details",
  "other",
] as const;
export type AdminPostingVerificationReasonCode =
  (typeof ADMIN_POSTING_VERIFICATION_REASON_CODES)[number];

/**
 * The written reason every posting write requires. Same rule as the #2562 worker actions:
 * 15–500 chars, and rejected when it contains an email, phone or other hard identifier,
 * because `audit_logs` is a store that account deletion does not reach.
 */
export const AdminPostingReasonText = z
  .string()
  .trim()
  .min(15, "Reason must be at least 15 characters")
  .max(500, "Reason must be at most 500 characters")
  .refine((value) => containsHardIdentifier(value) === null, {
    message: "Reason must not contain an email, phone number or other hard identifier",
  });

export const AdminPostingReasonSchema = z
  .object({
    reason_code: z.enum(ADMIN_POSTING_REASON_CODES),
    reason_text: AdminPostingReasonText,
  })
  .strict();
export type AdminPostingReasonDto = z.infer<typeof AdminPostingReasonSchema>;

export const AdminPostingVerificationReasonSchema = z
  .object({
    reason_code: z.enum(ADMIN_POSTING_VERIFICATION_REASON_CODES),
    reason_text: AdminPostingReasonText,
  })
  .strict();
export type AdminPostingVerificationReasonDto = z.infer<
  typeof AdminPostingVerificationReasonSchema
>;

/**
 * The EDIT body: the reason plus a `changes` object. `changes` is intentionally untyped at
 * the boundary and parsed by the target table's own schema in the service, because the same
 * route may address `job_postings` (payer field names) or `jobs` (agency field names).
 */
export const AdminPostingEditSchema = z
  .object({
    reason_code: z.enum(ADMIN_POSTING_REASON_CODES),
    reason_text: AdminPostingReasonText,
    changes: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AdminPostingEditDto = z.infer<typeof AdminPostingEditSchema>;

/** The `:id` path param — a uuid, never a body value. */
export const AdminPostingTargetParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminPostingTargetParamsDto = z.infer<typeof AdminPostingTargetParamsSchema>;

/** What every action answers with. `target_id` is the CANONICAL row that changed. */
export interface AdminPostingActionResult {
  target_id: string;
  entity_type: "job_posting" | "job";
  /** False on an idempotent no-op (already paused, already hidden, …). */
  changed: boolean;
}
