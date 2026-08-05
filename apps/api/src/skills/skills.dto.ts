import { z } from "zod";

/**
 * DTOs for the INTERNAL skill-canonicalization routes (ADR-0030 / FORK-B-1 seam A).
 * Callers: the ai-service `HttpSkillStore` only (InternalServiceGuard). Nothing here
 * carries worker identity; the phrase arrives ALREADY pseudonymized (SG-1) and is
 * defensively re-checked for residual numeric PII at this boundary too (fail closed).
 */

/** Matches the pseudonymizer's residual-digit fail-closed rule (7+ digit run).
 * Includes Devanagari digits: JS \d is ASCII-only, but the Python pseudonymizer's \d is
 * Unicode-aware — this boundary must not be looser than the upstream gate. */
const RESIDUAL_DIGITS = /[\d०-९]{7,}/;

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

/**
 * Nearest-JOB-DOMAIN search — the retrieval half of the generalized profiling RAG pass.
 *
 * Same seam, same guard, same shape as the alias lookup above, and deliberately so: the
 * ai-service has no database driver, `job_domain_alias` is RLS-locked, and the only way
 * it reaches this data is by asking the api to run the query. One more route on an
 * existing scoped credential beats a second seam.
 *
 * NO `domain_id` FILTER, and that is the difference that matters. The alias lookup is
 * domain-SCOPED because a skill phrase is only meaningful inside its trade. This search
 * is what DECIDES the trade, so scoping it would presuppose the answer — the whole point
 * is that a cook, a tailor and a machinist all query the same catalog.
 */
export const NearestDomainsDtoSchema = z.object({
  /** The query embedding — MUST be exactly the house dimension (vector(768)). */
  vector: z.array(z.number().finite()).length(768),
  k: z.number().int().min(1).max(50).default(10),
});
export type NearestDomainsDto = z.infer<typeof NearestDomainsDtoSchema>;

/**
 * One retrieved domain: the CLOSED-set id, its label, and the cosine similarity.
 *
 * The LABEL rides along because the model has to choose between these, and it cannot
 * choose between opaque ids. Sending labels rather than making the ai-service resolve
 * them keeps the shortlist self-contained: whatever comes back must be one of the ids
 * in it, which is the hallucination guard.
 */
export interface DomainCandidate {
  job_domain_id: string;
  label: string;
  score: number;
}
