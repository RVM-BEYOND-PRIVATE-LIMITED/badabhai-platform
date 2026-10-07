import { describe, expect, it } from "vitest";

import {
  ATTRIBUTE_TO_MATCH_SKILLS,
  ROLE_TO_MATCH_SKILL,
  matchSkillForRole,
  matchSkillsForAttribute,
  type MatchSkillId,
} from "./match-skills";
import {
  PACK_ANSWER_SKILLS,
  PACKS_WITHOUT_MATCH_SKILL,
  matchSkillsForPackAnswerId,
  packAnswerEvidence,
  packAnswerFromStoredRow,
  packAnswerIdsEmitted,
  packReachableMatchSkills,
} from "./pack-answer-skills";
import { SKILL_CORPUS } from "./skill-corpus";
import { WEDGE_ALIASES } from "./wedge-aliases";

/** Every match skill some role or corpus attribute bridges to — the skills chat can reach. */
const BRIDGED = new Set<string>([
  ...Object.values(ROLE_TO_MATCH_SKILL),
  ...Object.values(ATTRIBUTE_TO_MATCH_SKILLS).flat(),
]);

/** What one chip derives, through the same per-id routing `deriveWorkerSkills` applies. */
function chip(packId: string, key: string, option: string): string[] {
  const ids = PACK_ANSWER_SKILLS[packId]?.[key]?.[option];
  if (ids === undefined) throw new Error(`${packId}.${key}.${option} is not mapped`);
  return [...new Set(ids.flatMap((id) => [...matchSkillsForPackAnswerId(id)]))].sort();
}

describe("pack-answer bridge — every id rides an existing bridge or is a pack-only skill", () => {
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

  it("emits nothing but skill_/role_/mskill_ ids", () => {
    for (const id of packAnswerIdsEmitted()) expect(id).toMatch(/^(skill|role|mskill)_[a-z0-9_]+$/);
  });

  it("names an mskill_ DIRECTLY only when no role and no attribute bridges to it (#2022)", () => {
    // The moment a directly-named skill gains a bridge, the bridge must carry it — otherwise a
    // chat worker and a form worker making the same claim would derive different sets.
    const bypassing = packAnswerIdsEmitted().filter(
      (id) => id.startsWith("mskill_") && BRIDGED.has(id),
    );
    expect(bypassing).toEqual([]);
  });

  it("names exactly the eight pack-only skills the owner minted for #2022", () => {
    expect(packAnswerIdsEmitted().filter((id) => id.startsWith("mskill_"))).toEqual([
      "mskill_assembly_line_worker",
      "mskill_conventional_machinist",
      "mskill_industrial_electrician",
      "mskill_maintenance_technician",
      "mskill_painter_coater",
      "mskill_press_operator",
      "mskill_sheet_metal_worker",
      "mskill_tool_die_maker",
    ]);
  });

  it("every option it maps reaches at least one match skill outside the turner's legacy rows", () => {
    // Every pack but the turner is POSTING-LEVEL ONLY: an inert id is review surface with no
    // effect. The turner predates the rule and keeps its attribute-level rows.
    for (const [packId, attributes] of Object.entries(PACK_ANSWER_SKILLS)) {
      if (packId === "qp_cnc_turning") continue;
      for (const [key, options] of Object.entries(attributes)) {
        for (const option of Object.keys(options)) {
          expect(
            chip(packId, key, option).length,
            `${packId}.${key}.${option} is mapped but reaches nothing`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("never maps a pack the owner ruled has no match skill", () => {
    for (const packId of PACKS_WITHOUT_MATCH_SKILL) {
      expect(PACK_ANSWER_SKILLS[packId], `${packId} must derive nothing`).toBeUndefined();
    }
  });

  it("no pack is left without a match skill since #2022", () => {
    expect(PACKS_WITHOUT_MATCH_SKILL).toEqual([]);
  });
});

describe("the reachable set per pack — pinned exactly", () => {
  /**
   * A fully-answered form's upper bound. Pinned so any mapping that widens a trade's reach has to
   * be written here too, in review. The eight #2022 packs each reach their OWN skill and nothing
   * else, except the manual machinist, whose lathe and mill claims also reach the CNC skills by
   * the owner's ruling (#2022 point 1).
   */
  const REACHABLE: Readonly<Record<string, readonly MatchSkillId[]>> = {
    qp_cnc_turning: [
      "mskill_cam_programmer",
      "mskill_cnc_programmer",
      "mskill_cnc_turner",
      "mskill_conventional_machinist",
    ],
    qp_vmc_milling: [
      "mskill_cam_programmer",
      "mskill_cnc_programmer",
      "mskill_conventional_machinist",
      "mskill_hmc_operator",
      "mskill_vmc_operator",
    ],
    qp_cnc_grinding: ["mskill_cnc_grinding_operator"],
    qp_cam_programming: ["mskill_cam_programmer", "mskill_cnc_programmer"],
    qp_cad_drafting: ["mskill_designer"],
    qp_welding_trade: ["mskill_arc_welder", "mskill_mig_welder", "mskill_tig_welder"],
    qp_fitter: ["mskill_fitter"],
    qp_quality_inspection: ["mskill_quality_inspector"],
    qp_conventional_machining: [
      "mskill_cnc_turner",
      "mskill_conventional_machinist",
      "mskill_vmc_operator",
    ],
    qp_tool_die_making: ["mskill_tool_die_maker"],
    qp_sheet_metal_fab: ["mskill_sheet_metal_worker"],
    qp_press_operation: ["mskill_press_operator"],
    qp_powder_coating: ["mskill_painter_coater"],
    qp_maintenance_tech: ["mskill_maintenance_technician"],
    qp_industrial_electrician: ["mskill_industrial_electrician"],
    qp_assembly_line: ["mskill_assembly_line_worker"],
  };

  it("pins every mapped pack", () => {
    expect(Object.keys(REACHABLE).sort()).toEqual(Object.keys(PACK_ANSWER_SKILLS).sort());
  });

  it.each(Object.entries(REACHABLE))("%s reaches exactly its pinned set", (packId, reachable) => {
    expect(packReachableMatchSkills(packId)).toEqual([...reachable].sort());
  });

  it("each #2022 skill is reached from its own trade's pack and from no unrelated one", () => {
    const owners: Readonly<Record<string, readonly string[]>> = {
      mskill_conventional_machinist: [
        "qp_cnc_turning",
        "qp_conventional_machining",
        "qp_vmc_milling",
      ],
      mskill_tool_die_maker: ["qp_tool_die_making"],
      mskill_sheet_metal_worker: ["qp_sheet_metal_fab"],
      mskill_press_operator: ["qp_press_operation"],
      mskill_painter_coater: ["qp_powder_coating"],
      mskill_maintenance_technician: ["qp_maintenance_tech"],
      mskill_industrial_electrician: ["qp_industrial_electrician"],
      mskill_assembly_line_worker: ["qp_assembly_line"],
    };
    for (const [skill, packs] of Object.entries(owners)) {
      const reachedFrom = Object.keys(PACK_ANSWER_SKILLS)
        .filter((packId) => (packReachableMatchSkills(packId) as string[]).includes(skill))
        .sort();
      expect(reachedFrom, skill).toEqual([...packs].sort());
    }
  });
});

describe("manual machines — every path agrees (owner ruling, #2022 point 1)", () => {
  /**
   * A worker on a manual lathe, mill or grinder reaches the CNC Turner / VMC Operator / CNC
   * Grinding Operator postings, whichever way he tells us. Each family lists:
   *   - every PACK-ANSWER chip that claims the manual machine, on any form;
   *   - the corpus ATTRIBUTE the claim resolves to;
   *   - the FREE-TEXT phrases (corpus and ratified wedge aliases) a chat worker uses for it;
   *   - the ROLE the chat keyword table resolves for it, where one exists.
   * All four must reach the same CNC skill.
   */
  const FAMILIES = [
    {
      cnc: "mskill_cnc_turner",
      chips: [
        ["qp_cnc_turning", "turning_machine", "conventional_lathe"],
        ["qp_conventional_machining", "machining_machine", "centre_lathe"],
        ["qp_conventional_machining", "machining_operation", "turning_facing"],
        ["qp_conventional_machining", "machining_operation", "knurling"],
      ],
      attribute: "skill_turning",
      phrases: ["lathe operation", "kharad", "kharad ka kaam"],
      role: "role_cnc_turner_operator",
    },
    {
      cnc: "mskill_vmc_operator",
      chips: [
        ["qp_vmc_milling", "milling_machine", "conventional_mill"],
        ["qp_vmc_milling", "milling_machine", "bed_mill"],
        ["qp_conventional_machining", "machining_machine", "vertical_milling"],
        ["qp_conventional_machining", "machining_operation", "milling_slotting"],
      ],
      attribute: "skill_milling",
      phrases: ["milling"],
      role: null,
    },
    {
      cnc: "mskill_cnc_grinding_operator",
      chips: [["qp_cnc_grinding", "grinding_type", "conventional"]],
      attribute: "skill_grinding_ops",
      phrases: ["grinding", "ghisai"],
      role: "role_cnc_grinding_operator",
    },
  ] as const;

  /** Free-text phrase → the corpus id it resolves to by exact alias (corpus or ratified wedge). */
  function aliasTarget(phrase: string): string | undefined {
    const fromCorpus = SKILL_CORPUS.find((s) =>
      s.aliases.some((a) => a.text.toLowerCase() === phrase),
    );
    if (fromCorpus) return fromCorpus.skillId;
    return WEDGE_ALIASES.find((w) => w.ratified && w.alias.text.toLowerCase() === phrase)?.skillId;
  }

  it.each(FAMILIES)("$cnc: pack answers, attribute, free text and role all reach it", (f) => {
    for (const [packId, key, option] of f.chips) {
      expect(chip(packId, key, option), `${packId}.${key}.${option}`).toContain(f.cnc);
    }
    expect(matchSkillsForAttribute(f.attribute)).toContain(f.cnc);
    for (const phrase of f.phrases) {
      expect(aliasTarget(phrase), `"${phrase}"`).toBe(f.attribute);
    }
    if (f.role !== null) expect(matchSkillForRole(f.role)).toBe(f.cnc);
  });

  it("the same manual-lathe claim derives the same set on the turning form and the manual form", () => {
    expect(chip("qp_cnc_turning", "turning_machine", "conventional_lathe")).toEqual(
      chip("qp_conventional_machining", "machining_machine", "centre_lathe"),
    );
    expect(chip("qp_vmc_milling", "milling_machine", "conventional_mill")).toEqual(
      chip("qp_conventional_machining", "machining_machine", "vertical_milling"),
    );
    expect(chip("qp_vmc_milling", "milling_machine", "bed_mill")).toEqual(
      chip("qp_conventional_machining", "machining_machine", "vertical_milling"),
    );
  });

  it("a manual lathe or mill claim also reaches the manual machinist's own skill", () => {
    expect(chip("qp_conventional_machining", "machining_machine", "centre_lathe")).toEqual([
      "mskill_cnc_turner",
      "mskill_conventional_machinist",
    ]);
    expect(chip("qp_conventional_machining", "machining_machine", "shaper_planer")).toEqual([
      "mskill_conventional_machinist",
    ]);
    // A manual GRINDER is a different ITI trade (Machinist Grinder): CNC grinding only.
    expect(chip("qp_cnc_grinding", "grinding_type", "conventional")).toEqual([
      "mskill_cnc_grinding_operator",
    ]);
  });

  it("the legacy attribute rows are unchanged", () => {
    expect(matchSkillsForAttribute("skill_turning")).toEqual(["mskill_cnc_turner"]);
    expect(matchSkillsForAttribute("skill_milling")).toEqual(["mskill_vmc_operator"]);
    expect(matchSkillsForAttribute("skill_grinding_ops")).toEqual(["mskill_cnc_grinding_operator"]);
  });
});

describe("packAnswerEvidence", () => {
  it("splits corpus ids, role ids and pack-only match skills, sorted and deduped", () => {
    expect(
      packAnswerEvidence([
        { packId: "qp_vmc_milling", attributeKey: "milling_machine", optionKeys: ["hmc", "vmc"] },
        { packId: "qp_vmc_milling", attributeKey: "programming_level", optionKeys: ["cam"] },
        { packId: "qp_vmc_milling", attributeKey: "milling_machine", optionKeys: ["bed_mill"] },
      ]),
    ).toEqual({
      corpusSkillIds: ["skill_cam_software", "skill_milling"],
      roleIds: ["role_hmc_operator"],
      matchSkillIds: ["mskill_conventional_machinist"],
    });
    expect(
      packAnswerEvidence([
        {
          packId: "qp_press_operation",
          attributeKey: "press_machine",
          optionKeys: ["hydraulic_press", "fly_press"],
        },
        {
          packId: "qp_press_operation",
          attributeKey: "press_die_type",
          optionKeys: ["progressive"],
        },
      ]),
    ).toEqual({ corpusSkillIds: [], roleIds: [], matchSkillIds: ["mskill_press_operator"] });
  });

  it("is pack-scoped: a key answered under another pack contributes nothing", () => {
    // `welding_process` is also a question in the GENERIC `qp_welding` pack, and
    // `programming_level` recurs across machining packs. Only the authoring pack's rows count.
    expect(
      packAnswerEvidence([
        { packId: "qp_welding", attributeKey: "welding_process", optionKeys: ["tig"] },
        { packId: "qp_machining", attributeKey: "programming_level", optionKeys: ["cam"] },
        { packId: null, attributeKey: "welding_process", optionKeys: ["tig"] },
        { packId: "qp_universal", attributeKey: "assembly_stage", optionKeys: ["sub_assembly"] },
      ]),
    ).toEqual({ corpusSkillIds: [], roleIds: [], matchSkillIds: [] });
  });

  it("ignores unknown packs, keys and options instead of throwing", () => {
    expect(
      packAnswerEvidence([
        { packId: "qp_not_a_pack", attributeKey: "x", optionKeys: ["y"] },
        { packId: "qp_welding_trade", attributeKey: "welding_process", optionKeys: ["later"] },
        {
          packId: "qp_assembly_line",
          attributeKey: "assembly_stage",
          optionKeys: ["line_feeding"],
        },
      ]),
    ).toEqual({ corpusSkillIds: [], roleIds: [], matchSkillIds: [] });
  });
});

describe("matchSkillsForPackAnswerId — one resolver for all three routes", () => {
  it("routes each kind of id the way deriveWorkerSkills does", () => {
    expect(matchSkillsForPackAnswerId("mskill_press_operator")).toEqual(["mskill_press_operator"]);
    expect(matchSkillsForPackAnswerId("role_hmc_operator")).toEqual(["mskill_hmc_operator"]);
    expect(matchSkillsForPackAnswerId("skill_turning")).toEqual(["mskill_cnc_turner"]);
    expect(matchSkillsForPackAnswerId("skill_fanuc")).toEqual([]);
    expect(matchSkillsForPackAnswerId("role_nope")).toEqual([]);
    expect(matchSkillsForPackAnswerId("mskill_nope")).toEqual([]);
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
