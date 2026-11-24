/**
 * #3028 — the trade-code report is a gate, not just a printout. These tests hold the
 * committed files to the pack's section 13 rules with no database and no network.
 */
import { describe, expect, it } from "vitest";
import { TRADE_CATALOGUE } from "@badabhai/taxonomy";

import {
  BOUND_TO_NO_TRADE,
  GENERIC_CNC_TITLES,
  GENERIC_TITLED_CODES,
  buildTradeCodeReport,
  loadPackCodes,
} from "./report-trade-code-bindings";

describe("trade code report (#3028)", () => {
  const report = buildTradeCodeReport();
  const pack = loadPackCodes();

  it("runs on the committed files and every rule passes", () => {
    expect(report.problems).toEqual([]);
    for (const check of report.ruleChecks) expect(check.ok, check.label).toBe(true);
  });

  it("covers every section 13.1 code and every live catalogue binding", () => {
    for (const entry of TRADE_CATALOGUE) {
      const rows = report.rows.filter((r) => r.tradeCode === entry.code);
      for (const code of pack.get(entry.code) ?? []) {
        expect(
          rows.some((r) => r.code === code.code && r.source === "pack"),
          `${entry.code} pack ${code.code}`,
        ).toBe(true);
      }
      for (const code of entry.ncoCodes) {
        expect(rows.some((r) => r.code === code), `${entry.code} ncoCode ${code}`).toBe(true);
      }
    }
    // A vacuity guard: the pack parser found the 16 live trades' proposed lists.
    expect([...pack.keys()].filter((code) => code.startsWith("T")).length).toBe(60);
  });

  it("keeps every code section 13 sends to no trade off every trade", () => {
    for (const code of BOUND_TO_NO_TRADE.keys()) {
      expect(report.rows.some((r) => r.code === code), code).toBe(false);
    }
  });

  it("prints the eight generic-title descriptions for a person to read", () => {
    expect(report.genericTitles.map((r) => r.code)).toEqual([...GENERIC_TITLED_CODES]);
    for (const row of report.genericTitles) {
      expect(row.description.length, row.code).toBeGreaterThan(20);
      expect(row.trades, row.code).not.toBe("(no trade lists it)");
    }
  });

  it("keeps the three generic CNC titles on at most one form", () => {
    for (const code of GENERIC_CNC_TITLES) {
      const trades = new Set(report.rows.filter((r) => r.code === code).map((r) => r.tradeCode));
      expect(trades.size, code).toBeLessThanOrEqual(1);
    }
  });

  it("keeps every shared code owned by one of the trades that lists it", () => {
    for (const row of report.shared) expect(row.ownedByListedTrade, row.code).toBe(true);
  });

  it("separates pack differences from live-only bindings", () => {
    for (const row of report.differences) {
      expect(row.source).toBe("pack");
      expect(row.ownFamily).toBe(false);
    }
    for (const row of report.liveExtras) {
      expect(row.source).toBe("live-only");
    }
    // The live table is the pack's list plus the live-only bindings; it is never empty.
    expect(report.liveRows.length).toBeGreaterThan(0);
  });
});
