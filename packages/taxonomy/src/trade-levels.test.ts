import { describe, expect, it } from "vitest";

import {
  isLevelConfirmed,
  normalizeTradeLevelKey,
  priceTierForLevels,
  priceTierForTradeLevel,
  priceTierForTradeRows,
  priceTierForTradeSkill,
  TRADE_LEVEL_LABELS,
  TRADE_LEVEL_PACKS,
  tradeLevelEntriesForPackAnswers,
  tradeLevelLabelFor,
} from "./trade-levels";

/**
 * C6 crosswalk — pack level answers → trade skill + `TradeLevel` (Middle Way P5).
 *
 * The load-bearing properties: the match engine never reads this file (reach and
 * rank cannot move — DoD §7.7/8), every ladder's floor maps to unconfirmed, every
 * alias spelling lands on the canonical key, and null prices Lower.
 */
describe("trade-level crosswalk", () => {
  it("covers the four v1 trades plus the CAD trades, the fitter, the electrician, the welder, the conventional machinist, the sheet-metal operator, the assembly technician, the QC inspector, the tool & die maker, the press-shop operator, the painter / coater, the maintenance technician, the PLC / automation technician, the EDM / wire-cut operator, the injection-moulding operator, the heat-treatment technician, the production supervisor and the foundry / forging operator, each with its skill and level key", () => {
    expect(TRADE_LEVEL_PACKS).toEqual({
      qp_cnc_turning: { skillId: "mskill_cnc_turner", levelKey: "turning_level" },
      qp_vmc_milling: { skillId: "mskill_vmc_operator", levelKey: "milling_level" },
      qp_cnc_grinding: { skillId: "mskill_cnc_grinding_operator", levelKey: "grinding_level" },
      qp_cam_programming: { skillId: "mskill_cam_programmer", levelKey: "cam_level" },
      qp_cad_design_3d: { skillId: "mskill_cad_designer_3d", levelKey: "design_level" },
      qp_cad_drafting: {
        skillId: "mskill_designer",
        levelKey: "cad_level",
        labels: {
          trainee: "Trainee",
          designer: "Draughtsman",
          senior_designer: "Senior Draughtsman",
          lead: "Lead",
          supervisor: "Head",
        },
      },
      qp_fitter: { skillId: "mskill_fitter", levelKey: "fitter_level" },
      qp_industrial_electrician: { skillId: "mskill_industrial_electrician", levelKey: "electrician_level" },
      qp_welding_trade: { skillId: "mskill_welder", levelKey: "welder_level" },
      qp_conventional_machining: { skillId: "mskill_conventional_machinist", levelKey: "machining_level" },
      qp_sheet_metal_fab: { skillId: "mskill_sheet_metal_worker", levelKey: "sheet_metal_level" },
      qp_assembly_line: { skillId: "mskill_assembly_line_worker", levelKey: "assembly_level" },
      qp_quality_inspection: { skillId: "mskill_quality_inspector", levelKey: "inspection_level" },
      qp_tool_die_making: { skillId: "mskill_tool_die_maker", levelKey: "toolroom_level" },
      qp_press_operation: { skillId: "mskill_press_operator", levelKey: "press_level" },
      qp_powder_coating: { skillId: "mskill_painter_coater", levelKey: "coating_level" },
      qp_maintenance_tech: {
        skillId: "mskill_maintenance_technician",
        levelKey: "maintenance_level",
      },
      qp_plc_automation: {
        skillId: "mskill_plc_automation_tech",
        levelKey: "plc_level",
        tierOverrides: { technician: "higher" },
      },
      qp_edm_wirecut: { skillId: "mskill_edm_wirecut_operator", levelKey: "edm_level" },
      qp_heat_treatment: { skillId: "mskill_heat_treatment_tech", levelKey: "heat_level" },
      qp_foundry_forging: { skillId: "mskill_foundry_forging_operator", levelKey: "foundry_level" },
      qp_injection_moulding: { skillId: "mskill_imm_operator", levelKey: "moulding_level" },
      qp_production_supervisor: {
        skillId: "mskill_production_supervisor",
        levelKey: "supervision_level",
        labels: {
          senior: "Line Leader",
          supervisor: "Supervisor",
          lead: "Production In-charge",
        },
        unconfirmedRungs: ["senior"],
      },
    });
  });

  it("normalises every canonical key to itself", () => {
    for (const key of Object.keys(TRADE_LEVEL_LABELS)) {
      expect(normalizeTradeLevelKey(key)).toBe(key);
    }
  });

  it("canonicalises the pack's alias spellings", () => {
    // qp_cnc_turning@3 authors option_key setter_cum_programmer with value_text
    // setter_programmer — the stored answer may be either.
    expect(normalizeTradeLevelKey("setter_cum_programmer")).toBe("setter_programmer");
    expect(normalizeTradeLevelKey("setter_programmer")).toBe("setter_programmer");
    expect(normalizeTradeLevelKey("Setter-cum-Programmer")).toBe("setter_programmer");
    expect(normalizeTradeLevelKey("  OPERATOR ")).toBe("operator");
    // CEO Launch Pack v1 (RULED 2026-11-02, reconciled): bare "junior" is a trainee
    // claim (no ladder carries junior_programmer anymore); bare "senior" IS a union
    // member and the union check runs first, so it names the new shared rung.
    expect(normalizeTradeLevelKey("junior")).toBe("trainee");
    expect(normalizeTradeLevelKey("senior")).toBe("senior");
    // Track B #3 — qp_welding_trade@1 stored `certified_welder` for the
    // skilled rung; @2 keeps the key as a history chip.
    expect(normalizeTradeLevelKey("certified_welder")).toBe("skilled");
    expect(normalizeTradeLevelKey("Certified Welder")).toBe("skilled");
    // Phase 2 #1 — qp_tool_die_making@1 stored `tool_maker` the same way.
    expect(normalizeTradeLevelKey("tool_maker")).toBe("skilled");
    expect(normalizeTradeLevelKey("Tool maker")).toBe("skilled");
  });

  it("returns null instead of guessing", () => {
    expect(normalizeTradeLevelKey("")).toBeNull();
    expect(normalizeTradeLevelKey("boss")).toBeNull();
    expect(normalizeTradeLevelKey(null)).toBeNull();
    expect(normalizeTradeLevelKey(42)).toBeNull();
  });

  it("confirms Setter and above only, per ladder", () => {
    for (const rung of [
      "helper",
      "trainee",
      "operator",
      "junior_programmer",
      "technician",
      "inspector",
      "designer",
      // Track B #1 — the fitter operator rung does not confirm.
      "fitter",
      // Track B #2 — the electrician operator rung does not confirm.
      "electrician",
      // Track B #3 — the welder operator rung does not confirm.
      "welder",
    ] as const) {
      expect(isLevelConfirmed(rung), rung).toBe(false);
    }
    for (const rung of [
      "setter",
      "setter_programmer",
      "programmer",
      "senior_programmer",
      "supervisor",
      "senior_draughtsman",
      "senior_designer",
      "lead_checker",
      "design_engineer_lead",
      // CEO Launch Pack v1 (RULED 2026-11-02, reconciled) — one separating rung
      // per sheet: skilled ladders from `skilled`, technician ladders from
      // `senior_technician`, QC from `senior_inspector`; `senior`/`lead` confirm
      // everywhere they appear.
      "skilled",
      "senior",
      "senior_technician",
      "senior_inspector",
      "qc_engineer",
      "lead",
      // Track B #1 — the fitter senior rung confirms.
      "senior_fitter",
    ] as const) {
      expect(isLevelConfirmed(rung), rung).toBe(true);
    }
    expect(isLevelConfirmed(null)).toBe(false);
  });

  it("prices null and the floor Lower, Setter and above Higher", () => {
    expect(priceTierForTradeLevel(null)).toBe("lower");
    for (const rung of [
      "helper",
      "operator",
      "trainee",
      "draughtsman",
      "trainee_modeller",
      "cad_designer",
      "junior_programmer",
      "technician",
      "inspector",
      "designer",
      // Track B #1 — the fitter operator rung prices Lower.
      "fitter",
      // Track B #2 — the electrician operator rung prices Lower.
      "electrician",
      // Track B #3 — the welder operator rung prices Lower.
      "welder",
    ] as const) {
      expect(priceTierForTradeLevel(rung), rung).toBe("lower");
    }
    for (const rung of [
      "setter",
      "setter_programmer",
      "programmer",
      "supervisor",
      "skilled",
      "senior",
      "senior_technician",
      "senior_inspector",
      "qc_engineer",
      "lead",
      // Track B #1 — the fitter senior rung prices Higher.
      "senior_fitter",
    ] as const) {
      expect(priceTierForTradeLevel(rung), rung).toBe("higher");
    }
  });

  describe("A4 item 8 — every trade's tiers follow its OWN sheet (CEO Launch Plan Pack v1)", () => {
    // Each sheet's Tier column / "Tiers:" line, transcribed rung by rung. The shared rule is
    // right for 22 sheets; PLC's "technician+ Higher" is the one per-pack override.
    const L = "lower" as const;
    const H = "higher" as const;
    const SHEET_TIERS: Readonly<Record<string, Readonly<Record<string, "lower" | "higher">>>> = {
      qp_cnc_turning: { trainee: L, operator: L, setter: H, setter_programmer: H, programmer: H, supervisor: H }, // sheet 1
      qp_vmc_milling: { trainee: L, operator: L, setter: H, setter_programmer: H, programmer: H, supervisor: H }, // 2
      qp_cam_programming: { trainee: L, programmer: H, senior: H, lead: H, supervisor: H }, // 3
      qp_cad_design_3d: { trainee: L, designer: L, senior_designer: H, lead: H, supervisor: H }, // 4
      qp_cad_drafting: { trainee: L, designer: L, senior_designer: H, lead: H, supervisor: H }, // 5
      qp_fitter: { trainee: L, operator: L, fitter: L, skilled: H, senior: H, senior_fitter: H, supervisor: H }, // 6
      qp_industrial_electrician: { trainee: L, technician: L, electrician: L, senior_technician: H, senior: H, supervisor: H }, // 7
      qp_welding_trade: { trainee: L, operator: L, welder: L, skilled: H, senior: H, supervisor: H }, // 8
      qp_conventional_machining: { trainee: L, operator: L, skilled: H, senior: H, supervisor: H }, // 9
      qp_sheet_metal_fab: { trainee: L, operator: L, skilled: H, senior: H, supervisor: H }, // 10
      qp_assembly_line: { trainee: L, operator: L, skilled: H, senior: H, supervisor: H }, // 11
      qp_quality_inspection: { trainee: L, inspector: L, senior_inspector: H, qc_engineer: H, supervisor: H }, // 12
      qp_tool_die_making: { trainee: L, operator: L, skilled: H, senior: H, supervisor: H }, // 13
      qp_plc_automation: { trainee: L, technician: H, senior_technician: H, lead: H, supervisor: H }, // 14
      qp_cnc_grinding: { trainee: L, operator: L, setter: H, setter_programmer: H, supervisor: H }, // 15
      qp_edm_wirecut: { trainee: L, operator: L, setter: H, setter_programmer: H, supervisor: H }, // 16
      qp_heat_treatment: { trainee: L, operator: L, skilled: H, senior: H, supervisor: H }, // 17
      qp_press_operation: { trainee: L, operator: L, setter: H, senior: H, supervisor: H }, // 18
      qp_foundry_forging: { trainee: L, operator: L, skilled: H, senior: H, supervisor: H }, // 19
      qp_powder_coating: { trainee: L, operator: L, skilled: H, senior: H, supervisor: H }, // 20
      qp_maintenance_tech: { trainee: L, technician: L, senior_technician: H, supervisor: H }, // 21
      qp_injection_moulding: { trainee: L, operator: L, setter: H, senior: H, supervisor: H }, // 22
      qp_production_supervisor: { senior: H, supervisor: H, lead: H }, // 23 — "all Higher"
    };

    it("covers exactly the crosswalk's trades, one trade skill per pack", () => {
      expect(Object.keys(SHEET_TIERS).sort()).toEqual(Object.keys(TRADE_LEVEL_PACKS).sort());
      const skills = Object.values(TRADE_LEVEL_PACKS).map((p) => p.skillId);
      expect(new Set(skills).size).toBe(skills.length);
    });

    it.each(Object.entries(SHEET_TIERS))("%s prices every rung as its sheet does", (pack, tiers) => {
      const skillId = TRADE_LEVEL_PACKS[pack]!.skillId;
      for (const [rung, tier] of Object.entries(tiers)) {
        const level = normalizeTradeLevelKey(rung);
        expect(level, `${pack}:${rung} is a TradeLevel`).not.toBeNull();
        expect(priceTierForTradeSkill(skillId, level), `${pack}:${rung}`).toBe(tier);
        // Supervisor is Confirmed + Higher in every trade (Q4).
        if (rung === "supervisor") expect(tier).toBe("higher");
      }
    });

    it("the same key prices by its trade: technician is Higher on PLC, Lower on the electrician and maintenance sheets", () => {
      expect(priceTierForTradeSkill("mskill_plc_automation_tech", "technician")).toBe("higher");
      expect(priceTierForTradeSkill("mskill_industrial_electrician", "technician")).toBe("lower");
      expect(priceTierForTradeSkill("mskill_maintenance_technician", "technician")).toBe("lower");
      // A skill outside the crosswalk (a legacy row) and the trade-blind function keep the
      // shared rule; null never prices up.
      expect(priceTierForTradeSkill("mskill_cnc_operator_general", "technician")).toBe("lower");
      expect(priceTierForTradeSkill(null, "technician")).toBe("lower");
      expect(priceTierForTradeLevel("technician")).toBe("lower");
      expect(priceTierForTradeSkill("mskill_plc_automation_tech", null)).toBe("lower");
    });

    it("prices a worker's rows Higher if ANY row prices Higher on its own sheet, else Lower", () => {
      expect(priceTierForTradeRows([])).toBe("lower");
      expect(priceTierForTradeRows([{ skillId: "mskill_plc_automation_tech", tradeLevel: null }])).toBe(
        "lower",
      );
      expect(
        priceTierForTradeRows([{ skillId: "mskill_plc_automation_tech", tradeLevel: "technician" }]),
      ).toBe("higher");
      expect(
        priceTierForTradeRows([
          { skillId: "mskill_industrial_electrician", tradeLevel: "technician" },
          { skillId: "mskill_cnc_turner", tradeLevel: "operator" },
        ]),
      ).toBe("lower");
      expect(
        priceTierForTradeRows([
          { skillId: "mskill_industrial_electrician", tradeLevel: "technician" },
          { skillId: "mskill_plc_automation_tech", tradeLevel: "technician" },
        ]),
      ).toBe("higher");
    });
  });

  it("prices a worker Higher if ANY rung prices Higher, else Lower", () => {
    expect(priceTierForLevels([])).toBe("lower");
    expect(priceTierForLevels([null])).toBe("lower");
    expect(priceTierForLevels(["helper", "operator"])).toBe("lower");
    expect(priceTierForLevels(["helper", "setter"])).toBe("higher");
    expect(priceTierForLevels(["junior_programmer"])).toBe("lower");
    expect(priceTierForLevels(["senior_programmer"])).toBe("higher");
  });

  it("labels a pack's stored answer for the headline, null when unstated", () => {
    expect(tradeLevelLabelFor("qp_cnc_turning", "setter_cum_programmer")).toBe(
      "Setter-cum-Programmer",
    );
    expect(tradeLevelLabelFor("qp_cnc_turning", "setter_programmer")).toBe("Setter-cum-Programmer");
    expect(tradeLevelLabelFor("qp_cam_programming", "senior_programmer")).toBe("Senior Programmer");
    expect(tradeLevelLabelFor("qp_cnc_turning", null)).toBeNull();
    expect(tradeLevelLabelFor("qp_cnc_turning", "boss")).toBeNull();
    expect(tradeLevelLabelFor("qp_welding", "setter")).toBeNull();
    // CEO shared vocabulary (RULED 2026-11-02, reconciled) — display labels for
    // the new rungs, pinned so a headline can never print a raw key.
    expect(tradeLevelLabelFor("qp_cnc_turning", "skilled")).toBe("Skilled");
    expect(tradeLevelLabelFor("qp_cnc_turning", "senior")).toBe("Senior");
    expect(tradeLevelLabelFor("qp_cnc_turning", "technician")).toBe("Technician");
    expect(tradeLevelLabelFor("qp_cnc_turning", "senior_technician")).toBe("Senior Technician");
    expect(tradeLevelLabelFor("qp_cnc_turning", "inspector")).toBe("Inspector");
    expect(tradeLevelLabelFor("qp_cnc_turning", "senior_inspector")).toBe("Senior Inspector");
    expect(tradeLevelLabelFor("qp_cnc_turning", "qc_engineer")).toBe("QC Engineer");
    expect(tradeLevelLabelFor("qp_cnc_turning", "designer")).toBe("Designer");
    expect(tradeLevelLabelFor("qp_cnc_turning", "lead")).toBe("Lead");
    // Track B #1 — the fitter rungs print the trade's words anywhere.
    expect(tradeLevelLabelFor("qp_fitter", "helper")).toBe("Helper");
    expect(tradeLevelLabelFor("qp_fitter", "fitter")).toBe("Fitter");
    expect(tradeLevelLabelFor("qp_fitter", "skilled")).toBe("Skilled");
    expect(tradeLevelLabelFor("qp_fitter", "senior_fitter")).toBe("Senior Fitter");
    expect(tradeLevelLabelFor("qp_fitter", "supervisor")).toBe("Supervisor");
    expect(tradeLevelLabelFor("qp_fitter", "boss")).toBeNull();
    // Track B #2 — the electrician rungs print the trade's words anywhere.
    expect(tradeLevelLabelFor("qp_industrial_electrician", "helper")).toBe("Helper");
    expect(tradeLevelLabelFor("qp_industrial_electrician", "electrician")).toBe("Electrician");
    expect(tradeLevelLabelFor("qp_industrial_electrician", "senior")).toBe("Senior");
    expect(tradeLevelLabelFor("qp_industrial_electrician", "supervisor")).toBe("Supervisor");
    expect(tradeLevelLabelFor("qp_industrial_electrician", "boss")).toBeNull();
    // Track B #3 — the welder rungs print the trade's words anywhere.
    expect(tradeLevelLabelFor("qp_welding_trade", "helper")).toBe("Helper");
    expect(tradeLevelLabelFor("qp_welding_trade", "welder")).toBe("Welder");
    expect(tradeLevelLabelFor("qp_welding_trade", "skilled")).toBe("Skilled");
    expect(tradeLevelLabelFor("qp_welding_trade", "certified_welder")).toBe("Skilled");
    expect(tradeLevelLabelFor("qp_welding_trade", "senior")).toBe("Senior");
    expect(tradeLevelLabelFor("qp_welding_trade", "supervisor")).toBe("Supervisor");
    expect(tradeLevelLabelFor("qp_welding_trade", "boss")).toBeNull();
    // Track B #4 — the conventional rungs print the trade's words anywhere.
    expect(tradeLevelLabelFor("qp_conventional_machining", "helper")).toBe("Helper");
    expect(tradeLevelLabelFor("qp_conventional_machining", "operator")).toBe("Operator");
    expect(tradeLevelLabelFor("qp_conventional_machining", "skilled")).toBe("Skilled");
    expect(tradeLevelLabelFor("qp_conventional_machining", "senior")).toBe("Senior");
    expect(tradeLevelLabelFor("qp_conventional_machining", "supervisor")).toBe("Supervisor");
    expect(tradeLevelLabelFor("qp_conventional_machining", "boss")).toBeNull();
    // Track B #5 — the sheet-metal rungs print the trade's words anywhere.
    expect(tradeLevelLabelFor("qp_sheet_metal_fab", "helper")).toBe("Helper");
    expect(tradeLevelLabelFor("qp_sheet_metal_fab", "operator")).toBe("Operator");
    expect(tradeLevelLabelFor("qp_sheet_metal_fab", "skilled")).toBe("Skilled");
    expect(tradeLevelLabelFor("qp_sheet_metal_fab", "senior")).toBe("Senior");
    expect(tradeLevelLabelFor("qp_sheet_metal_fab", "supervisor")).toBe("Supervisor");
    expect(tradeLevelLabelFor("qp_sheet_metal_fab", "boss")).toBeNull();
    // Track B #6 — the assembly rungs print the trade's words anywhere.
    expect(tradeLevelLabelFor("qp_assembly_line", "helper")).toBe("Helper");
    expect(tradeLevelLabelFor("qp_assembly_line", "operator")).toBe("Operator");
    expect(tradeLevelLabelFor("qp_assembly_line", "skilled")).toBe("Skilled");
    expect(tradeLevelLabelFor("qp_assembly_line", "senior")).toBe("Senior");
    expect(tradeLevelLabelFor("qp_assembly_line", "supervisor")).toBe("Supervisor");
    expect(tradeLevelLabelFor("qp_assembly_line", "boss")).toBeNull();
    // Track B #7 — the QC rungs print the trade's words anywhere.
    expect(tradeLevelLabelFor("qp_quality_inspection", "trainee")).toBe("Trainee");
    expect(tradeLevelLabelFor("qp_quality_inspection", "inspector")).toBe("Inspector");
    expect(tradeLevelLabelFor("qp_quality_inspection", "senior_inspector")).toBe("Senior Inspector");
    expect(tradeLevelLabelFor("qp_quality_inspection", "qc_engineer")).toBe("QC Engineer");
    expect(tradeLevelLabelFor("qp_quality_inspection", "supervisor")).toBe("Supervisor");
    expect(tradeLevelLabelFor("qp_quality_inspection", "boss")).toBeNull();
    // Phase 2 #1 — the tool-room rungs print the trade's words anywhere.
    // The stored `tool_maker` history key reads as the skilled rung.
    expect(tradeLevelLabelFor("qp_tool_die_making", "trainee")).toBe("Trainee");
    expect(tradeLevelLabelFor("qp_tool_die_making", "operator")).toBe("Operator");
    expect(tradeLevelLabelFor("qp_tool_die_making", "skilled")).toBe("Skilled");
    expect(tradeLevelLabelFor("qp_tool_die_making", "tool_maker")).toBe("Skilled");
    expect(tradeLevelLabelFor("qp_tool_die_making", "senior")).toBe("Senior");
    expect(tradeLevelLabelFor("qp_tool_die_making", "supervisor")).toBe("Supervisor");
    expect(tradeLevelLabelFor("qp_tool_die_making", "boss")).toBeNull();
  });

  it("emits the authored skill row for a pack's level answer, and nothing else", () => {
    // Turner setter: trade skill + confirmed.
    expect(
      tradeLevelEntriesForPackAnswers("qp_cnc_turning", [
        { attributeKey: "turning_level", value: "setter" },
      ]),
    ).toEqual([{ skillId: "mskill_cnc_turner", tradeLevel: "setter", levelConfirmed: true }]);
    // The pack's own option-key spelling lands canonically.
    expect(
      tradeLevelEntriesForPackAnswers("qp_cnc_turning", [
        { attributeKey: "turning_level", value: "setter_cum_programmer" },
      ]),
    ).toEqual([
      { skillId: "mskill_cnc_turner", tradeLevel: "setter_programmer", levelConfirmed: true },
    ]);
    // Helper writes the rung but does not confirm it.
    expect(
      tradeLevelEntriesForPackAnswers("qp_vmc_milling", [
        { attributeKey: "milling_level", value: "helper" },
      ]),
    ).toEqual([{ skillId: "mskill_vmc_operator", tradeLevel: "helper", levelConfirmed: false }]);
    // CAM junior: written, unconfirmed; senior: written, confirmed.
    expect(
      tradeLevelEntriesForPackAnswers("qp_cam_programming", [
        { attributeKey: "cam_level", value: "junior_programmer" },
      ]),
    ).toEqual([
      { skillId: "mskill_cam_programmer", tradeLevel: "junior_programmer", levelConfirmed: false },
    ]);
    // Unknown pack, unstated rung, unmapped spelling, wrong key: no row.
    expect(
      tradeLevelEntriesForPackAnswers("qp_welding", [
        { attributeKey: "welding_level", value: "setter" },
      ]),
    ).toEqual([]);
    expect(tradeLevelEntriesForPackAnswers("qp_cnc_turning", [])).toEqual([]);
    expect(
      tradeLevelEntriesForPackAnswers("qp_cnc_turning", [
        { attributeKey: "turning_level", value: "boss" },
      ]),
    ).toEqual([]);
    expect(
      tradeLevelEntriesForPackAnswers("qp_cnc_turning", [
        { attributeKey: "turning_machine", value: "setter" },
      ]),
    ).toEqual([]);
    expect(
      tradeLevelEntriesForPackAnswers(null, [{ attributeKey: "turning_level", value: "setter" }]),
    ).toEqual([]);
    // Versioned pack ids resolve to the same crosswalk.
    expect(
      tradeLevelEntriesForPackAnswers("qp_cnc_grinding@3", [
        { attributeKey: "grinding_level", value: "operator" },
      ]),
    ).toEqual([
      { skillId: "mskill_cnc_grinding_operator", tradeLevel: "operator", levelConfirmed: false },
    ]);
  });

  it("lets the separating-confirm answer override the rung rule (CEO Launch Pack v1, Track A #1)", () => {
    const turner = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_cnc_turning",
        confirm === null
          ? [{ attributeKey: "turning_level", value: level }]
          : [
              { attributeKey: "turning_level", value: level },
              confirm,
            ],
      );
    // No confirm answer: the rung rule stands (setter+ confirmed, operator not).
    expect(turner("setter", null)).toEqual([
      { skillId: "mskill_cnc_turner", tradeLevel: "setter", levelConfirmed: true },
    ]);
    expect(turner("operator", null)).toEqual([
      { skillId: "mskill_cnc_turner", tradeLevel: "operator", levelConfirmed: false },
    ]);
    // "Khud karta hoon" confirms; "koi aur" disconfirms — even against the rung rule.
    expect(turner("setter", { attributeKey: "setting_confirm", value: "self" })).toEqual([
      { skillId: "mskill_cnc_turner", tradeLevel: "setter", levelConfirmed: true },
    ]);
    expect(turner("setter", { attributeKey: "setting_confirm", value: "other" })).toEqual([
      { skillId: "mskill_cnc_turner", tradeLevel: "setter", levelConfirmed: false },
    ]);
    expect(
      turner("setter_programmer", { attributeKey: "program_edit_confirm", value: "other" }),
    ).toEqual([
      {
        skillId: "mskill_cnc_turner",
        tradeLevel: "setter_programmer",
        levelConfirmed: false,
      },
    ]);
    expect(turner("programmer", { attributeKey: "program_write_confirm", value: "self" })).toEqual(
      [{ skillId: "mskill_cnc_turner", tradeLevel: "programmer", levelConfirmed: true }],
    );
    // A confirm answer for ANOTHER rung is not the worker's answer about his own —
    // the rung rule stands.
    expect(turner("setter", { attributeKey: "program_write_confirm", value: "self" })).toEqual([
      { skillId: "mskill_cnc_turner", tradeLevel: "setter", levelConfirmed: true },
    ]);
    // The supervisor's free-text team count is an engagement, hence a confirm.
    expect(turner("supervisor", { attributeKey: "team_confirm", value: "5 machine, 8 log" })).toEqual(
      [{ skillId: "mskill_cnc_turner", tradeLevel: "supervisor", levelConfirmed: true }],
    );
    // A rung with no confirm item (operator) ignores stray confirm answers.
    expect(turner("operator", { attributeKey: "setting_confirm", value: "self" })).toEqual([
      { skillId: "mskill_cnc_turner", tradeLevel: "operator", levelConfirmed: false },
    ]);
  });

  it("wires the VMC/HMC confirms the same way (CEO Launch Pack v1, Track A #2)", () => {
    const vmc = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_vmc_milling",
        confirm === null
          ? [{ attributeKey: "milling_level", value: level }]
          : [{ attributeKey: "milling_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands.
    expect(vmc("setter", null)).toEqual([
      { skillId: "mskill_vmc_operator", tradeLevel: "setter", levelConfirmed: true },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(vmc("setter", { attributeKey: "milling_setting_confirm", value: "self" })).toEqual([
      { skillId: "mskill_vmc_operator", tradeLevel: "setter", levelConfirmed: true },
    ]);
    expect(vmc("setter", { attributeKey: "milling_setting_confirm", value: "other" })).toEqual(
      [{ skillId: "mskill_vmc_operator", tradeLevel: "setter", levelConfirmed: false }],
    );
    expect(
      vmc("programmer", { attributeKey: "milling_program_write_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_vmc_operator", tradeLevel: "programmer", levelConfirmed: true },
    ]);
    expect(
      vmc("supervisor", { attributeKey: "milling_team_confirm", value: "4 machine, 6 log" }),
    ).toEqual([
      { skillId: "mskill_vmc_operator", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("wires the CAM confirms the same way (CEO Launch Pack v1, Track A #3)", () => {
    const cam = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_cam_programming",
        confirm === null
          ? [{ attributeKey: "cam_level", value: level }]
          : [{ attributeKey: "cam_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (programmer+ confirmed, trainee not).
    expect(cam("programmer", null)).toEqual([
      { skillId: "mskill_cam_programmer", tradeLevel: "programmer", levelConfirmed: true },
    ]);
    expect(cam("trainee", null)).toEqual([
      { skillId: "mskill_cam_programmer", tradeLevel: "trainee", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(cam("programmer", { attributeKey: "cam_program_confirm", value: "self" })).toEqual([
      { skillId: "mskill_cam_programmer", tradeLevel: "programmer", levelConfirmed: true },
    ]);
    expect(cam("senior", { attributeKey: "cam_senior_confirm", value: "other" })).toEqual([
      { skillId: "mskill_cam_programmer", tradeLevel: "senior", levelConfirmed: false },
    ]);
    expect(cam("lead", { attributeKey: "cam_lead_confirm", value: "self" })).toEqual([
      { skillId: "mskill_cam_programmer", tradeLevel: "lead", levelConfirmed: true },
    ]);
    expect(cam("supervisor", { attributeKey: "cam_team_confirm", value: "6 machine, 4 log" })).toEqual(
      [{ skillId: "mskill_cam_programmer", tradeLevel: "supervisor", levelConfirmed: true }],
    );
  });

  it("wires the 3D design confirms the same way (CEO Launch Plan Pack v1, Track A #4)", () => {
    const design3d = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_cad_design_3d",
        confirm === null
          ? [{ attributeKey: "design_level", value: level }]
          : [{ attributeKey: "design_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (senior_designer+ confirmed, below not).
    expect(design3d("senior_designer", null)).toEqual([
      {
        skillId: "mskill_cad_designer_3d",
        tradeLevel: "senior_designer",
        levelConfirmed: true,
      },
    ]);
    expect(design3d("designer", null)).toEqual([
      { skillId: "mskill_cad_designer_3d", tradeLevel: "designer", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(
      design3d("senior_designer", { attributeKey: "design_senior_confirm", value: "self" }),
    ).toEqual([
      {
        skillId: "mskill_cad_designer_3d",
        tradeLevel: "senior_designer",
        levelConfirmed: true,
      },
    ]);
    expect(
      design3d("senior_designer", { attributeKey: "design_senior_confirm", value: "other" }),
    ).toEqual([
      {
        skillId: "mskill_cad_designer_3d",
        tradeLevel: "senior_designer",
        levelConfirmed: false,
      },
    ]);
    expect(design3d("lead", { attributeKey: "design_lead_confirm", value: "self" })).toEqual([
      { skillId: "mskill_cad_designer_3d", tradeLevel: "lead", levelConfirmed: true },
    ]);
    expect(
      design3d("supervisor", { attributeKey: "design_team_confirm", value: "4 designer" }),
    ).toEqual([
      { skillId: "mskill_cad_designer_3d", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("wires the 2D draughtsman confirms the same way (CEO Launch Plan Pack v1, Track A #5)", () => {
    const drafting = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_cad_drafting",
        confirm === null
          ? [{ attributeKey: "cad_level", value: level }]
          : [{ attributeKey: "cad_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (senior_designer+ confirmed, below not).
    expect(drafting("senior_designer", null)).toEqual([
      { skillId: "mskill_designer", tradeLevel: "senior_designer", levelConfirmed: true },
    ]);
    expect(drafting("designer", null)).toEqual([
      { skillId: "mskill_designer", tradeLevel: "designer", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(
      drafting("senior_designer", { attributeKey: "cad_senior_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_designer", tradeLevel: "senior_designer", levelConfirmed: true },
    ]);
    expect(
      drafting("senior_designer", { attributeKey: "cad_senior_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_designer", tradeLevel: "senior_designer", levelConfirmed: false },
    ]);
    expect(drafting("lead", { attributeKey: "cad_lead_confirm", value: "self" })).toEqual([
      { skillId: "mskill_designer", tradeLevel: "lead", levelConfirmed: true },
    ]);
    expect(
      drafting("supervisor", { attributeKey: "cad_team_confirm", value: "3 designer" }),
    ).toEqual([{ skillId: "mskill_designer", tradeLevel: "supervisor", levelConfirmed: true }]);
  });

  it("wires the fitter confirms the same way (CEO Launch Plan Pack v1, Track B #1)", () => {
    const fitting = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_fitter",
        confirm === null
          ? [{ attributeKey: "fitter_level", value: level }]
          : [{ attributeKey: "fitter_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (skilled+ confirmed, below not).
    expect(fitting("skilled", null)).toEqual([
      { skillId: "mskill_fitter", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(fitting("senior_fitter", null)).toEqual([
      { skillId: "mskill_fitter", tradeLevel: "senior_fitter", levelConfirmed: true },
    ]);
    expect(fitting("fitter", null)).toEqual([
      { skillId: "mskill_fitter", tradeLevel: "fitter", levelConfirmed: false },
    ]);
    expect(fitting("helper", null)).toEqual([
      { skillId: "mskill_fitter", tradeLevel: "helper", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(
      fitting("skilled", { attributeKey: "fitter_skilled_confirm", value: "self" }),
    ).toEqual([{ skillId: "mskill_fitter", tradeLevel: "skilled", levelConfirmed: true }]);
    expect(
      fitting("skilled", { attributeKey: "fitter_skilled_confirm", value: "other" }),
    ).toEqual([{ skillId: "mskill_fitter", tradeLevel: "skilled", levelConfirmed: false }]);
    // The senior's team count is a text engagement, not a chip — confirmed.
    expect(
      fitting("senior_fitter", { attributeKey: "fitter_team_confirm", value: "5 fitter" }),
    ).toEqual([
      { skillId: "mskill_fitter", tradeLevel: "senior_fitter", levelConfirmed: true },
    ]);
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(fitting("supervisor", null)).toEqual([
      { skillId: "mskill_fitter", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("wires the electrician confirm the same way (CEO Launch Plan Pack v1, Track B #2)", () => {
    const sparking = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_industrial_electrician",
        confirm === null
          ? [{ attributeKey: "electrician_level", value: level }]
          : [{ attributeKey: "electrician_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (senior+ confirmed, below not).
    expect(sparking("senior", null)).toEqual([
      { skillId: "mskill_industrial_electrician", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(sparking("electrician", null)).toEqual([
      { skillId: "mskill_industrial_electrician", tradeLevel: "electrician", levelConfirmed: false },
    ]);
    expect(sparking("helper", null)).toEqual([
      { skillId: "mskill_industrial_electrician", tradeLevel: "helper", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms.
    expect(
      sparking("senior", { attributeKey: "electrician_senior_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_industrial_electrician", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(
      sparking("senior", { attributeKey: "electrician_senior_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_industrial_electrician", tradeLevel: "senior", levelConfirmed: false },
    ]);
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(sparking("supervisor", null)).toEqual([
      { skillId: "mskill_industrial_electrician", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("wires the welder confirms the same way (CEO Launch Plan Pack v1, Track B #3)", () => {
    const welding = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_welding_trade",
        confirm === null
          ? [{ attributeKey: "welder_level", value: level }]
          : [{ attributeKey: "welder_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (skilled+ confirmed, below not).
    // The @1 `certified_welder` key aliases to skilled.
    expect(welding("skilled", null)).toEqual([
      { skillId: "mskill_welder", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(welding("certified_welder", null)).toEqual([
      { skillId: "mskill_welder", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(welding("senior", null)).toEqual([
      { skillId: "mskill_welder", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(welding("welder", null)).toEqual([
      { skillId: "mskill_welder", tradeLevel: "welder", levelConfirmed: false },
    ]);
    expect(welding("helper", null)).toEqual([
      { skillId: "mskill_welder", tradeLevel: "helper", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(
      welding("skilled", { attributeKey: "welder_skilled_confirm", value: "self" }),
    ).toEqual([{ skillId: "mskill_welder", tradeLevel: "skilled", levelConfirmed: true }]);
    expect(
      welding("skilled", { attributeKey: "welder_skilled_confirm", value: "other" }),
    ).toEqual([{ skillId: "mskill_welder", tradeLevel: "skilled", levelConfirmed: false }]);
    expect(
      welding("senior", { attributeKey: "welder_senior_confirm", value: "self" }),
    ).toEqual([{ skillId: "mskill_welder", tradeLevel: "senior", levelConfirmed: true }]);
    expect(
      welding("senior", { attributeKey: "welder_senior_confirm", value: "other" }),
    ).toEqual([{ skillId: "mskill_welder", tradeLevel: "senior", levelConfirmed: false }]);
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(welding("supervisor", null)).toEqual([
      { skillId: "mskill_welder", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("wires the conventional confirms the same way (CEO Launch Plan Pack v1, Track B #4)", () => {
    const manual = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_conventional_machining",
        confirm === null
          ? [{ attributeKey: "machining_level", value: level }]
          : [{ attributeKey: "machining_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (skilled+ confirmed, below not).
    expect(manual("skilled", null)).toEqual([
      { skillId: "mskill_conventional_machinist", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(manual("senior", null)).toEqual([
      { skillId: "mskill_conventional_machinist", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(manual("operator", null)).toEqual([
      { skillId: "mskill_conventional_machinist", tradeLevel: "operator", levelConfirmed: false },
    ]);
    expect(manual("helper", null)).toEqual([
      { skillId: "mskill_conventional_machinist", tradeLevel: "helper", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(
      manual("skilled", { attributeKey: "machining_skilled_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_conventional_machinist", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(
      manual("skilled", { attributeKey: "machining_skilled_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_conventional_machinist", tradeLevel: "skilled", levelConfirmed: false },
    ]);
    expect(
      manual("senior", { attributeKey: "machining_senior_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_conventional_machinist", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(
      manual("senior", { attributeKey: "machining_senior_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_conventional_machinist", tradeLevel: "senior", levelConfirmed: false },
    ]);
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(manual("supervisor", null)).toEqual([
      { skillId: "mskill_conventional_machinist", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("wires the sheet-metal confirms the same way (CEO Launch Plan Pack v1, Track B #5)", () => {
    const sheeting = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_sheet_metal_fab",
        confirm === null
          ? [{ attributeKey: "sheet_metal_level", value: level }]
          : [{ attributeKey: "sheet_metal_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (skilled+ confirmed, below not).
    expect(sheeting("skilled", null)).toEqual([
      { skillId: "mskill_sheet_metal_worker", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(sheeting("senior", null)).toEqual([
      { skillId: "mskill_sheet_metal_worker", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(sheeting("operator", null)).toEqual([
      { skillId: "mskill_sheet_metal_worker", tradeLevel: "operator", levelConfirmed: false },
    ]);
    expect(sheeting("helper", null)).toEqual([
      { skillId: "mskill_sheet_metal_worker", tradeLevel: "helper", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(
      sheeting("skilled", { attributeKey: "sheet_skilled_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_sheet_metal_worker", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(
      sheeting("skilled", { attributeKey: "sheet_skilled_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_sheet_metal_worker", tradeLevel: "skilled", levelConfirmed: false },
    ]);
    expect(sheeting("senior", { attributeKey: "sheet_senior_confirm", value: "self" })).toEqual([
      { skillId: "mskill_sheet_metal_worker", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(sheeting("senior", { attributeKey: "sheet_senior_confirm", value: "other" })).toEqual([
      { skillId: "mskill_sheet_metal_worker", tradeLevel: "senior", levelConfirmed: false },
    ]);
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(sheeting("supervisor", null)).toEqual([
      { skillId: "mskill_sheet_metal_worker", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("wires the assembly confirms the same way (CEO Launch Plan Pack v1, Track B #6)", () => {
    const lining = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_assembly_line",
        confirm === null
          ? [{ attributeKey: "assembly_level", value: level }]
          : [{ attributeKey: "assembly_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (skilled+ confirmed, below not).
    expect(lining("skilled", null)).toEqual([
      { skillId: "mskill_assembly_line_worker", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(lining("senior", null)).toEqual([
      { skillId: "mskill_assembly_line_worker", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(lining("operator", null)).toEqual([
      { skillId: "mskill_assembly_line_worker", tradeLevel: "operator", levelConfirmed: false },
    ]);
    expect(lining("helper", null)).toEqual([
      { skillId: "mskill_assembly_line_worker", tradeLevel: "helper", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(
      lining("skilled", { attributeKey: "assembly_skilled_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_assembly_line_worker", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(
      lining("skilled", { attributeKey: "assembly_skilled_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_assembly_line_worker", tradeLevel: "skilled", levelConfirmed: false },
    ]);
    // The senior's team count is a text engagement, not a chip — confirmed.
    expect(lining("senior", { attributeKey: "assembly_team_confirm", value: "12 log" })).toEqual([
      { skillId: "mskill_assembly_line_worker", tradeLevel: "senior", levelConfirmed: true },
    ]);
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(lining("supervisor", null)).toEqual([
      { skillId: "mskill_assembly_line_worker", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("wires the QC confirms the same way (CEO Launch Plan Pack v1, Track B #7)", () => {
    const checking = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_quality_inspection",
        confirm === null
          ? [{ attributeKey: "inspection_level", value: level }]
          : [{ attributeKey: "inspection_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (senior_inspector+ confirmed, below not).
    expect(checking("senior_inspector", null)).toEqual([
      { skillId: "mskill_quality_inspector", tradeLevel: "senior_inspector", levelConfirmed: true },
    ]);
    expect(checking("qc_engineer", null)).toEqual([
      { skillId: "mskill_quality_inspector", tradeLevel: "qc_engineer", levelConfirmed: true },
    ]);
    expect(checking("inspector", null)).toEqual([
      { skillId: "mskill_quality_inspector", tradeLevel: "inspector", levelConfirmed: false },
    ]);
    expect(checking("trainee", null)).toEqual([
      { skillId: "mskill_quality_inspector", tradeLevel: "trainee", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(
      checking("senior_inspector", { attributeKey: "inspection_senior_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_quality_inspector", tradeLevel: "senior_inspector", levelConfirmed: true },
    ]);
    expect(
      checking("senior_inspector", { attributeKey: "inspection_senior_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_quality_inspector", tradeLevel: "senior_inspector", levelConfirmed: false },
    ]);
    expect(
      checking("qc_engineer", { attributeKey: "inspection_engineer_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_quality_inspector", tradeLevel: "qc_engineer", levelConfirmed: true },
    ]);
    expect(
      checking("qc_engineer", { attributeKey: "inspection_engineer_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_quality_inspector", tradeLevel: "qc_engineer", levelConfirmed: false },
    ]);
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(checking("supervisor", null)).toEqual([
      { skillId: "mskill_quality_inspector", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("wires the tool-room confirms the same way (CEO Launch Plan Pack v1, Phase 2 #1)", () => {
    const tooling = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_tool_die_making",
        confirm === null
          ? [{ attributeKey: "toolroom_level", value: level }]
          : [{ attributeKey: "toolroom_level", value: level }, confirm],
      );
    // No confirm answer: the rung rule stands (skilled+ confirmed, below not).
    // The @1 `tool_maker` key aliases to skilled.
    expect(tooling("skilled", null)).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(tooling("tool_maker", null)).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(tooling("senior", null)).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(tooling("operator", null)).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "operator", levelConfirmed: false },
    ]);
    expect(tooling("trainee", null)).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "trainee", levelConfirmed: false },
    ]);
    // Self confirms, other disconfirms — per rung.
    expect(
      tooling("skilled", { attributeKey: "toolroom_skilled_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "skilled", levelConfirmed: true },
    ]);
    expect(
      tooling("skilled", { attributeKey: "toolroom_skilled_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "skilled", levelConfirmed: false },
    ]);
    expect(
      tooling("senior", { attributeKey: "toolroom_senior_confirm", value: "self" }),
    ).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "senior", levelConfirmed: true },
    ]);
    expect(
      tooling("senior", { attributeKey: "toolroom_senior_confirm", value: "other" }),
    ).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "senior", levelConfirmed: false },
    ]);
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(tooling("supervisor", null)).toEqual([
      { skillId: "mskill_tool_die_maker", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("asks the one grinding confirm of both setter rungs (CEO Launch Plan Pack v1, Phase 2 #2)", () => {
    const grinding = (
      level: string,
      confirm: { attributeKey: string; value: unknown } | null,
    ) =>
      tradeLevelEntriesForPackAnswers(
        "qp_cnc_grinding@6",
        confirm === null
          ? [{ attributeKey: "grinding_level", value: level }]
          : [{ attributeKey: "grinding_level", value: level }, confirm],
      );
    const asked = (value: string) => ({ attributeKey: "grinding_setting_confirm", value });
    // No confirm answer: the rung rule stands (setter+ confirmed, below not).
    // @6 stores `trainee` for the first chip; @5's `helper` still renders.
    expect(grinding("trainee", null)).toEqual([
      { skillId: "mskill_cnc_grinding_operator", tradeLevel: "trainee", levelConfirmed: false },
    ]);
    expect(grinding("helper", null)).toEqual([
      { skillId: "mskill_cnc_grinding_operator", tradeLevel: "helper", levelConfirmed: false },
    ]);
    expect(grinding("operator", null)).toEqual([
      { skillId: "mskill_cnc_grinding_operator", tradeLevel: "operator", levelConfirmed: false },
    ]);
    expect(grinding("setter", null)).toEqual([
      { skillId: "mskill_cnc_grinding_operator", tradeLevel: "setter", levelConfirmed: true },
    ]);
    // The same question settles both setter rungs: self confirms, other disconfirms.
    expect(grinding("setter", asked("self"))).toEqual([
      { skillId: "mskill_cnc_grinding_operator", tradeLevel: "setter", levelConfirmed: true },
    ]);
    expect(grinding("setter", asked("other"))).toEqual([
      { skillId: "mskill_cnc_grinding_operator", tradeLevel: "setter", levelConfirmed: false },
    ]);
    expect(grinding("setter_programmer", asked("self"))).toEqual([
      {
        skillId: "mskill_cnc_grinding_operator",
        tradeLevel: "setter_programmer",
        levelConfirmed: true,
      },
    ]);
    expect(grinding("setter_cum_programmer", asked("other"))).toEqual([
      {
        skillId: "mskill_cnc_grinding_operator",
        tradeLevel: "setter_programmer",
        levelConfirmed: false,
      },
    ]);
    // Supervisor: no confirm item, rung rule (confirmed). A stray confirm
    // answer never reaches a rung it was not asked about.
    expect(grinding("supervisor", asked("other"))).toEqual([
      { skillId: "mskill_cnc_grinding_operator", tradeLevel: "supervisor", levelConfirmed: true },
    ]);
  });

  it("asks the one press confirm of setter and senior (CEO Launch Plan Pack v1, Phase 2 #3)", () => {
    const press = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_press_operation@2",
        confirm === null
          ? [{ attributeKey: "press_level", value: level }]
          : [{ attributeKey: "press_level", value: level }, confirm],
      );
    const asked = (value: string) => ({ attributeKey: "press_setting_confirm", value });
    const row = (tradeLevel: string, levelConfirmed: boolean) => [
      { skillId: "mskill_press_operator", tradeLevel, levelConfirmed },
    ];
    // The pack is new to the crosswalk: @1 answers (helper/operator/setter)
    // now earn a row, by the rung rule — setter+ confirmed, below not.
    expect(press("helper", null)).toEqual(row("helper", false));
    expect(press("trainee", null)).toEqual(row("trainee", false));
    expect(press("operator", null)).toEqual(row("operator", false));
    expect(press("setter", null)).toEqual(row("setter", true));
    expect(press("senior", null)).toEqual(row("senior", true));
    // The one question settles both rungs: self confirms, other disconfirms.
    expect(press("setter", asked("self"))).toEqual(row("setter", true));
    expect(press("setter", asked("other"))).toEqual(row("setter", false));
    expect(press("senior", asked("self"))).toEqual(row("senior", true));
    expect(press("senior", asked("other"))).toEqual(row("senior", false));
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(press("supervisor", asked("other"))).toEqual(row("supervisor", true));
    // The shared crosswalk labels print the sheet's words.
    expect(tradeLevelLabelFor("qp_press_operation", "senior")).toBe("Senior");
    expect(tradeLevelLabelFor("qp_press_operation", "trainee")).toBe("Trainee");
  });

  it("asks the one coating confirm of skilled and senior (CEO Launch Plan Pack v1, Phase 2 #4)", () => {
    const coat = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_powder_coating@2",
        confirm === null
          ? [{ attributeKey: "coating_level", value: level }]
          : [{ attributeKey: "coating_level", value: level }, confirm],
      );
    const asked = (value: string) => ({ attributeKey: "coating_skilled_confirm", value });
    const row = (tradeLevel: string, levelConfirmed: boolean) => [
      { skillId: "mskill_painter_coater", tradeLevel, levelConfirmed },
    ];
    // New to the crosswalk: @1 answers (helper/operator/skilled) now earn a row
    // by the rung rule — skilled+ confirmed, below not.
    expect(coat("helper", null)).toEqual(row("helper", false));
    expect(coat("trainee", null)).toEqual(row("trainee", false));
    expect(coat("operator", null)).toEqual(row("operator", false));
    expect(coat("skilled", null)).toEqual(row("skilled", true));
    expect(coat("senior", null)).toEqual(row("senior", true));
    // The one question settles both rungs.
    expect(coat("skilled", asked("self"))).toEqual(row("skilled", true));
    expect(coat("skilled", asked("other"))).toEqual(row("skilled", false));
    expect(coat("senior", asked("self"))).toEqual(row("senior", true));
    expect(coat("senior", asked("other"))).toEqual(row("senior", false));
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(coat("supervisor", asked("other"))).toEqual(row("supervisor", true));
  });

  it("asks the maintenance confirm of senior technicians only (CEO Launch Plan Pack v1, Phase 2 #5)", () => {
    const maint = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_maintenance_tech@2",
        confirm === null
          ? [{ attributeKey: "maintenance_level", value: level }]
          : [{ attributeKey: "maintenance_level", value: level }, confirm],
      );
    const asked = (value: string) => ({ attributeKey: "maintenance_senior_confirm", value });
    const row = (tradeLevel: string, levelConfirmed: boolean) => [
      { skillId: "mskill_maintenance_technician", tradeLevel, levelConfirmed },
    ];
    // New to the crosswalk: @1 answers (helper/technician/senior_technician)
    // now earn a row by the rung rule — senior technician+ confirmed.
    expect(maint("helper", null)).toEqual(row("helper", false));
    expect(maint("trainee", null)).toEqual(row("trainee", false));
    expect(maint("technician", null)).toEqual(row("technician", false));
    expect(maint("senior_technician", null)).toEqual(row("senior_technician", true));
    expect(maint("senior_technician", asked("self"))).toEqual(row("senior_technician", true));
    expect(maint("senior_technician", asked("other"))).toEqual(row("senior_technician", false));
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(maint("supervisor", asked("other"))).toEqual(row("supervisor", true));
    expect(tradeLevelLabelFor("qp_maintenance_tech", "senior_technician")).toBe("Senior Technician");
  });

  it("wires the two PLC confirms, the senior one shared with lead (CEO Launch Plan Pack v1, Phase 2 #6)", () => {
    const plc = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_plc_automation@1",
        confirm === null
          ? [{ attributeKey: "plc_level", value: level }]
          : [{ attributeKey: "plc_level", value: level }, confirm],
      );
    const tech = (value: string) => ({ attributeKey: "plc_technician_confirm", value });
    const senior = (value: string) => ({ attributeKey: "plc_senior_confirm", value });
    const row = (tradeLevel: string, levelConfirmed: boolean) => [
      { skillId: "mskill_plc_automation_tech", tradeLevel, levelConfirmed },
    ];
    // The technician key is shared and NOT a confirmed rung (maintenance/electrician
    // sheets rule it Lower): unanswered it stays unconfirmed; its own confirm confirms it.
    expect(plc("trainee", null)).toEqual(row("trainee", false));
    expect(plc("technician", null)).toEqual(row("technician", false));
    expect(plc("technician", tech("self"))).toEqual(row("technician", true));
    expect(plc("technician", tech("other"))).toEqual(row("technician", false));
    // Senior technician and lead share the sheet's senior question.
    expect(plc("senior_technician", null)).toEqual(row("senior_technician", true));
    expect(plc("senior_technician", senior("other"))).toEqual(row("senior_technician", false));
    expect(plc("lead", senior("self"))).toEqual(row("lead", true));
    expect(plc("lead", senior("other"))).toEqual(row("lead", false));
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(plc("supervisor", senior("other"))).toEqual(row("supervisor", true));
  });

  it("wires the two EDM confirms, one per rung (CEO Launch Plan Pack v1, Phase 2 #7)", () => {
    const edm = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_edm_wirecut@1",
        confirm === null
          ? [{ attributeKey: "edm_level", value: level }]
          : [{ attributeKey: "edm_level", value: level }, confirm],
      );
    const setting = (value: string) => ({ attributeKey: "edm_setting_confirm", value });
    const program = (value: string) => ({ attributeKey: "edm_program_confirm", value });
    const row = (tradeLevel: string, levelConfirmed: boolean) => [
      { skillId: "mskill_edm_wirecut_operator", tradeLevel, levelConfirmed },
    ];
    expect(edm("trainee", null)).toEqual(row("trainee", false));
    expect(edm("operator", null)).toEqual(row("operator", false));
    expect(edm("setter", null)).toEqual(row("setter", true));
    expect(edm("setter", setting("other"))).toEqual(row("setter", false));
    expect(edm("setter_programmer", program("self"))).toEqual(row("setter_programmer", true));
    expect(edm("setter_cum_programmer", program("other"))).toEqual(row("setter_programmer", false));
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(edm("supervisor", setting("other"))).toEqual(row("supervisor", true));
  });

  it("asks the one heat-treatment confirm of skilled AND senior (CEO Launch Plan Pack v1, Phase 2 #8)", () => {
    const heat = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_heat_treatment@1",
        confirm === null
          ? [{ attributeKey: "heat_level", value: level }]
          : [{ attributeKey: "heat_level", value: level }, confirm],
      );
    const skilled = (value: string) => ({ attributeKey: "heat_skilled_confirm", value });
    const row = (tradeLevel: string, levelConfirmed: boolean) => [
      { skillId: "mskill_heat_treatment_tech", tradeLevel, levelConfirmed },
    ];
    expect(heat("trainee", null)).toEqual(row("trainee", false));
    expect(heat("operator", null)).toEqual(row("operator", false));
    expect(heat("skilled", null)).toEqual(row("skilled", true));
    expect(heat("skilled", skilled("other"))).toEqual(row("skilled", false));
    expect(heat("senior", skilled("self"))).toEqual(row("senior", true));
    expect(heat("senior", skilled("other"))).toEqual(row("senior", false));
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(heat("supervisor", skilled("other"))).toEqual(row("supervisor", true));
  });

  it("asks the one foundry / forging confirm of skilled AND senior (CEO Launch Plan Pack v1, Phase 2 #11)", () => {
    const foundry = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_foundry_forging@1",
        confirm === null
          ? [{ attributeKey: "foundry_level", value: level }]
          : [{ attributeKey: "foundry_level", value: level }, confirm],
      );
    const skilled = (value: string) => ({ attributeKey: "foundry_skilled_confirm", value });
    const row = (tradeLevel: string, levelConfirmed: boolean) => [
      { skillId: "mskill_foundry_forging_operator", tradeLevel, levelConfirmed },
    ];
    expect(foundry("trainee", null)).toEqual(row("trainee", false));
    expect(foundry("operator", null)).toEqual(row("operator", false));
    expect(foundry("skilled", null)).toEqual(row("skilled", true));
    expect(foundry("skilled", skilled("other"))).toEqual(row("skilled", false));
    expect(foundry("senior", skilled("self"))).toEqual(row("senior", true));
    expect(foundry("senior", skilled("other"))).toEqual(row("senior", false));
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(foundry("supervisor", skilled("other"))).toEqual(row("supervisor", true));
  });

  it("wires the two injection-moulding confirms, one per rung (CEO Launch Plan Pack v1, Phase 2 #9)", () => {
    const imm = (level: string, confirm: { attributeKey: string; value: unknown } | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_injection_moulding@1",
        confirm === null
          ? [{ attributeKey: "moulding_level", value: level }]
          : [{ attributeKey: "moulding_level", value: level }, confirm],
      );
    const setting = (value: string) => ({ attributeKey: "moulding_setting_confirm", value });
    const senior = (value: string) => ({ attributeKey: "moulding_senior_confirm", value });
    const row = (tradeLevel: string, levelConfirmed: boolean) => [
      { skillId: "mskill_imm_operator", tradeLevel, levelConfirmed },
    ];
    expect(imm("trainee", null)).toEqual(row("trainee", false));
    expect(imm("operator", null)).toEqual(row("operator", false));
    expect(imm("setter", null)).toEqual(row("setter", true));
    expect(imm("setter", setting("self"))).toEqual(row("setter", true));
    expect(imm("setter", setting("other"))).toEqual(row("setter", false));
    expect(imm("senior", senior("self"))).toEqual(row("senior", true));
    expect(imm("senior", senior("other"))).toEqual(row("senior", false));
    // Supervisor: no confirm item, rung rule (confirmed).
    expect(imm("supervisor", senior("other"))).toEqual(row("supervisor", true));
  });

  it("confirms the production supervisor FROM supervisor, Line Leader unconfirmed (CEO Launch Plan Pack v1, Phase 2 #10)", () => {
    const ps = (level: string, confirm: string | null) =>
      tradeLevelEntriesForPackAnswers(
        "qp_production_supervisor@1",
        confirm === null
          ? [{ attributeKey: "supervision_level", value: level }]
          : [
              { attributeKey: "supervision_level", value: level },
              { attributeKey: "supervision_report_confirm", value: confirm },
            ],
      );
    const row = (tradeLevel: string, levelConfirmed: boolean) => [
      { skillId: "mskill_production_supervisor", tradeLevel, levelConfirmed },
    ];
    // Line Leader is `senior`, which confirms in every other trade — not on this sheet.
    expect(ps("senior", null)).toEqual(row("senior", false));
    expect(ps("supervisor", null)).toEqual(row("supervisor", true));
    expect(ps("supervisor", "self")).toEqual(row("supervisor", true));
    expect(ps("supervisor", "other")).toEqual(row("supervisor", false));
    // Production in-charge shares the shift-report confirm (standing owner rule).
    expect(ps("lead", "self")).toEqual(row("lead", true));
    expect(ps("lead", "other")).toEqual(row("lead", false));
    // The override is per pack: `senior` still confirms on the injection-moulding sheet.
    expect(
      tradeLevelEntriesForPackAnswers("qp_injection_moulding@1", [
        { attributeKey: "moulding_level", value: "senior" },
      ]),
    ).toEqual([{ skillId: "mskill_imm_operator", tradeLevel: "senior", levelConfirmed: true }]);
    // The headline prints the sheet's own chips; every rung prices Higher.
    expect(tradeLevelLabelFor("qp_production_supervisor", "senior")).toBe("Line Leader");
    expect(tradeLevelLabelFor("qp_production_supervisor", "lead")).toBe("Production In-charge");
    for (const rung of ["senior", "supervisor", "lead"] as const) {
      expect(priceTierForTradeLevel(rung), rung).toBe("higher");
    }
  });

  it("prints the 2D trade's own rung words (CEO Launch Plan Pack v1, Track A #5)", () => {
    // Shared crosswalk everywhere else; the draughtsman's sheet headlines his own ladder.
    expect(tradeLevelLabelFor("qp_cad_drafting", "trainee")).toBe("Trainee");
    expect(tradeLevelLabelFor("qp_cad_drafting", "designer")).toBe("Draughtsman");
    expect(tradeLevelLabelFor("qp_cad_drafting", "senior_designer")).toBe("Senior Draughtsman");
    expect(tradeLevelLabelFor("qp_cad_drafting", "lead")).toBe("Lead");
    expect(tradeLevelLabelFor("qp_cad_drafting", "supervisor")).toBe("Head");
    expect(tradeLevelLabelFor("qp_cad_drafting", "boss")).toBeNull();
    // Other trades keep the shared labels.
    expect(tradeLevelLabelFor("qp_cnc_turning", "setter")).toBe("Setter");
    expect(tradeLevelLabelFor("qp_cam_programming", "senior")).toBe("Senior");
  });
});
