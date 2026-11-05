import { describe, expect, it } from "vitest";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { isMatchSkillId } from "./match-skills";
import { POSTING_TRADES, POSTING_TRADE_KINDS, postingTradeFor } from "./posting-trades";
import { TRADE_LEVEL_LABELS } from "./trade-levels";

/**
 * The 16-trade posting catalogue is a product contract, not a convenience list.
 * These pins keep it from drifting from the declared role vocabulary or from the
 * closed match-skill / trade-level sets the rest of the system validates against.
 */
describe("posting trade catalogue", () => {
  it("declares exactly the 16 non-polymer roles, once each", () => {
    expect(POSTING_TRADE_KINDS).toHaveLength(16);
    expect(new Set(POSTING_TRADE_KINDS).size).toBe(16);
    expect(POSTING_TRADES).toHaveLength(16);
    for (const kind of POSTING_TRADE_KINDS) {
      expect(TRADE_FORM_KINDS_ALL).toContain(kind);
      expect(kind).not.toMatch(/moulding|mould_die|plastic_process/);
    }
  });

  it("has one catalogue row per declared kind, in the same order", () => {
    expect(POSTING_TRADES.map((trade) => trade.roleKind)).toEqual([...POSTING_TRADE_KINDS]);
  });

  it("names a valid base match skill and a pack for every trade", () => {
    for (const trade of POSTING_TRADES) {
      expect(isMatchSkillId(trade.matchSkillId), trade.roleKind).toBe(true);
      expect(trade.packId).toMatch(/^qp_[a-z0-9_]+$/);
      expect(trade.familyId).toMatch(/^fam_[a-z0-9_]+$/);
    }
  });

  it("uses only closed rung keys and keeps the ladder ordered", () => {
    for (const trade of POSTING_TRADES) {
      expect(trade.ladder.length, trade.roleKind).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const rung of trade.ladder) {
        expect(TRADE_LEVEL_LABELS[rung.rung], `${trade.roleKind}:${rung.rung}`).toBeTruthy();
        expect(seen.has(rung.rung), `${trade.roleKind}: duplicate ${rung.rung}`).toBe(false);
        seen.add(rung.rung);
        expect(rung.monthsFloor).toMatch(/^\d+(-\d+)?\+?$/);
        expect(rung.evidence.length).toBeGreaterThan(0);
      }
      expect(
        trade.ladder.some((rung) => rung.confirmed),
        trade.roleKind,
      ).toBe(true);
    }
  });

  it("offers each trade the CEO sheet's ladder — the one the worker answers (#2550)", () => {
    // CEO Launch Plan Pack v1 sheets 1-3, 5-13, 15, 18, 20, 21 (30 Oct ruling Q2: the posting's
    // level chips are the ladder the worker answers for that trade). Confirmed from the sheet's
    // named rung upward, supervisor by rule; confirmed rungs price Higher.
    const SHEETS: Record<string, { rungs: string[]; confirmedFrom: string }> = {
      cnc_turner: {
        rungs: ["trainee", "operator", "setter", "setter_programmer", "programmer", "supervisor"],
        confirmedFrom: "setter",
      },
      vmc_milling: {
        rungs: ["trainee", "operator", "setter", "setter_programmer", "programmer", "supervisor"],
        confirmedFrom: "setter",
      },
      cnc_grinding: {
        rungs: ["trainee", "operator", "setter", "setter_programmer", "supervisor"],
        confirmedFrom: "setter",
      },
      cam_programmer: {
        rungs: ["trainee", "programmer", "senior", "lead", "supervisor"],
        confirmedFrom: "programmer",
      },
      cad_draughtsman: {
        rungs: ["trainee", "designer", "senior_designer", "lead", "supervisor"],
        confirmedFrom: "senior_designer",
      },
      conventional_machinist: {
        rungs: ["trainee", "operator", "skilled", "senior", "supervisor"],
        confirmedFrom: "skilled",
      },
      tool_die_maker: {
        rungs: ["trainee", "operator", "skilled", "senior", "supervisor"],
        confirmedFrom: "skilled",
      },
      welder: { rungs: ["trainee", "operator", "skilled", "senior", "supervisor"], confirmedFrom: "skilled" },
      sheet_metal_worker: {
        rungs: ["trainee", "operator", "skilled", "senior", "supervisor"],
        confirmedFrom: "skilled",
      },
      press_operator: {
        rungs: ["trainee", "operator", "setter", "senior", "supervisor"],
        confirmedFrom: "setter",
      },
      painter_coating: {
        rungs: ["trainee", "operator", "skilled", "senior", "supervisor"],
        confirmedFrom: "skilled",
      },
      fitter: { rungs: ["trainee", "operator", "skilled", "senior", "supervisor"], confirmedFrom: "skilled" },
      maintenance_technician: {
        rungs: ["trainee", "technician", "senior_technician", "supervisor"],
        confirmedFrom: "senior_technician",
      },
      industrial_electrician: {
        rungs: ["trainee", "technician", "senior_technician", "supervisor"],
        confirmedFrom: "senior_technician",
      },
      assembly_line_worker: {
        rungs: ["trainee", "operator", "skilled", "senior", "supervisor"],
        confirmedFrom: "skilled",
      },
      quality_inspector: {
        rungs: ["trainee", "inspector", "senior_inspector", "qc_engineer", "supervisor"],
        confirmedFrom: "senior_inspector",
      },
    };
    expect(Object.keys(SHEETS).sort()).toEqual([...POSTING_TRADE_KINDS].sort());
    for (const trade of POSTING_TRADES) {
      const sheet = SHEETS[trade.roleKind]!;
      expect(trade.ladder.map((r) => r.rung), trade.roleKind).toEqual(sheet.rungs);
      const from = sheet.rungs.indexOf(sheet.confirmedFrom);
      trade.ladder.forEach((rung, i) => {
        expect(rung.confirmed, `${trade.roleKind}:${rung.rung}`).toBe(i >= from);
        expect(rung.priceTier, `${trade.roleKind}:${rung.rung}`).toBe(i >= from ? "higher" : "lower");
      });
    }
  });

  it("keeps every dropped rung as a legacy key, never offered and never a ladder rung", () => {
    for (const trade of POSTING_TRADES) {
      const offered = new Set<string>(trade.ladder.map((r) => r.rung));
      for (const legacy of trade.legacyRungs) {
        expect(TRADE_LEVEL_LABELS[legacy], `${trade.roleKind}:${legacy}`).toBeTruthy();
        expect(offered.has(legacy), `${trade.roleKind}:${legacy}`).toBe(false);
      }
    }
    // The keys the old catalogue offered and existing postings may store (#2550).
    expect(postingTradeFor("cam_programmer")?.legacyRungs).toEqual([
      "junior_programmer",
      "senior_programmer",
    ]);
    expect(postingTradeFor("press_operator")?.legacyRungs).toEqual(["helper", "skilled"]);
    expect(postingTradeFor("quality_inspector")?.legacyRungs).toEqual(["lead"]);
  });

  it("resolves only the 16 postable kinds", () => {
    for (const kind of POSTING_TRADE_KINDS) {
      expect(postingTradeFor(kind)?.roleKind).toBe(kind);
    }
    for (const kind of [
      "injection_moulding_operator",
      "mould_die_maker",
      "blow_moulding_operator",
      "rubber_moulding_operator",
      "plastic_process_technician",
      "not_a_role",
    ]) {
      expect(postingTradeFor(kind)).toBeUndefined();
    }
    expect(postingTradeFor(null)).toBeUndefined();
  });
});
