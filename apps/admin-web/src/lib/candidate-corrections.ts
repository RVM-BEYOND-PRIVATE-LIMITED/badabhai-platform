import "server-only";
import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";
import { adminFetch } from "./admin-http";
import type { CorrectionReasonCode } from "./candidate-edit-model";

/**
 * The admin correction seam (A7, #2577; API #2561): create / re-correct one fact, revert one
 * fact, and read the reason history.
 *
 * The API is `edit_candidates` (super_admin / ops_admin / support), `.strict()` on every body,
 * `Cache-Control: no-store`. One request carries ONE fact; a section save sends one request per
 * changed field, all with the same reason. A re-correction supersedes the live row and keeps the
 * original `previous` so a revert is honest.
 */

export interface CorrectionRequestReason {
  reason_code: CorrectionReasonCode;
  reason_text: string;
}

const correctionResultSchema = z.object({
  worker_id: z.string(),
  fact_key: z.string(),
  override_id: z.string(),
  changed: z.boolean(),
});

const historyItemSchema = z.object({
  override_id: z.string(),
  fact_key: z.string(),
  admin_id: z.string(),
  reason_code: z.string(),
  reason_text: z.string(),
  created_at: z.string(),
  superseded_at: z.string().nullable(),
  superseded_by_id: z.string().nullable(),
  live: z.boolean(),
});

const historySchema = z.object({
  worker_id: z.string(),
  items: z.array(historyItemSchema),
});

export type CorrectionResult = z.infer<typeof correctionResultSchema>;
export type CorrectionHistoryItem = z.infer<typeof historyItemSchema>;
export type CorrectionHistory = z.infer<typeof historySchema>;

/** One fact corrected. A malformed worker id is a 400 from `adminFetch`, before anything is sent. */
export async function createCandidateCorrection(
  workerId: string,
  factKey: string,
  value: unknown,
  reason: CorrectionRequestReason,
): Promise<CorrectionResult> {
  if (!uuidSchema.safeParse(workerId).success) throw new Error("That worker id is not valid.");
  return adminFetch(`/admin/candidates/${encodeURIComponent(workerId)}/corrections`, {
    method: "POST",
    body: { fact_key: factKey, value, ...reason },
    schema: correctionResultSchema,
  });
}

/** Revert one live correction to the worker's previous value. A 409 means there is none. */
export async function revertCandidateCorrection(
  workerId: string,
  factKey: string,
  reason: CorrectionRequestReason,
): Promise<CorrectionResult> {
  if (!uuidSchema.safeParse(workerId).success) throw new Error("That worker id is not valid.");
  return adminFetch(
    `/admin/candidates/${encodeURIComponent(workerId)}/corrections/${encodeURIComponent(factKey)}/revert`,
    { method: "POST", body: reason, schema: correctionResultSchema },
  );
}

/** The reason history. Reason TEXT exists only on this `edit_candidates` route. */
export async function readCorrectionHistory(workerId: string): Promise<CorrectionHistory> {
  if (!uuidSchema.safeParse(workerId).success) throw new Error("That worker id is not valid.");
  return adminFetch(`/admin/candidates/${encodeURIComponent(workerId)}/corrections`, {
    schema: historySchema,
  });
}
