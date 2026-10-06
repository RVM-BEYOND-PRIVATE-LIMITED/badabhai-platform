import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TO_MATCH_SKILLS, ROLE_TO_MATCH_SKILL } from "./match-skills";
import {
  PACK_ANSWER_SKILLS,
  PACKS_WITHOUT_MATCH_SKILL,
  packAnswerEvidence,
  packAnswerFromStoredRow,
  packAnswerIdsEmitted,
} from "./pack-answer-skills";

describe("pack-answer bridge — every id rides an EXISTING bridge", () => {
  it("emits only corpus ids the attribute bridge knows", () => {
    // An id absent from ATTRIBUTE_TO_MATCH_SKILLS contributes nothing and nothing complains — it
    // reads exactly like a worker who legitimately implies no postable skill.
    const unknown = packAnswerIdsEmitted().filter(
      (id) => id.startsWith("skill_") && !(id in ATTRIBUTE_TO_MATCH_SKILLS),
    );
    expect(unknown).toEqual([]);
  });

  it("emits only role ids the role bridge knows", () => {
    const unknown = packAnswerIdsEmitted().filter(
      (id) => id.startsWith("role_") && !(id in ROLE_TO_MATCH_SKILL),
    );
    expect(unknown).toEqual([]);
  });

  it("emits nothing but skill_/role_ ids — never an mskill_ id that would bypass the bridges", () => {
    for (const id of packAnswerIdsEmitted()) expect(id).toMatch(/^(skill|role)_[a-z0-9_]+$/);
  });

  it("every option it maps reaches at least one match skill outside the turner's legacy rows", () => {
    // The added packs are POSTING-LEVEL ONLY: an inert id is review surface with no effect. The
    // turner predates the rule and keeps its attribute-level rows so no turner's set moves.
    for (const [packId, attributes] of Object.entries(PACK_ANSWER_SKILLS)) {
      if (packId === "qp_cnc_turning") continue;
      for (const [key, options] of Object.entries(attributes)) {
        for (const [option, ids] of Object.entries(options)) {
          const reaches = ids.some((id) =>
            id.startsWith("role_")
              ? id in ROLE_TO_MATCH_SKILL
              : (ATTRIBUTE_TO_MATCH_SKILLS[id]?.length ?? 0) > 0,
          );
          expect(reaches, `${packId}.${key}.${option} is mapped but reaches nothing`).toBe(true);
        }
      }
    }
  });

  it("never maps a pack the owner ruled has no match skill", () => {
    for (const packId of PACKS_WITHOUT_MATCH_SKILL) {
      expect(PACK_ANSWER_SKILLS[packId], `${packId} must derive nothing`).toBeUndefined();
    }
  });
});

describe("packAnswerEvidence", () => {
  it("splits corpus ids from role ids, sorted and deduped", () => {
    expect(
      packAnswerEvidence([
        { packId: "qp_vmc_milling", attributeKey: "milling_machine", optionKeys: ["hmc", "vmc"] },
        { packId: "qp_vmc_milling", attributeKey: "programming_level", optionKeys: ["cam"] },
        { packId: "qp_vmc_milling", attributeKey: "milling_machine", optionKeys: ["bed_mill"] },
      ]),
    ).toEqual({
      corpusSkillIds: ["skill_cam_software", "skill_milling"],
      roleIds: ["role_hmc_operator"],
    });
  });

  it("is pack-scoped: a key answered under another pack contributes nothing", () => {
    // `welding_process` is also a question in the GENERIC `qp_welding` pack, and
    // `programming_level` recurs across machining packs. Only the authoring pack's rows count.
    expect(
      packAnswerEvidence([
        { packId: "qp_welding", attributeKey: "welding_process", optionKeys: ["tig"] },
        { packId: "qp_machining", attributeKey: "programming_level", optionKeys: ["cam"] },
        { packId: null, attributeKey: "welding_process", optionKeys: ["tig"] },
      ]),
    ).toEqual({ corpusSkillIds: [], roleIds: [] });
  });

  it("ignores unknown packs, keys and options instead of throwing", () => {
    expect(
      packAnswerEvidence([
        { packId: "qp_not_a_pack", attributeKey: "x", optionKeys: ["y"] },
        { packId: "qp_welding_trade", attributeKey: "welding_process", optionKeys: ["later"] },
      ]),
    ).toEqual({ corpusSkillIds: [], roleIds: [] });
  });
});

describe("packAnswerFromStoredRow", () => {
  it("reads a multi-select list and a single-select scalar the same way", () => {
    expect(
      packAnswerFromStoredRow({
        packId: "qp_welding_trade",
        attributeKey: "welding_process",
        valueText: null,
        valueTextList: ["tig", 7, "arc"],
      }),
    ).toEqual({
      packId: "qp_welding_trade",
      attributeKey: "welding_process",
      optionKeys: ["tig", "arc"],
    });
    expect(
      packAnswerFromStoredRow({
        packId: "qp_cam_programming",
        attributeKey: "programming_mode",
        valueText: "cam_software",
        valueTextList: null,
      })?.optionKeys,
    ).toEqual(["cam_software"]);
  });

  it("returns null for a row holding no text (a boolean or number answer)", () => {
    expect(
      packAnswerFromStoredRow({
        packId: "qp_welding_trade",
        attributeKey: "welding_experience",
        valueText: null,
        valueTextList: null,
      }),
    ).toBeNull();
  });
});
