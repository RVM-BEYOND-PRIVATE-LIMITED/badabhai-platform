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
  isMatchSkillId,
  matchSkillForRole,
  matchSkillIndustry,
  matchSkillsForAttribute,
  packAnswerEvidence,
  type MatchSkillId,
  type PackAnswer,
} from "@badabhai/taxonomy";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "./config";
import { bucketMonths } from "./months";
import type { WorkerSkillRow } from "./types";

/** What the API has about a worker at derivation time. No PII — ids and a number. */
export interface DeriveWorkerSkillsInput {
  /** The canonical `role_*` id from the worker profile, if one was resolved. */
  canonicalRoleId?: string | null;
  /**
   * Layer A (f) — the worker's DECLARED SECONDARY `role_*` ids (migration 0114), in the worker's
   * own order. Each rides the SAME `ROLE_TO_MATCH_SKILL` bridge as the primary role; an id the
   * bridge does not cover contributes nothing and stays display-only. This adds no vocabulary and
   * no rank key — it is one more declared id through an existing bridge.
   */
  additionalRoleIds?: readonly string[];
  /** Canonical corpus (`skill_*`) attribute ids on the worker profile. */
  profileSkills?: readonly string[];
  /**
   * PACK-ONLY match skills his own pack answers name directly (#2022) — the trades with no role and
   * no corpus id to bridge through. Closed-set: anything that is not a `MatchSkillId` is dropped.
   */
  matchSkillIds?: readonly string[];
  /** The worker's estimated TOTAL experience, in years. `null` when unknown. */
  totalYears?: number | null;
}

/**
 * Derive the worker's V1 skill rows.
 *
 * SET   = `ROLE_TO_MATCH_SKILL[canonicalRoleId]` (if any)
 *       ∪ `ROLE_TO_MATCH_SKILL[r]` for every declared secondary role id `r` (Layer A (f))
 *       ∪ `ATTRIBUTE_TO_MATCH_SKILLS[s]` for every corpus attribute `s`
 *       ∪ every pack-only `mskill_*` his pack answers name (#2022), closed-set checked
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

  const roleIds = [input.canonicalRoleId, ...(input.additionalRoleIds ?? [])];
  for (const roleId of roleIds) {
    if (typeof roleId !== "string") continue;
    const fromRole = matchSkillForRole(roleId);
    if (fromRole !== undefined) skillIds.add(fromRole);
  }

  for (const attribute of input.profileSkills ?? []) {
    if (typeof attribute !== "string") continue;
    for (const derived of matchSkillsForAttribute(attribute)) skillIds.add(derived);
  }

  for (const direct of input.matchSkillIds ?? []) {
    if (isMatchSkillId(direct)) skillIds.add(direct);
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

/** The evidence one worker's rebuild reads, exactly as the two writers load it. */
export interface WorkerSkillEvidence {
  /** The CURRENT `worker_profiles` row's signals, or `null` when he has none (every form worker). */
  profile: {
    canonicalRoleId: string | null;
    profileSkills: readonly string[];
    totalYears: number | null;
  } | null;
  /** Declared secondary `role_*` ids (migration 0114), in the worker's own order. */
  secondaryRoleIds: readonly string[];
  /** His stored pack answers (`worker_attributes`), each carrying its own row's `pack_id`. */
  packAnswers: readonly PackAnswer[];
}

/**
 * ONE ASSEMBLY OF THE DERIVATION INPUT, for BOTH writers of `worker_skill`.
 *
 * The live rebuild (`WorkerSkillsService.rebuildForWorker`) and the batch repair
 * (`db:backfill:worker-skills`) each load the same three sources and must derive the same set.
 * They used to assemble the input separately, and they disagreed: the batch skipped every worker
 * with no profile row and never read pack answers, so for a form-onboarded worker the nightly
 * repair either did nothing or PRUNED the rows the live path wrote. Assembling it here makes
 * parity a property of construction.
 *
 * `null` means "nothing to derive from" — no profile, no pack evidence, no declared occupation.
 * Both callers then leave the worker's rows untouched: the rebuild is delete-then-insert, and
 * running it on no evidence would DELETE rows a worker mid-extraction already has.
 *
 * Pure: the pack bridge is a closed-set table lookup (`@badabhai/taxonomy`), no inference.
 */
export function workerSkillDeriveInput(
  evidence: WorkerSkillEvidence,
): DeriveWorkerSkillsInput | null {
  const pack = packAnswerEvidence(evidence.packAnswers);
  if (
    evidence.profile === null &&
    pack.corpusSkillIds.length === 0 &&
    pack.roleIds.length === 0 &&
    pack.matchSkillIds.length === 0 &&
    evidence.secondaryRoleIds.length === 0
  ) {
    return null;
  }
  return {
    canonicalRoleId: evidence.profile?.canonicalRoleId ?? null,
    // Declared occupations first, in the worker's order; pack-implied roles after. Order does not
    // change the derived SET (the output is sorted) — it only keeps a debug dump readable.
    additionalRoleIds: [...new Set([...evidence.secondaryRoleIds, ...pack.roleIds])],
    // UNION, never replace: a worker can have both an extracted profile and a completed pack,
    // and whichever arrived second must not silently delete the other's evidence.
    profileSkills: [
      ...new Set([...(evidence.profile?.profileSkills ?? []), ...pack.corpusSkillIds]),
    ].sort(),
    // Pack-only skills (#2022) have no other source, so there is nothing to union with.
    matchSkillIds: pack.matchSkillIds,
    totalYears: evidence.profile?.totalYears ?? null,
  };
}
