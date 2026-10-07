/**
 * GENERIC FAMILY PACK ANSWERS → the PACK-ONLY `mskill_*` ids they literally claim (#2075).
 *
 * THE GAP THIS CLOSES. The owner ruled (2026-10-07) that a generic `qp_electrical` chat answer of
 * `industrial` ("Factory ka kaam") or `panel` ("Panel aur board") claims the industrial
 * electrician's chair, `mskill_industrial_electrician` (#2022). That skill is PACK-ONLY: no role
 * and no corpus `skill_*` id bridges to it, so `GENERIC_PACK_SKILLS` (#2021), which emits corpus
 * ids into `worker_profiles.skills`, cannot reach it.
 *
 * WHY A SEPARATE TABLE AND A SEPARATE SOURCE (owner's option (c), #2075). The two rejected
 * alternatives both change something else:
 *   (a) writing the `mskill_*` id into `worker_profiles.skills` changes what that column holds. It
 *       is the display source of record and the attribute-bridge input, and every reader assumes
 *       corpus ids.
 *   (b) bridging the corpus ids `skill_control_panel_wiring` / `skill_motor_connection_and_starter_
 *       wiring` to the skill widens reach for EVERY free-text chat worker, which is broader than
 *       the ruling.
 * So this table emits `mskill_*` ids ONLY, and they never touch `worker_profiles.skills`. They are
 * derived at REBUILD time, by both writers of `worker_skill` (`workerSkillDeriveInput`), from the
 * answer map already persisted in the `conversation_state` of the chat session that produced the
 * worker's current profile. No new storage, no migration.
 *
 * A LOOKUP, NOT A MODEL. Every key is an option VALUE from a checked-in pack JSON (a test in
 * `apps/api` pins each against the pack). No LLM, embedding or confidence floor decides anything.
 *
 * WORKER-ONLY, THE SAME GATE AS #2021. {@link genericPackChatMatchSkills} derives nothing unless
 * the persisted session carries the provenance stamps `llm_led_turns === 0` and
 * `llm_draft_settled === false` ({@link isWorkerOnlyAnswerMap}). A session the model led or
 * settled, a legacy session without the stamps, or no session at all derives nothing.
 *
 * THE RULES ARE `PACK_ANSWER_SKILLS`' RULES. Map only what a chip literally claims; no nearest-skill
 * proxy; routing to a pack is not a claim; pack-scoped, never global. And an entry may name only a
 * PACK-ONLY skill: the moment a role or corpus id bridges to it, that bridge must carry the claim
 * instead, so chat and form workers keep deriving the same set. A test enforces it.
 */

import { isMatchSkillId, type MatchSkillId } from "./match-skills";
import type { GenericPackAnswer } from "./generic-pack-skills";

type MatchValueMap = Readonly<Record<string, readonly MatchSkillId[]>>;

/** `pack_id` → `question_key` → stored option value → pack-only match skills. */
export const GENERIC_PACK_MATCH_SKILLS: Readonly<
  Record<string, Readonly<Record<string, MatchValueMap>>>
> = {
  // "Aap kis tarah ka bijli kaam karte hain?" Owner ruling 2026-10-07 (#2075): factory work and
  // panel/board work claim the plant electrician's chair, as `panel_wiring` does on the
  // industrial-electrician form. DELIBERATELY ABSENT:
  //   house_wiring  "Ghar ki wiring" is a building wireman, not plant work.
  //   motor         "Motor winding" is the rewinder's bench trade. The form maps `motor_drive`
  //                 (running motors and drives in a plant), which is a different claim.
  qp_electrical: {
    electrical_scope: {
      industrial: ["mskill_industrial_electrician"],
      panel: ["mskill_industrial_electrician"],
    },
  },
};

/**
 * The pack-only match skills a generic pack's answer values claim. Sorted, deduped, closed-set.
 *
 * Trusts its input to be worker-originated: callers gate with {@link isWorkerOnlyAnswerMap}
 * ({@link genericPackChatMatchSkills} does). Null, unknown packs, questions and values, inherited
 * `Object.prototype` keys and non-string values derive nothing.
 */
export function genericPackMatchSkills(
  packId: string | null,
  answers: readonly GenericPackAnswer[],
): MatchSkillId[] {
  if (packId === null) return [];
  const pack = ownEntry(GENERIC_PACK_MATCH_SKILLS, packId);
  if (!pack) return [];
  const ids = new Set<MatchSkillId>();
  for (const { questionKey, values } of answers) {
    const options = ownEntry(pack, questionKey);
    if (!options) continue;
    for (const value of values) {
      if (typeof value !== "string") continue;
      const emitted = ownEntry(options, value);
      if (!Array.isArray(emitted)) continue;
      for (const id of emitted) if (isMatchSkillId(id)) ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * #2021 — did the model write NOTHING into this session's answer map?
 *
 * TRUE ONLY when the persisted `conversation_state` carries BOTH provenance stamps, well-formed,
 * with `llm_led_turns === 0` and `llm_draft_settled === false`. Anything else (no state, a session
 * finalized before the stamps existed, a malformed value, a session the model led or settled) is
 * false. FAIL CLOSED (owner ruling 2026-10-07, "worker-only").
 *
 * THE ONE DEFINITION. The extraction processor (`readWorkerOnlyAnswerMap`, apps/api) and both
 * writers of `worker_skill` (through {@link genericPackChatMatchSkills}) read this function, so
 * the `skill_*` ids #2021 writes and the `mskill_*` ids #2075 derives cannot disagree about which
 * sessions count.
 */
export function isWorkerOnlyAnswerMap(conversationState: unknown): boolean {
  if (typeof conversationState !== "object" || conversationState === null) return false;
  const state = conversationState as Record<string, unknown>;
  return state.llm_led_turns === 0 && state.llm_draft_settled === false;
}

/**
 * The answer map's deterministic `target_field: skills` values, per question, as both generic-pack
 * tables read them. ANSWER MAP ONLY: never `skill_labels`, the parse overlay or Phase C. Only
 * `answered` records count, exactly as `projectProfile`'s `liveValues` reads them.
 *
 * Reads persisted JSON, so every record is untrusted: a record that is not an object, has no
 * string `question_key`, or a `target_field` that is neither a string nor null is skipped. The
 * extraction processor hands it records already narrowed by `AnswerRecordSchema`; the rebuild hands
 * it the raw `conversation_state.answer_map`. The per-session worker-only rule is NOT applied here.
 */
export function genericPackSkillAnswers(records: readonly unknown[]): GenericPackAnswer[] {
  const answers: GenericPackAnswer[] = [];
  for (const raw of records) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    if (record.status !== "answered") continue;
    const questionKey = record.question_key;
    if (typeof questionKey !== "string") continue;
    const targetField = record.target_field;
    if (targetField !== undefined && targetField !== null && typeof targetField !== "string") {
      continue;
    }
    if ((targetField ?? questionKey) !== "skills") continue;
    const value = record.value_normalized;
    const values = Array.isArray(value)
      ? (value as readonly unknown[])
      : value === null || value === undefined
        ? []
        : [value];
    answers.push({ questionKey, values });
  }
  return answers;
}

/**
 * #2075 — the pack-only match skills a worker's generic-pack chat claims, read from the persisted
 * `conversation_state` of the session that produced his CURRENT profile (or its
 * `pack_id` / `answer_map` / `llm_led_turns` / `llm_draft_settled` subset).
 *
 * WORKER-ONLY: nothing unless {@link isWorkerOnlyAnswerMap}. `null`, a non-object, a missing or
 * non-string `pack_id`, or a non-array `answer_map` derive nothing. Pure.
 */
export function genericPackChatMatchSkills(sourceSession: unknown): MatchSkillId[] {
  if (!isWorkerOnlyAnswerMap(sourceSession)) return [];
  const state = sourceSession as Record<string, unknown>;
  const packId = typeof state.pack_id === "string" ? state.pack_id : null;
  const answerMap = Array.isArray(state.answer_map) ? (state.answer_map as unknown[]) : [];
  return genericPackMatchSkills(packId, genericPackSkillAnswers(answerMap));
}

/** Every id the table can emit — the surface a taxonomy retag has to keep covering. */
export function genericPackMatchSkillIdsEmitted(): MatchSkillId[] {
  const ids = new Set<MatchSkillId>();
  for (const questions of Object.values(GENERIC_PACK_MATCH_SKILLS)) {
    for (const options of Object.values(questions)) {
      for (const emitted of Object.values(options)) for (const id of emitted) ids.add(id);
    }
  }
  return [...ids].sort();
}

/** The table's OWN entry for `key`, never an inherited one (see `generic-pack-skills.ts`). */
function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
