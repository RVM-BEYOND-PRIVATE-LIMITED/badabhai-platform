import { z } from "zod";

/**
 * Payer-SELF resume-disclosure request body (ADR-0013 Decision C / ADR-0019 XB-A).
 *
 * Deliberately carries NO `payer_id`: the payer identity is the verified SESSION payer
 * (`req.payer.id`), never a body value (XB-A horizontal authz). This is the only
 * difference from the ops {@link RequestDisclosureSchema} — the worker + posting refs
 * are identical opaque uuids.
 */
export const PayerRequestDisclosureSchema = z.object({
  worker_id: z.string().uuid(),
  job_posting_id: z.string().uuid().nullable().default(null),
});
export type PayerRequestDisclosureDto = z.infer<typeof PayerRequestDisclosureSchema>;
