import { describe, expect, it } from "vitest";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { isMatchSkillId } from "./match-skills";
import {
  LIVE_POSTING_TRADE_KINDS,
  POSTING_TRADES,
  POSTING_TRADE_KINDS,
  TRADES_V2_POSTING_KINDS,
  isLivePostingTradeKind,
  isPostingTradeKind,
  postingTradeFor,
} from "./posting-trades";
import { TRADE_CATALOGUE } from "./trade-catalogue";
import { TRADE_LEVEL_LABELS } from "./trade-levels";

const LIVE_TRADES = POSTING_TRADES.filter((trade) => isLivePostingTradeKind(trade.roleKind));

/**
 * The 60-trade posting catalogue (16 live + 44 of CEO pack v2, #3005) is a product contract,
 * not a convenience list.
 * These pins keep it from drifting from the declared role vocabulary or from the
 * closed match-skill / trade-level sets the rest of the system validates against.
 */
describe("posting trade catalogue", () => {
  it("keeps the 16 live non-polymer roles, once each, first", () => {
    expect(LIVE_POSTING_TRADE_KINDS).toHaveLength(16);
    expect(new Set(LIVE_POSTING_TRADE_KINDS).size).toBe(16);
    expect(POSTING_TRADE_KINDS.slice(0, 16)).toEqual([...LIVE_POSTING_TRADE_KINDS]);
    for (const kind of LIVE_POSTING_TRADE_KINDS) {
      expect(kind).not.toMatch(/moulding|mould_die|plastic_process/);
    }
  });

  it("#3005: declares all 60 catalogue trades, once each, every one a declared role kind", () => {
    expect(POSTING_TRADE_KINDS).toHaveLength(60);
    expect(new Set(POSTING_TRADE_KINDS).size).toBe(60);
    expect(POSTING_TRADES).toHaveLength(60);
    expect(new Set(POSTING_TRADE_KINDS)).toEqual(new Set(TRADE_CATALOGUE.map((e) => e.roleKind)));
    expect(TRADES_V2_POSTING_KINDS).toEqual(
      TRADE_CATALOGUE.filter((e) => e.wave > 0).map((e) => e.roleKind),
    );
    for (const kind of POSTING_TRADE_KINDS) expect(TRADE_FORM_KINDS_ALL).toContain(kind);
  });

  it("#3005: generates each trades-v2 row from its catalogue entry", () => {
    for (const kind of TRADES_V2_POSTING_KINDS) {
      const trade = postingTradeFor(kind)!;
      const entry = TRADE_CATALOGUE.find((e) => e.roleKind === kind)!;
      expect(trade.packId, kind).toBe(entry.packId);
      expect(trade.familyId, kind).toBe(entry.familyId);
      expect(trade.matchSkillId, kind).toBe(entry.matchSkillId);
      expect(trade.legacyRungs, kind).toEqual([]);
      const rungs = entry.ladder.map((r) => r.rung);
      expect(trade.ladder.map((r) => r.rung), kind).toEqual(rungs);
      const confirmedAt = rungs.indexOf(entry.confirmedFrom);
      const higherAt = rungs.indexOf(entry.higherPriceFrom);
      trade.ladder.forEach((rung, i) => {
        expect(rung.confirmed, `${kind}:${rung.rung}`).toBe(i >= confirmedAt);
        expect(rung.priceTier, `${kind}:${rung.rung}`).toBe(i >= higherAt ? "higher" : "lower");
      });
    }
    // A trade's separating question is its rung's evidence (sheet T17, the setter confirm).
    expect(postingTradeFor("edm_wirecut_operator")!.ladder.find((r) => r.rung === "setter")!.evidence).toBe(
      "Naye job ki clamping, dialling aur edge find aap khud karte ho?",
    );
  });

  it("#3005: every trade carries its catalogue posting keys, none from the excluded set", () => {
    for (const trade of POSTING_TRADES) {
      const entry = TRADE_CATALOGUE.find((e) => e.roleKind === trade.roleKind)!;
      expect(trade.postingQuestionKeys, trade.roleKind).toEqual(entry.postingQuestionKeys);
      expect(trade.postingQuestionKeys.length, trade.roleKind).toBeGreaterThan(0);
      expect(new Set(trade.postingQuestionKeys).size, trade.roleKind).toBe(
        trade.postingQuestionKeys.length,
      );
      for (const key of trade.postingQuestionKeys) {
        expect(key, trade.roleKind).not.toMatch(
          /_experience$|_confirm$|_training_exposure$|^iti_|^trade_test_status$/,
        );
        // The 16 live lists are what the old filter kept, which allowed `inspection_level` (the
        // quality inspector's level key) as a real requirement; the rule applies to the 44.
        if (!isLivePostingTradeKind(trade.roleKind)) expect(key, trade.roleKind).not.toBe(entry.levelKey);
      }
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
      // #2753 item 1 — the worker pack's @3 splits "Senior / Programmer"; the posting follows.
      sheet_metal_worker: {
        rungs: ["trainee", "operator", "skilled", "senior", "programmer", "supervisor"],
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
    expect(Object.keys(SHEETS).sort()).toEqual([...LIVE_POSTING_TRADE_KINDS].sort());
    for (const trade of LIVE_TRADES) {
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

  it("resolves only the 60 postable kinds", () => {
    for (const kind of POSTING_TRADE_KINDS) {
      expect(postingTradeFor(kind)?.roleKind).toBe(kind);
      expect(isPostingTradeKind(kind)).toBe(true);
    }
    // The retired polymer and foundry roles (#3030) are not in the catalogue.
    for (const kind of [
      "mould_die_maker",
      "plastic_process_technician",
      "foundry_forging_operator",
      "not_a_role",
    ]) {
      expect(postingTradeFor(kind)).toBeUndefined();
      expect(isPostingTradeKind(kind)).toBe(false);
    }
    expect(isLivePostingTradeKind("cnc_turner")).toBe(true);
    expect(isLivePostingTradeKind("gear_cutting_operator")).toBe(false);
    expect(postingTradeFor(null)).toBeUndefined();
  });
});
