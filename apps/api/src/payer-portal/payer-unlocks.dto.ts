import { z } from "zod";

/**
 * POST /payer/unlocks body — request a routed-contact unlock for a candidate.
 *
 * XB-A (ADR-0019 external-disclosure addendum): the payer is the AUTHENTICATED session
 * payer (`req.payer.id`), so this body deliberately has NO `payer_id`. A payer can never
 * act under another payer's id because there is nowhere to supply one — the identity
 * comes only from the verified session, never the request body.
 */
export const PayerRequestUnlockSchema = z.object({
  worker_id: z.string().uuid(),
  // Optional per-profile job context (nullable), mirroring the ops unlock DTO.
  job_id: z.string().uuid().nullable().default(null),
});
export type PayerRequestUnlockDto = z.infer<typeof PayerRequestUnlockSchema>;
