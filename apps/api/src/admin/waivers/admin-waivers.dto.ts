import { z } from "zod";
import { WaiverEndDateSchema } from "../../campus-link/campus-link.contract";
import { AdminPayerReasonTextSchema } from "../admin-payer-logins.dto";

/**
 * #2750 items 5 and 12 — the admin contract for the placement team's waivers.
 *
 * `PUT /admin/waivers` sets (`active: true`) or clears (`active: false`) the waiver of ONE company
 * (`scope: company`) or ONE job (`scope: job`, with `posting_id`). The admin is the session's
 * (`@CurrentAdmin().id`); no body field names one. `reason_text` (15–500 characters, no hard
 * identifiers) is stored on the waiver and on the `audit_logs` row of the same transaction.
 *
 * #2778 `ends_on` (optional, with `active: true` only, while RVM_WAIVER_END_DATES_ENABLED is on):
 * the last day (`YYYY-MM-DD`, India time, today or later) the new waiver applies.
 */
export const AdminSetWaiverSchema = z
  .object({
    scope: z.enum(["company", "job"]),
    company_id: z.string().uuid(),
    posting_id: z.string().uuid().optional(),
    active: z.boolean(),
    reason_text: AdminPayerReasonTextSchema,
    ends_on: WaiverEndDateSchema.optional(),
  })
  .strict()
  .refine((b) => (b.scope === "job") === (b.posting_id !== undefined), {
    message: "posting_id is required for a job waiver and refused for a company waiver",
    path: ["posting_id"],
  })
  .refine((b) => b.active || b.ends_on === undefined, {
    message: "ends_on is only sent with active: true",
    path: ["ends_on"],
  });
export type AdminSetWaiverDto = z.infer<typeof AdminSetWaiverSchema>;

/** `GET /admin/waivers`: active only unless `include_cleared=true`; one company's if named. */
export const AdminListWaiversQuerySchema = z
  .object({
    company_id: z.string().uuid().optional(),
    include_cleared: z.enum(["true", "false"]).optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type AdminListWaiversQuery = z.infer<typeof AdminListWaiversQuerySchema>;

/** One waiver: the same fields as the Campus contract's `CampusWaiverSchema`. */
export interface AdminWaiverResponse {
  readonly waiver_id: string;
  readonly scope: "company" | "job";
  readonly company_id: string;
  readonly posting_id: string | null;
  readonly active: boolean;
  readonly source: "campus" | "admin";
  readonly set_by_ref: string;
  readonly set_by_label: string | null;
  readonly reason: string;
  readonly set_at: string;
  readonly cleared_at: string | null;
  readonly cleared_by_ref: string | null;
  readonly cleared_by_label: string | null;
  readonly clear_reason: string | null;
  readonly waived_opens: number;
  /** #2778 — the last day it applies (`YYYY-MM-DD`, India time); null when it runs until cleared. */
  readonly ends_on: string | null;
  /** #2778 — its last day has passed: it frees nobody, though `active` stays true until cleared. */
  readonly ended: boolean;
}

/** `PUT /admin/waivers`: the scope's state after the call (as the Campus route answers it). */
export interface AdminSetWaiverResponse {
  readonly active: boolean;
  readonly changed: boolean;
  readonly waiver: AdminWaiverResponse | null;
}

/** `GET /admin/waivers`. */
export interface AdminWaiverPageResponse {
  readonly waivers: readonly AdminWaiverResponse[];
  readonly next_cursor: string | null;
}
