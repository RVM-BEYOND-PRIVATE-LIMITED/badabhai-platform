import { describe, expect, it } from "vitest";
import { deriveWorkerSkills, workerSkillDeriveInput } from "@badabhai/match-engine";
import {
  canonicalGenericPackSkills,
  GENERIC_PACK_MATCH_SKILLS,
  GENERIC_PACK_SKILLS,
  GENERIC_PACKS_WITHOUT_MATCH_SKILL,
  genericPackSkillAnswers,
} from "@badabhai/taxonomy";

import {
  answerRecordsFor,
  GENERIC_PACK_CHAT_CASES,
  latestPack,
} from "./form-onboarding.test-support";

/** The provenance stamp of a chat the model neither led nor settled (#2021). */
const WORKER_ONLY_STAMP = { llm_led_turns: 0, llm_draft_settled: false } as const;

/**
 * Pins every key of a generic-pack table against the checked-in pack corpus. Both tables are keyed
 * by the VALUE the answer map stores, so a key that is not a real option value of a real
 * `target_field: skills` question would match nothing, silently.
 */
function pinAgainstCorpus(
  table: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>>,
): void {
  for (const [packId, questions] of Object.entries(table)) {
    for (const [questionKey, options] of Object.entries(questions)) {
      it(`${packId}.${questionKey} is a skills question and every mapped key is a stored value`, () => {
        const item = latestPack(packId).items.find((i) => i.question_key === questionKey);
        expect(item, `${packId} has no question ${questionKey}`).toBeDefined();
        expect(item!.target_field).toBe("skills");
        const stored = new Set((item!.options ?? []).map((o) => o.value_text ?? o.option_key));
        for (const value of Object.keys(options)) {
          expect(stored.has(value), `${packId}.${questionKey} stores no value ${value}`).toBe(true);
        }
      });
    }
  }
}

/** #2021 — `GENERIC_PACK_SKILLS` (@badabhai/taxonomy) against the checked-in pack corpus. */
describe("GENERIC_PACK_SKILLS matches the pack corpus", () => {
  pinAgainstCorpus(GENERIC_PACK_SKILLS);

  it.each(GENERIC_PACKS_WITHOUT_MATCH_SKILL)(
    "%s is a real pack whose fully-answered skills question derives no corpus id",
    (packId) => {
      const pack = latestPack(packId);
      const skills = pack.items.filter((i) => i.target_field === "skills");
      expect(skills.length).toBeGreaterThan(0);
      const answers = Object.fromEntries(
        skills.map((i) => [i.question_key, (i.options ?? []).map((o) => o.option_key)]),
      );
      const ids = canonicalGenericPackSkills(
        packId,
        genericPackSkillAnswers(answerRecordsFor(pack, answers)),
      );
      expect(ids).toEqual([]);
    },
  );
});

/** #2075 — `GENERIC_PACK_MATCH_SKILLS` (@badabhai/taxonomy) against the checked-in pack corpus. */
describe("GENERIC_PACK_MATCH_SKILLS matches the pack corpus", () => {
  pinAgainstCorpus(GENERIC_PACK_MATCH_SKILLS);
});

/**
 * Every case, through BOTH generic-pack paths exactly as production runs them: the corpus ids
 * `toExtractionOutput` writes into `worker_profiles.skills` (#2021), and the pack-only match skills
 * the rebuild derives from the profile's source session (#2075), assembled by the shared
 * `workerSkillDeriveInput` both writers of `worker_skill` call.
 */
describe("generic-pack chats derive exactly their expected match skills", () => {
  it.each(GENERIC_PACK_CHAT_CASES)("$packId $answers", (c) => {
    const answerMap = answerRecordsFor(latestPack(c.packId), c.answers);
    const input = workerSkillDeriveInput({
      profile: {
        canonicalRoleId: null,
        profileSkills: canonicalGenericPackSkills(c.packId, genericPackSkillAnswers(answerMap)),
        totalYears: 5,
        sourceSession: { pack_id: c.packId, answer_map: answerMap, ...WORKER_ONLY_STAMP },
      },
      secondaryRoleIds: [],
      packAnswers: [],
    });
    const derived = input === null ? [] : deriveWorkerSkills(input).map((row) => row.skillId);
    expect(derived).toEqual([...c.expected].sort());
  });
});
