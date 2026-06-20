import { z } from "zod";

/**
 * Zod DTOs for the Contact Unlock + Reveal surface (ADR-0010, Stream A).
 *
 * PAYER-AUTH (R16 / LC-1, ADR-0019 Phase 1): every route is now behind
 * {@link import("../payers/payer-auth.guard").PayerAuthGuard}. The acting payer is the
 * AUTHENTICATED session payer (`req.payer.id`) — derived from the verified Bearer
 * session, NEVER from the request body/query. So NO DTO here carries `payer_id`: there
 * is nowhere for a caller to supply another payer's id (XB-A horizontal-authz). The one
 * place a payer id appears in a request is the `/payers/:payerId/credits` PATH param,
 * which the controller asserts equals the session payer (`assertPayerOwns`) before use.
 *
 * PRIVACY NOTE: no DTO here accepts or returns a phone / name / contact / proxy
 * number / routing token. Responses are PII-free (ids + enums + the opaque,
 * non-reversible relay handle only).
 */

/** POST /unlocks body — request a routed-contact unlock for a candidate profile. */
export const RequestUnlockSchema = z.object({
  worker_id: z.string().uuid(),
  // Optional job context (per-profile granularity, §Sign-off resolutions). Nullable.
  job_id: z.string().uuid().nullable().default(null),
  // Optional caller-supplied idempotency key for the debit (F-6). When absent the
  // service derives a stable key from (payer_id, worker_id) so a retry is still safe.
  idempotency_key: z.string().min(1).max(128).optional(),
});
export type RequestUnlockDto = z.infer<typeof RequestUnlockSchema>;

/**
 * POST /payers/:payerId/credits body — MOCK pack purchase (alpha). `pack_code` is
 * one of the config-driven credit packs (credit-packs.ts). NO real money: a real
 * Razorpay purchase is a later human-gated stream (§D5). No card/UPI/PII field
 * exists here. The `:payerId` path param must equal the session payer (XB-A) — it is
 * a payer SELF-purchase, never an ops grant against another id.
 */
export const PurchaseCreditsSchema = z.object({
  pack_code: z.string().min(1).max(64),
});
export type PurchaseCreditsDto = z.infer<typeof PurchaseCreditsSchema>;
