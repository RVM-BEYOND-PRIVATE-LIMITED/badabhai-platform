/**
 * Wire contracts for the internal occupation routes.
 *
 * THE UTTERANCE ARRIVES ALREADY PSEUDONYMIZED and the bound below assumes it. 4,000
 * characters mirrors the ai-service's per-message pseudonymizer limit rather than its
 * 20,000-character whole-transcript limit — the defect that made `/profile/extract` fail
 * closed on any verbose interview was exactly a bound set against the wrong unit.
 */
import { z } from "zod";

export const ResolveOccupationDtoSchema = z.object({
  text: z.string().min(1).max(4000),
  lang: z.string().min(2).max(8).optional(),
  /**
   * A query embedding the caller already holds. This service never mints one — see
   * `occupation.service.ts`. 768 dims to match the seeded corpus; a wrong width is a
   * caller bug and is rejected rather than silently scoring as noise.
   */
  vector: z.array(z.number()).length(768).optional(),
  allow_vector: z.boolean().optional(),
});
export type ResolveOccupationDto = z.infer<typeof ResolveOccupationDtoSchema>;

/**
 * Which pack a family or an occupation gets.
 *
 * EXACTLY ONE SELECTOR, enforced here rather than left to the handler. Two selectors would
 * make the answer depend on an undocumented precedence, and a caller debugging "why did this
 * worker get that pack" would have to read the controller to find out which one won.
 *
 * `pack_id` + `pack_version` together are the PINNED lookup: the exact version a
 * conversation was pinned to, which must never be re-resolved to whatever is active now.
 * Answering question 7 of a pack whose questions 1-6 were never asked is worse than failing.
 */
export const ResolveQuestionPackDtoSchema = z
  .object({
    family_id: z.string().min(1).optional(),
    job_domain_id: z.string().min(1).optional(),
    pack_id: z.string().min(1).optional(),
    pack_version: z.number().int().positive().optional(),
  })
  .refine(
    (v) =>
      [v.family_id !== undefined, v.job_domain_id !== undefined, v.pack_id !== undefined].filter(
        Boolean,
      ).length === 1,
    { message: "exactly one of family_id, job_domain_id or pack_id is required" },
  )
  .refine((v) => (v.pack_id === undefined) === (v.pack_version === undefined), {
    message: "pack_id and pack_version must be given together",
  });
export type ResolveQuestionPackDto = z.infer<typeof ResolveQuestionPackDtoSchema>;

/**
 * The pseudonymizer's residual-digit fail-closed rule (7+ digit run), re-checked here.
 *
 * Includes Devanagari digits because JS `\d` is ASCII-only while the Python pseudonymizer's
 * is Unicode-aware — a boundary looser than the upstream gate is not a boundary. Copied
 * from `skills.dto.ts` rather than shared: this is defence in depth, and two independent
 * checks that happen to agree are worth more here than one check imported twice.
 */
const RESIDUAL_DIGITS = /[\d०-९]{7,}/;

/**
 * One below-floor occupation phrase for the growth queue.
 *
 * THE PHRASE ARRIVES ALREADY PSEUDONYMIZED (SG-1). This service cannot do it — the
 * pseudonymizer lives in the ai-service — so the caller's guarantee is the contract, and the
 * digit check below is the defence against a caller that breaks it. A phrase that reaches
 * this table un-pseudonymized is worker PII at rest in an ops queue.
 */
export const RecordUnresolvedOccupationDtoSchema = z.object({
  phrase: z
    .string()
    .min(1)
    .max(500)
    .refine((v) => !RESIDUAL_DIGITS.test(v), {
      message: "phrase contains a residual numeric sequence (pseudonymize first)",
    }),
  lang: z.string().min(2).max(8).default("hi"),
});
export type RecordUnresolvedOccupationDto = z.infer<typeof RecordUnresolvedOccupationDtoSchema>;
