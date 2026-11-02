import { describe, expect, it } from "vitest";

import {
  isLevelConfirmed,
  normalizeTradeLevelKey,
  priceTierForLevels,
  priceTierForTradeLevel,
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
  it("covers the four v1 trades plus the 3D trade, each with its skill and level key", () => {
    expect(TRADE_LEVEL_PACKS).toEqual({
      qp_cnc_turning: { skillId: "mskill_cnc_turner", levelKey: "turning_level" },
      qp_vmc_milling: { skillId: "mskill_vmc_operator", levelKey: "milling_level" },
      qp_cnc_grinding: { skillId: "mskill_cnc_grinding_operator", levelKey: "grinding_level" },
      qp_cam_programming: { skillId: "mskill_cam_programmer", levelKey: "cam_level" },
      qp_cad_design_3d: { skillId: "mskill_cad_designer_3d", levelKey: "design_level" },
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
    ] as const) {
      expect(priceTierForTradeLevel(rung), rung).toBe("higher");
    }
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
});
