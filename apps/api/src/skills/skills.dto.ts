import { z } from "zod";

/**
 * DTOs for the INTERNAL skill-canonicalization routes (ADR-0030 / FORK-B-1 seam A).
 * Callers: the ai-service `HttpSkillStore` only (InternalServiceGuard). Nothing here
 * carries worker identity; the phrase arrives ALREADY pseudonymized (SG-1) and is
 * defensively re-checked for residual numeric PII at this boundary too (fail closed).
 */

/** Matches the pseudonymizer's residual-digit fail-closed rule (7+ digit run). */
const RESIDUAL_DIGITS = /\d{7,}/;

export const NearestAliasesDtoSchema = z.object({
  domain_id: z.string().min(1).max(64),
  /** The query embedding — MUST be exactly the house dimension (vector(768)). */
  vector: z.array(z.number().finite()).length(768),
  k: z.number().int().min(1).max(20).default(5),
});
export type NearestAliasesDto = z.infer<typeof NearestAliasesDtoSchema>;

export const RecordUnresolvedDtoSchema = z.object({
  /**
   * The below-floor phrase, ALREADY pseudonymized by the ai-service (SG-1). Defense in
   * depth: a residual 7+ digit run (the pseudonymizer's own fail-closed signal) is
   * rejected here as well — a mis-behaving caller cannot land numeric PII in the queue.
   */
  phrase: z
    .string()
    .min(1)
    .max(500)
    .refine((v) => !RESIDUAL_DIGITS.test(v), {
      message: "phrase contains a residual numeric sequence (pseudonymize first)",
    }),
  domain_id: z.string().min(1).max(64),
  lang: z.string().min(2).max(8).default("en"),
});
export type RecordUnresolvedDto = z.infer<typeof RecordUnresolvedDtoSchema>;

/** One nearest-alias candidate: the CLOSED-set skill id + cosine similarity score. */
export interface AliasCandidate {
  skill_id: string;
  score: number;
}
