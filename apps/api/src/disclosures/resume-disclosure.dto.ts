import { z } from "zod";

/**
 * POST /resume-disclosures body — a payer requests the EMPLOYER-facing (identity-
 * MASKED) resume of one worker, optionally scoped to a posting. FREE (no payment),
 * but a PII disclosure riding the ADR-0010 consent + shared-cap spine
 * (resume-disclosure-threat-model-addendum, build gates B-A…B-G).
 *
 * `payer_id` is trusted from the body under the interim `InternalServiceGuard` ONLY
 * (there is no per-payer identity yet — F-7 / TD33 launch gate). ONE worker per
 * request — there is intentionally NO bulk/list shape (B-F anti-harvest).
 */
export const RequestDisclosureSchema = z.object({
  payer_id: z.string().uuid(),
  worker_id: z.string().uuid(),
  job_posting_id: z.string().uuid().nullable().default(null),
});
export type RequestDisclosureDto = z.infer<typeof RequestDisclosureSchema>;

/** GET /resume-disclosures?payer_id=... — ops list (PII-free projection). */
export const ListDisclosuresQuerySchema = z.object({
  payer_id: z.string().uuid(),
});
export type ListDisclosuresQueryDto = z.infer<typeof ListDisclosuresQuerySchema>;
