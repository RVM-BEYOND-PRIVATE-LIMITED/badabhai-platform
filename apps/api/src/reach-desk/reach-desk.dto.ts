import { z } from "zod";
import { AdminPayerReasonTextSchema } from "../admin/admin-payer-logins.dto";

/**
 * #2750 item 7 — the desk's contract. Closed codes only: an attempt is a result code (no notes,
 * where a number or a name would end up), a close is an outcome and a written reason (15–500
 * characters, no hard identifiers, the shared admin reason rule) stored on `audit_logs`.
 */
export const ReachCasesQuerySchema = z
  .object({
    status: z.enum(["open", "resolved", "all"]).default("open"),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ReachCasesQuery = z.infer<typeof ReachCasesQuerySchema>;

export const ReachAttemptSchema = z
  .object({
    result: z.enum(["no_answer", "busy", "switched_off", "wrong_number", "other"]),
  })
  .strict();
export type ReachAttemptDto = z.infer<typeof ReachAttemptSchema>;

export const ReachResolveSchema = z
  .object({
    outcome: z.enum(["reached_interested", "reached_declined", "not_reached"]),
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict();
export type ReachResolveDto = z.infer<typeof ReachResolveSchema>;
