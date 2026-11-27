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

  it("names exactly the pack-only skills: #2022, Phase 2 trades, Wave 1-3 new and foundry-split trades", () => {
    expect(packAnswerIdsEmitted().filter((id) => id.startsWith("mskill_"))).toEqual([
      "mskill_assembly_line_worker",
      // #3016: the eighteen Wave 2 trades of CEO pack v2 (minted by #3001), each pack-only.
      "mskill_blow_moulding_operator",
      "mskill_boring_machine_operator",
      // #3017: CAE / FEA (T59), pack-only.
      "mskill_cae_analyst",
      "mskill_calibration_technician",
      // #3011: the nine new Wave 1 trades of CEO pack v2 (minted by #3001), each pack-only.
      "mskill_cmm_operator",
      "mskill_cnc_router_operator",
      "mskill_conventional_machinist",
      // #3016: the Wave 2 crane trade — named directly only by the forklift form's hydra chip.
      "mskill_crane_operator",
      // #3011 (foundry split, T25): pressure and gravity die casting, pack-only.
      "mskill_die_casting_operator",
      // #3017: dispatch / logistics (T55), pack-only.
      "mskill_dispatch_logistics_executive",
      // Phase 2 #7: the new EDM trade's own ID.
      "mskill_edm_wirecut_operator",
      // #3016: fabrication (T22), pack-only.
      "mskill_fabricator",
      // #3011 (foundry split, T26): hammer, press and upset forging, pack-only.
      "mskill_forging_operator",
      "mskill_forklift_operator",
      // Phase 2 #11: the new foundry / forging trade's own ID.
      "mskill_foundry_forging_operator",
      // #3011 (foundry split, T24): sand moulding and core making, melting and fettling.
      "mskill_foundry_operator",
      // #3016: gear cutting (T18), pack-only.
      "mskill_gear_cutting_operator",
      // Phase 2 #8: the new heat-treatment trade's own ID.
      "mskill_heat_treatment_tech",
      // #3016: HVAC / refrigeration (T41), pack-only.
      "mskill_hvac_rac_technician",
      // Phase 2 #9: the new injection-moulding trade's own ID.
      "mskill_imm_operator",
      "mskill_industrial_electrician",
      // #3016: instrumentation (T40), pack-only.
      "mskill_instrumentation_technician",
      "mskill_maintenance_engineer",
      "mskill_maintenance_technician",
      // #3016: material / met lab (T36), pack-only.
      "mskill_material_lab_technician",
      // #3016: NDT (T34), pack-only.
      "mskill_ndt_technician",
      "mskill_npd_engineer",
      "mskill_painter_coater",
      // #3017: piping designer (T60), pack-only.
      "mskill_piping_designer",
      // #3016: plastic extrusion (T31) and plating / surface treatment (T28), pack-only.
      "mskill_plastic_extrusion_operator",
      "mskill_plating_operator",
      // Phase 2 #6: the new PLC trade's own ID, pack-only like the #2022 mints.
      "mskill_plc_automation_tech",
      "mskill_ppc_engineer",
      "mskill_press_operator",
      "mskill_process_engineer",
      "mskill_production_engineer",
      // Phase 2 #10: the new production supervisor's own ID.
      "mskill_production_supervisor",
      // #3017: project / site (T50), pack-only.
      "mskill_project_site_engineer",
      "mskill_purchase_engineer",
      "mskill_quality_engineer",
      // #3011 §3: the PLC form's second-skill chip (robot programming).
      "mskill_robot_operator_programmer",
      // #3016: rubber moulding (T32), pack-only.
      "mskill_rubber_moulding_operator",
      // #3017: safety / EHS (T49), pack-only.
      "mskill_safety_officer",
      // #3017: service engineer (T44), pack-only.
      "mskill_service_engineer",
      "mskill_sheet_metal_worker",
      // #3016: SPM finishing (T20), pack-only.
      "mskill_spm_finishing_operator",
      // #3017: store keeper (T53), pack-only.
      "mskill_store_keeper",
      // #3017: technical sales (T51), pack-only.
      "mskill_technical_sales_engineer",
      "mskill_tool_die_maker",
      // #3016: tube bending (T23) and utility (T42), pack-only.
      "mskill_tube_bending_operator",
      "mskill_utility_operator",
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
    // Middle Way E0 (Q3): the CAD drafting pack's 3D-module chips now reach the 3D
    // designer; 2D chips stay on the (relabeled) 2D ID. Reach widening, written here
    // explicitly per this table's contract.
    qp_cad_drafting: ["mskill_3d_designer", "mskill_designer"],
    // CEO Launch Plan Pack v1, Track A #4: the new trade's software answers derive
    // its permanent ID directly (role bridge); the E0 ID stays reachable via pairing.
    qp_cad_design_3d: ["mskill_cad_designer_3d"],
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
    // Phase 2 #6: a named PLC or a programming/HMI/drive task reaches the new trade; #3011 §3:
    // the second-skill chip `plc_advanced_system` = `robot_programming` adds the robot skill.
    qp_plc_automation: ["mskill_plc_automation_tech", "mskill_robot_operator_programmer"],
    // Phase 2 #7: a named EDM machine reaches the new trade.
    qp_edm_wirecut: ["mskill_edm_wirecut_operator"],
    // Phase 2 #8: a named heat-treatment process reaches the new trade.
    qp_heat_treatment: ["mskill_heat_treatment_tech"],
    // Phase 2 #11: a named casting or forging process reaches the new trade.
    qp_foundry_forging: ["mskill_foundry_forging_operator"],
    // Phase 2 #9: a named moulding-machine brand reaches the new trade.
    qp_injection_moulding: ["mskill_imm_operator"],
    // Phase 2 #10: a named production department reaches the new trade.
    qp_production_supervisor: ["mskill_production_supervisor"],
    qp_industrial_electrician: ["mskill_industrial_electrician"],
    qp_assembly_line: ["mskill_assembly_line_worker"],
    // #3011: each new Wave 1 trade's claim question reaches its own skill and nothing else.
    // T24-T26 are the #3009 foundry split (casting, die casting, forging).
    qp_cnc_router: ["mskill_cnc_router_operator"],
    qp_cmm: ["mskill_cmm_operator"],
    qp_quality_engineer: ["mskill_quality_engineer"],
    qp_maintenance_engineer: ["mskill_maintenance_engineer"],
    qp_production_engineer: ["mskill_production_engineer"],
    qp_process_engineer: ["mskill_process_engineer"],
    qp_npd_engineer: ["mskill_npd_engineer"],
    qp_ppc: ["mskill_ppc_engineer"],
    qp_purchase: ["mskill_purchase_engineer"],
    qp_foundry_casting: ["mskill_foundry_operator"],
    qp_die_casting: ["mskill_die_casting_operator"],
    qp_forging: ["mskill_forging_operator"],
    // #3016: each new Wave 2 trade's claim question reaches its own skill and nothing else,
    // except the two second-skill chips — the robotics PLC chip adds the PLC skill and the
    // forklift hydra chip adds the crane skill.
    qp_gear_cutting: ["mskill_gear_cutting_operator"],
    qp_boring_machine: ["mskill_boring_machine_operator"],
    qp_spm_finishing: ["mskill_spm_finishing_operator"],
    qp_fabrication: ["mskill_fabricator"],
    qp_tube_forming: ["mskill_tube_bending_operator"],
    qp_surface_treatment: ["mskill_plating_operator"],
    qp_blow_moulding: ["mskill_blow_moulding_operator"],
    qp_plastic_extrusion: ["mskill_plastic_extrusion_operator"],
    qp_rubber_moulding: ["mskill_rubber_moulding_operator"],
    qp_ndt: ["mskill_ndt_technician"],
    qp_calibration: ["mskill_calibration_technician"],
    qp_material_lab: ["mskill_material_lab_technician"],
    qp_robotics: ["mskill_plc_automation_tech", "mskill_robot_operator_programmer"],
    qp_instrumentation: ["mskill_instrumentation_technician"],
    qp_hvac_rac: ["mskill_hvac_rac_technician"],
    qp_utility: ["mskill_utility_operator"],
    qp_forklift: ["mskill_crane_operator", "mskill_forklift_operator"],
    qp_crane_rigging: ["mskill_crane_operator"],
    // #3017: each new Wave 3 trade's claim question reaches its own skill and nothing else.
    qp_service_engineer: ["mskill_service_engineer"],
    qp_safety_ehs: ["mskill_safety_officer"],
    qp_project_site: ["mskill_project_site_engineer"],
    qp_technical_sales: ["mskill_technical_sales_engineer"],
    qp_stores: ["mskill_store_keeper"],
    qp_dispatch_logistics: ["mskill_dispatch_logistics_executive"],
    qp_cae_fea: ["mskill_cae_analyst"],
    qp_piping_design: ["mskill_piping_designer"],
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
