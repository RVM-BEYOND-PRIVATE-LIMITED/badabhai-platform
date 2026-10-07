import { describe, expect, it } from "vitest";
import {
  canonicalGenericPackSkills,
  GENERIC_PACK_SKILLS,
  GENERIC_PACKS_WITHOUT_MATCH_SKILL,
  matchSkillsForAttribute,
} from "@badabhai/taxonomy";

import {
  answerRecordsFor,
  GENERIC_PACK_CHAT_CASES,
  latestPack,
} from "./form-onboarding.test-support";

/**
 * #2021 — `GENERIC_PACK_SKILLS` (@badabhai/taxonomy) against the checked-in pack corpus. The table
 * is keyed by the VALUE the answer map stores, so a key that is not a real option value of a real
 * `target_field: skills` question would match nothing, silently. This pins every key.
 */
describe("GENERIC_PACK_SKILLS matches the pack corpus", () => {
  for (const [packId, questions] of Object.entries(GENERIC_PACK_SKILLS)) {
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

  it.each(GENERIC_PACKS_WITHOUT_MATCH_SKILL)(
    "%s is a real pack whose fully-answered skills question derives nothing",
    (packId) => {
      const pack = latestPack(packId);
      const skills = pack.items.filter((i) => i.target_field === "skills");
      expect(skills.length).toBeGreaterThan(0);
      const answers = Object.fromEntries(
        skills.map((i) => [i.question_key, (i.options ?? []).map((o) => o.option_key)]),
      );
      const records = answerRecordsFor(pack, answers);
      const ids = canonicalGenericPackSkills(
        packId,
        records.map((r) => ({
          questionKey: r.question_key,
          values: Array.isArray(r.value_normalized) ? r.value_normalized : [r.value_normalized],
        })),
      );
      expect(ids).toEqual([]);
    },
  );

  it.each(GENERIC_PACK_CHAT_CASES)(
    "$packId chat derives exactly its expected match skills",
    (c) => {
      const records = answerRecordsFor(latestPack(c.packId), c.answers);
      const ids = canonicalGenericPackSkills(
        c.packId,
        records
          .filter((r) => r.target_field === "skills")
          .map((r) => ({
            questionKey: r.question_key,
            values: Array.isArray(r.value_normalized) ? r.value_normalized : [r.value_normalized],
          })),
      );
      const reached = [...new Set(ids.flatMap((id) => [...matchSkillsForAttribute(id)]))].sort();
      expect(reached).toEqual([...c.expected].sort());
    },
  );
});
