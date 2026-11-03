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
