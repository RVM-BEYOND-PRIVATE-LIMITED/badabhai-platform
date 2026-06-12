import { describe, it, expect } from "vitest";
import {
  TRADE_CONTENT,
  REQUIRED_TRADE_KEYS,
  getTradeContent,
  resolveTradeContent,
} from "./trade-content";

describe("per-trade resume content (TD24a)", () => {
  it("includes every required Phase-1 trade", () => {
    const keys = new Set(TRADE_CONTENT.map((t) => t.trade_key));
    for (const required of REQUIRED_TRADE_KEYS) {
      expect(keys.has(required)).toBe(true);
    }
  });

  it("has unique, lowercase-slug trade keys (no duplicates, no empty rows)", () => {
    const keys = TRADE_CONTENT.map((t) => t.trade_key);
    expect(new Set(keys).size).toBe(keys.length); // unique
    for (const t of TRADE_CONTENT) {
      expect(t.trade_key).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("every trade has non-empty required content rows", () => {
    for (const t of TRADE_CONTENT) {
      expect(t.display_name.length).toBeGreaterThan(0);
      expect(t.headline_template.length).toBeGreaterThan(0);
      expect(t.summary_template.length).toBeGreaterThan(0);
      expect(t.core_skills.length).toBeGreaterThan(0);
      expect(t.machine_tools.length).toBeGreaterThan(0);
      expect(t.inspection_tools.length).toBeGreaterThan(0);
      expect(t.responsibilities.length).toBeGreaterThan(0);
      expect(t.safety_points.length).toBeGreaterThan(0);
      expect(t.experience_phrases.length).toBeGreaterThan(0);
      expect(t.fresher_phrases.length).toBeGreaterThan(0); // must render for freshers
      expect(t.certification_phrases.length).toBeGreaterThan(0);
      expect(t.keywords.length).toBeGreaterThan(0);
    }
  });

  it("contains NO fabricated specifics — no company names, salaries, or invented numbers", () => {
    // Guard against accidental hallucinated claims sneaking into static copy.
    for (const t of TRADE_CONTENT) {
      const blob = JSON.stringify(t);
      expect(blob).not.toMatch(/₹|rupee|salary|lakh|lpa/i); // no salary claims
      expect(blob).not.toMatch(/\b(Pvt|Ltd|Limited|Industries|Engineering Works)\b/); // no employers
    }
  });

  it("getTradeContent resolves by key and returns undefined for unknown", () => {
    expect(getTradeContent("vmc_operator")?.display_name).toBe("VMC Operator");
    expect(getTradeContent("does_not_exist")).toBeUndefined();
  });

  it("resolveTradeContent maps a taxonomy role id to its trade", () => {
    // taxonomy role_vmc_operator -> vmc_operator trade content
    expect(resolveTradeContent("role_vmc_operator", null)?.trade_key).toBe("vmc_operator");
    expect(resolveTradeContent("role_cnc_turner_operator", null)?.trade_key).toBe("cnc_operator");
  });

  it("resolveTradeContent falls back to a direct trade_key, then undefined", () => {
    expect(resolveTradeContent(null, "fitter")?.trade_key).toBe("fitter");
    expect(resolveTradeContent("unknown_role", "unknown_trade")).toBeUndefined();
  });
});
