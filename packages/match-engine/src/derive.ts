/**
 * Matching V1 — deriving a worker's match-skill rows from what we already store.
 *
 * THE LAUNCH RULE IS COARSE, ON PURPOSE. Today a worker profile carries one canonical
 * role, a set of corpus ATTRIBUTES, and one estimated total experience. It does NOT
 * carry per-skill or per-employer durations. So V1 derives the match-skill SET
 * honestly and applies the SAME bucketed total to every derived row.
 *
 * That is a real limitation and it is stated rather than hidden: a man with eight
 * years, six on a lathe and two on a VMC, reads as eight on both. The alternative —
 * splitting the total across skills by some rule nobody told the worker about — would
 * invent history. When per-job history lands, only the input to this function
 * changes; `tenure.ts` already merges intervals correctly.
 *
 * EMPTY IS A LEGITIMATE ANSWER. A worker whose role and attributes imply no posting-
 * level skill gets `[]` — no reach. We never fabricate a skill to give a man a feed.
 */
import {
  matchSkillForRole,
  matchSkillIndustry,
  matchSkillsForAttribute,
  type MatchSkillId,
} from "@badabhai/taxonomy";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "./config";
import { bucketMonths } from "./months";
import type { WorkerSkillRow } from "./types";

/** What the API has about a worker at derivation time. No PII — ids and a number. */
export interface DeriveWorkerSkillsInput {
  /** The canonical `role_*` id from the worker profile, if one was resolved. */
  canonicalRoleId?: string | null;
  /** Canonical corpus (`skill_*`) attribute ids on the worker profile. */
  profileSkills?: readonly string[];
  /** The worker's estimated TOTAL experience, in years. `null` when unknown. */
  totalYears?: number | null;
}

/**
 * Derive the worker's V1 skill rows.
 *
 * SET   = `ROLE_TO_MATCH_SKILL[canonicalRoleId]` (if any)
 *       ∪ `ATTRIBUTE_TO_MATCH_SKILLS[s]` for every corpus attribute `s`
 * MONTHS= `bucketMonths(totalYears)` — identically on every row (the coarse rule)
 * WANTS = `true` — the launch default; a worker who says otherwise flips the row
 * DATES = `null` — we do not know the stints yet, so we do not claim them
 *
 * Deterministic: output is sorted by `skillId`, so the same input always produces the
 * same array, byte for byte.
 */
export function deriveWorkerSkills(
  input: DeriveWorkerSkillsInput,
  cfg: MatchConfig = DEFAULT_MATCH_CONFIG,
): WorkerSkillRow[] {
  const skillIds = new Set<MatchSkillId>();

  const fromRole =
    typeof input.canonicalRoleId === "string"
      ? matchSkillForRole(input.canonicalRoleId)
      : undefined;
  if (fromRole !== undefined) skillIds.add(fromRole);

  for (const attribute of input.profileSkills ?? []) {
    if (typeof attribute !== "string") continue;
    for (const derived of matchSkillsForAttribute(attribute)) skillIds.add(derived);
  }

  if (skillIds.size === 0) return [];

  const monthsBucketed = bucketMonths(input.totalYears, cfg.monthBucket);

  return [...skillIds]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((skillId): WorkerSkillRow | undefined => {
      const industryId = matchSkillIndustry(skillId);
      // Unreachable for a closed-set id: every MATCH_SKILLS entry carries an industry.
      // Guarded anyway so a future vocabulary edit cannot produce an undefined row.
      if (industryId === undefined) return undefined;
      return {
        skillId,
        industryId,
        monthsBucketed,
        wants: true,
        startedAt: null,
        endedAt: null,
      };
    })
    .filter((row): row is WorkerSkillRow => row !== undefined);
}
