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

/**
 * The two ways to scope an alias search, and they are mutually exclusive.
 *
 * `legacy` reads `skill_alias.domain_id` — the shipped pre-filter, unchanged.
 * `canonical` reads `job_domain_skill`, which is the authoritative domain <-> skill
 * relationship as of migration 0076 and the ONLY way to reach a skill whose legacy
 * `domain_id` is NULL.
 *
 * A DISCRIMINATED UNION rather than two nullable strings, deliberately: it makes
 * "neither scope" unrepresentable in the repository signature, so the rule that a
 * missing domain must never fall through to an unscoped search over the whole
 * vocabulary is enforced by the type system rather than by remembering to check.
 */
export type AliasSearchScope =
  | { kind: "legacy"; domainId: string }
  | { kind: "canonical"; jobDomainId: string };

export const NearestAliasesDtoSchema = z
  .object({
    /**
     * LEGACY 11-slug skill domain ("cnc-machining"). Optional as of the Phase 1.5
     * cutover — every existing caller that sends only this keeps identical behaviour.
     */
    domain_id: z.string().min(1).max(64).optional(),
    /**
     * CANONICAL `jd_*` job domain. Candidates are resolved through `job_domain_skill`,
     * so a skill with a NULL legacy `skill_alias.domain_id` is reachable.
     */
    job_domain_id: z.string().min(1).max(64).optional(),
    /** The query embedding — MUST be exactly the house dimension (vector(768)). */
    vector: z.array(z.number().finite()).length(768),
    k: z.number().int().min(1).max(20).default(5),
  })
  /**
   * EXACTLY ONE. Neither => 400, both => 400.
   *
   * The "neither" arm is the security-relevant one: an unscoped ANN over `skill_alias`
   * would return the nearest alias in ANY trade, which is precisely the answer the
   * domain scope exists to prevent. Failing the request is the only safe degradation
   * (fail closed) — there is no sensible default domain to fall back to.
   *
   * The "both" arm is a correctness guard: the two id spaces are disjoint and would
   * select different candidate sets, so silently preferring one would make the caller's
   * intent unknowable from the wire.
   */
  .refine((v) => (v.domain_id === undefined) !== (v.job_domain_id === undefined), {
    message:
      "exactly one of domain_id (legacy skill-domain slug) or job_domain_id (canonical jd_*) is required",
  });
export type NearestAliasesDto = z.infer<typeof NearestAliasesDtoSchema>;

/**
 * Narrow a validated DTO to the repository's scope union.
 *
 * Returns `null` for the impossible "neither" case instead of inventing a scope: the
 * schema's refine has already rejected it at the boundary, and the caller turns a null
 * into a 400 rather than a silent unscoped search. Never throws, never guesses.
 */
export function toAliasSearchScope(dto: NearestAliasesDto): AliasSearchScope | null {
  if (dto.job_domain_id !== undefined) {
    return { kind: "canonical", jobDomainId: dto.job_domain_id };
  }
  if (dto.domain_id !== undefined) return { kind: "legacy", domainId: dto.domain_id };
  return null;
}

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
  /**
   * LEGACY skill-domain slug (Path B). OPTIONAL as of S3-C — supply this or
   * `job_domain_id`, never both, never neither (the refine below).
   *
   * HISTORY, because the constraint that used to live here was an EVENT constraint and
   * not a table one, and the distinction is what took a migration to resolve. The column
   * has always been nullable (the occupation scope has written null since 0070). What
   * forced this field to stay non-null was `SkillsService.recordUnresolved` emitting
   * `skill.phrase_unresolved`, whose v1 payload declares `domain_id: z.string().min(1)`:
   * accepting null would have written the row and THEN failed validation, leaving a queued
   * phrase with no event — an Event-First violation strictly worse than refusing the write.
   *
   * Migration 0078 + `skill.phrase_unresolved_v2` close that gap without touching v1: the
   * table now models `job_domain_id`, the unique index includes it, and the service picks
   * the payload GENERATION by scope. See the v2 payload for why relaxing v1 in place was
   * not an option.
   */
  domain_id: z.string().min(1).max(64).optional(),
  /**
   * CANONICAL domain (Path A), the `jd_*` id. The counterpart this DTO existed without.
   *
   * A canonical-scoped canonicalization that MISSES now has somewhere to record WHICH
   * domain it missed in. Until 0078 that path was closed by construction, which would have
   * made Path A's failures invisible in `unresolved_phrase` — the one table built to catch
   * failures — the moment the read switch flipped. This field is the S3-C prerequisite
   * `phase-9-s3-deployment-plan.md` names.
   */
  job_domain_id: z.string().min(1).max(64).optional(),
  lang: z.string().min(2).max(8).default("en"),
})
  // Mirrors `NearestAliasesDtoSchema`'s refine above and the DB's
  // `unresolved_phrase_one_domain_chk`. Same rule stated at all three layers on purpose:
  // the boundary gives a 400 with a readable message, the database makes the illegal row
  // unrepresentable for every future writer that never reads this file.
  .refine((v) => (v.domain_id === undefined) !== (v.job_domain_id === undefined), {
    message:
      "exactly one of domain_id (legacy skill-domain slug) or job_domain_id (canonical jd_*) is required",
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
