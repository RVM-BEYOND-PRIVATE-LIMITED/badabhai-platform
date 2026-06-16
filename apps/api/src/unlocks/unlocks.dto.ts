import { z } from "zod";

/**
 * Zod DTOs for the Contact Unlock + Reveal surface (ADR-0010, Stream A). Every
 * boundary is validated here.
 *
 * PAYER-AUTH NOTE (F-7, launch gate): there is NO per-payer identity yet. In alpha
 * `payer_id` is supplied in the request body/param and trusted ONLY because the
 * caller is the InternalServiceGuard secret-holder (backend/ops). "Payer owns the
 * unlock" is UNENFORCEABLE under a shared secret — a real `PayerAuthGuard` is a hard
 * launch gate before any client-facing payer surface. Do NOT assume it is enforced.
 *
 * PRIVACY NOTE: no DTO here accepts or returns a phone / name / contact / proxy
 * number / routing token. Responses are PII-free (ids + enums + the opaque,
 * non-reversible relay handle only).
 */

/** POST /unlocks body — request a routed-contact unlock for a candidate profile. */
export const RequestUnlockSchema = z.object({
  payer_id: z.string().uuid(),
  worker_id: z.string().uuid(),
  // Optional job context (per-profile granularity, §Sign-off resolutions). Nullable.
  job_id: z.string().uuid().nullable().default(null),
  // Optional caller-supplied idempotency key for the debit (F-6). When absent the
  // service derives a stable key from (payer_id, worker_id) so a retry is still safe.
  idempotency_key: z.string().min(1).max(128).optional(),
});
export type RequestUnlockDto = z.infer<typeof RequestUnlockSchema>;

/** GET /unlocks?payer_id= query — ops read, scoped to one opaque payer. */
export const ListUnlocksQuerySchema = z.object({
  payer_id: z.string().uuid(),
});
export type ListUnlocksQueryDto = z.infer<typeof ListUnlocksQuerySchema>;

/**
 * POST /payers/:payerId/credits body — MOCK pack purchase (alpha). `pack_code` is
 * one of the config-driven credit packs (credit-packs.ts). NO real money: a real
 * Razorpay purchase is a later human-gated stream (§D5). No card/UPI/PII field
 * exists here.
 */
export const PurchaseCreditsSchema = z.object({
  pack_code: z.string().min(1).max(64),
});
export type PurchaseCreditsDto = z.infer<typeof PurchaseCreditsSchema>;
