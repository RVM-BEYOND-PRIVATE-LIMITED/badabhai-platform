import { describe, expect, it } from "vitest";
import { deriveWorkerSkills, workerSkillDeriveInput } from "@badabhai/match-engine";
import {
  PACK_ANSWER_SKILLS,
  packAnswerFromStoredRow,
  type MatchSkillId,
} from "@badabhai/taxonomy";

import {
  allPackVersions,
  attributesFor,
} from "./form-onboarding.test-support";

/**
 * No-loss on rebuild (#3052 §1).
 *
 * The 6 deepened Wave 1 forms keep their live question keys, and
 * `qp_foundry_forging` v1 is deprecated in place (#3069): its stored answers
 * must still derive. For each, every option a worker could have stored on
 * version 1 of a mapped question must still derive the trade's skill through
 * the CURRENT table — old option keys stay mapped, so a rebuild cannot drop
 * a skill a worker already holds.
 *
 * Offline. No database, no AI models.
 */

const PINNED: Readonly<Record<string, readonly string[]>> = {
  qp_edm_wirecut: ["mskill_edm_wirecut_operator"],
  qp_heat_treatment: ["mskill_heat_treatment_tech"],
  qp_injection_moulding: ["mskill_imm_operator"],
  qp_plc_automation: ["mskill_plc_automation_tech", "mskill_robot_operator_programmer"],
  qp_production_supervisor: ["mskill_production_supervisor"],
  qp_cad_design_3d: ["mskill_cad_designer_3d"],
  qp_foundry_forging: ["mskill_foundry_forging_operator"],
};

function derive(packId: string, pack: { pack_id: string; items: any[] }, answers: Record<string, readonly string[]>): string[] {
  const packAnswers = attributesFor(pack as any, answers).flatMap((attribute: any) => {
    const answer = packAnswerFromStoredRow({
      packId,
      attributeKey: attribute.attributeKey,
      valueText: attribute.valueKind === "text" ? (attribute.value as string) : null,
      valueTextList:
        attribute.valueKind === "text_list" ? [...(attribute.value as readonly string[])] : null,
    });
    return answer ? [answer] : [];
  });
  const input = workerSkillDeriveInput({ profile: null, secondaryRoleIds: [], packAnswers });
  return input === null ? [] : deriveWorkerSkills(input).map((row) => row.skillId).sort();
}

describe.each(Object.keys(PINNED))("%s — v1 stored answers still derive after #3011", (packId) => {
  const v1 = allPackVersions(packId).find((p) => p.version === 1);
  if (!v1) throw new Error(`${packId} has no version 1 in the checked-in corpus`);

  it("every v1 option of every mapped question derives, and only, the pinned set", () => {
    const expected = [...PINNED[packId]!].sort();
    const mapped = PACK_ANSWER_SKILLS[packId];
    expect(mapped, `${packId} has no PACK_ANSWER_SKILLS entry`).toBeDefined();
    let checked = 0;
    for (const [questionKey, byOption] of Object.entries(mapped!)) {
      const item = v1.items.find((i: any) => i.question_key === questionKey);
      if (!item) continue; // v2-only question (e.g. PLC second-skill chip); v1 never stored it
      for (const optionKey of Object.keys(byOption)) {
        const option = (item.options ?? []).find((o: any) => o.option_key === optionKey);
        if (!option) continue; // v2-only chip; v1 never stored it
        if (option.value_text !== undefined) expect(option.value_text).toBe(optionKey);
        else expect(option.value_number ?? option.value_bool).toBeDefined();
        const got = derive(packId, v1, { [questionKey]: [optionKey] });
        // PLC v1 has no robot chip; the pinned set is the v1+v2 union, so assert
        // the v1 chip reaches its trade skill (subset), not the full union.
        if (packId === "qp_plc_automation" && optionKey !== "robot_programming") {
          expect(got).toEqual(["mskill_plc_automation_tech"]);
        } else {
          expect(got.sort()).toEqual(expected);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
