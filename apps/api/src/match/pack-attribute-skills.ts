/**
 * B0b — the role pack's closed-set answers → the taxonomy ids they imply.
 *
 * THE TABLE MOVED TO `@badabhai/taxonomy` (`pack-answer-skills.ts`). It used to live here and
 * cover `qp_cnc_turning` alone, so a welder, fitter, grinder or QC inspector onboarded through
 * their trade form derived ZERO match skills and saw an empty V1 feed. Moving it was not
 * tidiness: `db:backfill:worker-skills` (in `@badabhai/db`, which cannot import `apps/api`) has
 * to derive exactly what the live rebuild derives, or the nightly repair prunes the rows the live
 * path wrote. One table, read by both.
 *
 * This module keeps the names the API already imports, so callers and the B0b/R12 guards did not
 * have to move with it. Read the taxonomy file before extending the table — its rules (literal
 * claims only, no nearest-skill proxy, pack-scoped) are the part that matters.
 */
import {
  PACK_ANSWER_SKILLS,
  packAnswerEvidence,
  packAnswerIdsEmitted,
  type PackAnswer,
  type PackAnswerEvidence,
} from "@badabhai/taxonomy";

export { PACK_ANSWER_SKILLS as PACK_ATTRIBUTE_SKILLS, packAnswerEvidence };
export type { PackAnswer, PackAnswerEvidence };

/** Every corpus (`skill_*`) id the table can emit — what `ATTRIBUTE_TO_MATCH_SKILLS` must cover. */
export function corpusSkillsEmitted(): string[] {
  return packAnswerIdsEmitted().filter((id) => id.startsWith("skill_"));
}

/**
 * The corpus attribute ids implied by one worker's pack answers — the `skill_*` half of
 * {@link packAnswerEvidence}. The `role_*` half rides the role bridge and is read from
 * `packAnswerEvidence` directly by the rebuild.
 */
export function corpusSkillsForPackAttributes(answers: readonly PackAnswer[]): string[] {
  return packAnswerEvidence(answers).corpusSkillIds;
}
