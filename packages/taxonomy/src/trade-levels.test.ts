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
  it("covers the four v1 trades, each with its skill and level key", () => {
    expect(TRADE_LEVEL_PACKS).toEqual({
      qp_cnc_turning: { skillId: "mskill_cnc_turner", levelKey: "turning_level" },
      qp_vmc_milling: { skillId: "mskill_vmc_operator", levelKey: "milling_level" },
      qp_cnc_grinding: { skillId: "mskill_cnc_grinding_operator", levelKey: "grinding_level" },
      qp_cam_programming: { skillId: "mskill_cam_programmer", levelKey: "cam_level" },
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
  });

  it("returns null instead of guessing", () => {
    expect(normalizeTradeLevelKey("")).toBeNull();
    expect(normalizeTradeLevelKey("boss")).toBeNull();
    expect(normalizeTradeLevelKey(null)).toBeNull();
    expect(normalizeTradeLevelKey(42)).toBeNull();
  });

  it("confirms Setter and above only, per ladder", () => {
    for (const rung of ["helper", "trainee", "operator", "junior_programmer"] as const) {
      expect(isLevelConfirmed(rung), rung).toBe(false);
    }
    for (
      const rung of [
        "setter",
        "setter_programmer",
        "programmer",
        "senior_programmer",
        "supervisor",
        "senior_draughtsman",
        "senior_designer",
        "lead_checker",
        "design_engineer_lead",
      ] as const
    ) {
      expect(isLevelConfirmed(rung), rung).toBe(true);
    }
    expect(isLevelConfirmed(null)).toBe(false);
  });

  it("prices null and the floor Lower, Setter and above Higher", () => {
    expect(priceTierForTradeLevel(null)).toBe("lower");
    for (
      const rung of [
        "helper",
        "operator",
        "trainee",
        "draughtsman",
        "trainee_modeller",
        "cad_designer",
        "junior_programmer",
      ] as const
    ) {
      expect(priceTierForTradeLevel(rung), rung).toBe("lower");
    }
    for (
      const rung of ["setter", "setter_programmer", "programmer", "supervisor"] as const
    ) {
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
    expect(tradeLevelLabelFor("qp_cnc_turning", "setter_programmer")).toBe(
      "Setter-cum-Programmer",
    );
    expect(tradeLevelLabelFor("qp_cam_programming", "senior_programmer")).toBe(
      "Senior Programmer",
    );
    expect(tradeLevelLabelFor("qp_cnc_turning", null)).toBeNull();
    expect(tradeLevelLabelFor("qp_cnc_turning", "boss")).toBeNull();
    expect(tradeLevelLabelFor("qp_welding", "setter")).toBeNull();
  });

  it("emits the authored skill row for a pack's level answer, and nothing else", () => {
    // Turner setter: trade skill + confirmed.
    expect(
      tradeLevelEntriesForPackAnswers("qp_cnc_turning", [{ attributeKey: "turning_level", value: "setter" }]),
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
      tradeLevelEntriesForPackAnswers("qp_vmc_milling", [{ attributeKey: "milling_level", value: "helper" }]),
    ).toEqual([{ skillId: "mskill_vmc_operator", tradeLevel: "helper", levelConfirmed: false }]);
    // CAM junior: written, unconfirmed; senior: written, confirmed.
    expect(
      tradeLevelEntriesForPackAnswers("qp_cam_programming", [{ attributeKey: "cam_level", value: "junior_programmer" }]),
    ).toEqual([
      { skillId: "mskill_cam_programmer", tradeLevel: "junior_programmer", levelConfirmed: false },
    ]);
    // Unknown pack, unstated rung, unmapped spelling, wrong key: no row.
    expect(tradeLevelEntriesForPackAnswers("qp_welding", [{ attributeKey: "welding_level", value: "setter" }])).toEqual([]);
    expect(tradeLevelEntriesForPackAnswers("qp_cnc_turning", [])).toEqual([]);
    expect(tradeLevelEntriesForPackAnswers("qp_cnc_turning", [{ attributeKey: "turning_level", value: "boss" }])).toEqual([]);
    expect(tradeLevelEntriesForPackAnswers("qp_cnc_turning", [{ attributeKey: "turning_machine", value: "setter" }])).toEqual([]);
    expect(tradeLevelEntriesForPackAnswers(null, [{ attributeKey: "turning_level", value: "setter" }])).toEqual([]);
    // Versioned pack ids resolve to the same crosswalk.
    expect(
      tradeLevelEntriesForPackAnswers("qp_cnc_grinding@3", [{ attributeKey: "grinding_level", value: "operator" }]),
    ).toEqual([
      { skillId: "mskill_cnc_grinding_operator", tradeLevel: "operator", levelConfirmed: false },
    ]);
  });
});
