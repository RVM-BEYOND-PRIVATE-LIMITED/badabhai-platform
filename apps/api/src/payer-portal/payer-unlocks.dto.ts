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

/**
 * POST /payer/credits body — buy a credit pack. Same XB-A discipline as above: the
 * payer is the AUTHENTICATED session payer (`req.payer.id`), so this body carries NO
 * `payer_id`. Only the opaque pack CODE is supplied; the pack (price + credits) is
 * resolved from config by the service — amounts are never client-supplied.
 */
export const PayerBuyPackSchema = z.object({
  pack_code: z.string().min(1).max(64),
});
export type PayerBuyPackDto = z.infer<typeof PayerBuyPackSchema>;

/**
 * GET /payer/credits/ledger query — bounded page size for the (session) payer's own ledger.
 * Mirrors the feed pagination convention (1..50, default 20). No `payer_id` here or anywhere —
 * the payer is the AUTHENTICATED session payer (XB-A), never a query/body value.
 */
export const PayerLedgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PayerLedgerQueryDto = z.infer<typeof PayerLedgerQuerySchema>;
