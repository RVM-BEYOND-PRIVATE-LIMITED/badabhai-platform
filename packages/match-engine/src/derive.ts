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
  genericPackChatMatchSkills,
  isMatchSkillId,
  matchSkillForRole,
  matchSkillIndustry,
  matchSkillsForAttribute,
  matchSkillsForPackAnswerId,
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
   * no corpus id to bridge through — and those his worker-only generic-pack chat claims (#2075).
   * Closed-set: anything that is not a `MatchSkillId` is dropped.
   */
  matchSkillIds?: readonly string[];
  /** The worker's estimated TOTAL experience, in years. `null` when unknown. */
  totalYears?: number | null;
  /**
   * #2753 item 2 (`FORM_TENURE_MONTHS_ENABLED`) — YEARS per match skill, stated by the experience
   * band of the trade form whose answers derived that skill. Built by `workerSkillDeriveInput` from
   * {@link WorkerSkillEvidence.formTenure}; see {@link deriveWorkerSkills} for the fill rule.
   *
   * ABSENT IS TODAY. The key is only ever present while the switch is on, so an off derivation is
   * byte-identical — same rows, same months, same input object.
   */
  formTenureYears?: Readonly<Record<string, number>>;
}

/**
 * The years ONE trade form's tenure answer states, keyed by the pack the form was answered under.
 *
 * RESOLVED BY THE CALLER, never here: this package reads no answer. `@badabhai/db`
 * (`loadFormTenureFills`) turns a stored band into its `value_number`, and a typed answer into
 * `typedTenureYears`, for both writers of `worker_skill`.
 */
export interface FormTenureFill {
  readonly packId: string;
  readonly years: number;
}

/**
 * Derive the worker's V1 skill rows.
 *
 * SET   = `ROLE_TO_MATCH_SKILL[canonicalRoleId]` (if any)
 *       ∪ `ROLE_TO_MATCH_SKILL[r]` for every declared secondary role id `r` (Layer A (f))
 *       ∪ `ATTRIBUTE_TO_MATCH_SKILLS[s]` for every corpus attribute `s`
 *       ∪ every pack-only `mskill_*` his pack answers name (#2022) or his worker-only
 *         generic-pack chat claims (#2075), closed-set checked
 * MONTHS= `bucketMonths(totalYears)` — identically on every row (the coarse rule)
 *         …and, ONLY where that is 0, `bucketMonths(formTenureYears[skill])` (#2753 item 2)
 * WANTS = `true` — the launch default; a worker who says otherwise flips the row
 * DATES = `null` — we do not know the stints yet, so we do not claim them
 *
 * THE FORM-TENURE FILL (#2753 item 2, `FORM_TENURE_MONTHS_ENABLED`). A form worker has no profile,
 * so `totalYears` is null and every row reads 0 months — "not recorded" to search — although the
 * form asked him an experience band. With the switch on, a skill his form derived takes that
 * form's years through the SAME `bucketMonths`, so a 3–5 years band (4) reads 48 months and a
 * 1–3 years band (2) reads 24. FILL, NEVER OVERRIDE: a row whose `totalYears` already buckets above
 * 0 keeps exactly today's months, and a fresher or under-one-year band (0) stays 0, "not recorded"
 * as today. A skill no form derived is never filled.
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
  const formTenure = input.formTenureYears;

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
        // The fill only ever replaces a 0, and an absent entry buckets to 0 again: no guess.
        monthsBucketed:
          monthsBucketed > 0 || formTenure === undefined
            ? monthsBucketed
            : bucketMonths(formTenure[skillId], cfg.monthBucket),
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
    /**
     * #2075 — the persisted `conversation_state` (its `pack_id` / `answer_map` / `llm_led_turns` /
     * `llm_draft_settled` subset) of the chat session that PRODUCED this profile row, read through
     * `worker_profiles.ai_job_id` → `ai_jobs.input_ref.session_id` → `chat_sessions`
     * (`PROFILE_SOURCE_SESSION_ANSWERS`, @badabhai/db). `null` when the profile has no such
     * session (a résumé or legacy profile). Untrusted JSON: `genericPackChatMatchSkills` narrows
     * it and applies the worker-only gate. REQUIRED so neither writer can forget to load it.
     */
    sourceSession: unknown;
  } | null;
  /** Declared secondary `role_*` ids (migration 0114), in the worker's own order. */
  secondaryRoleIds: readonly string[];
  /** His stored pack answers (`worker_attributes`), each carrying its own row's `pack_id`. */
  packAnswers: readonly PackAnswer[];
  /**
   * #2753 item 2 — the years each trade form's experience band states, by pack. OPTIONAL, and
   * absent or empty is today: both writers pass it only while `FORM_TENURE_MONTHS_ENABLED` is on.
   * Not evidence on its own — it fills months for skills the pack answers derive, never adds one.
   */
  formTenure?: readonly FormTenureFill[];
}

/**
 * ONE ASSEMBLY OF THE DERIVATION INPUT, for BOTH writers of `worker_skill`.
 *
 * The live rebuild (`WorkerSkillsService.rebuildForWorker`) and the batch repair
 * (`db:backfill:worker-skills`) each load the same sources and must derive the same set.
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
  // #2075 — the profile's own source session. It hangs off the profile row, so a worker with no
  // profile has none and the guard below is unchanged.
  const genericChat =
    evidence.profile === null ? [] : genericPackChatMatchSkills(evidence.profile.sourceSession);
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
    // Pack-only skills: named by a role pack's stored answers (#2022) or claimed by a worker-only
    // generic-pack chat (#2075). Neither has a bridge, so these are their only sources. UNION.
    matchSkillIds: [...new Set([...pack.matchSkillIds, ...genericChat])].sort(),
    totalYears: evidence.profile?.totalYears ?? null,
    // Only present when a form stated years for a skill it derives — so off, the input is today's.
    ...formTenureInput(evidence.packAnswers, evidence.formTenure ?? []),
  };
}

/**
 * #2753 item 2 — which skills each trade form's band speaks for, and for how many years.
 *
 * PER FORM, NOT PER WORKER. A form's band is his tenure in THAT trade, so it is given only to the
 * skills that form's own answers derive: the pack answers carrying the band's `pack_id`, routed
 * through the same three bridges `deriveWorkerSkills` uses (`matchSkillsForPackAnswerId`). A welder
 * who also filled the turning form gets the welding band on his welding skills and the turning band
 * on his turning skill — two skills, two bands, never one figure smeared across both.
 *
 * TWO FORMS NAMING ONE SKILL keep the LONGER band: each is a figure he stated for work that implies
 * the skill, so the longer one is still his own claim, and taking the shorter would discard it.
 *
 * Returns `{}` (no key at all) when nothing is filled, so an off or empty input changes nothing.
 * Deterministic: the record is built in sorted skill order whatever order the fills arrive in.
 */
function formTenureInput(
  packAnswers: readonly PackAnswer[],
  fills: readonly FormTenureFill[],
): Pick<DeriveWorkerSkillsInput, "formTenureYears"> {
  const bySkill = new Map<MatchSkillId, number>();
  for (const { packId, years } of fills) {
    if (typeof years !== "number" || !Number.isFinite(years) || years < 0) continue;
    const own = packAnswerEvidence(packAnswers.filter((answer) => answer.packId === packId));
    for (const id of [...own.corpusSkillIds, ...own.roleIds, ...own.matchSkillIds]) {
      for (const skillId of matchSkillsForPackAnswerId(id)) {
        const held = bySkill.get(skillId);
        if (held === undefined || years > held) bySkill.set(skillId, years);
      }
    }
  }
  if (bySkill.size === 0) return {};
  const formTenureYears: Record<string, number> = {};
  const sorted = [...bySkill.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [skillId, years] of sorted) formTenureYears[skillId] = years;
  return { formTenureYears };
}
