import { describe, it, expect } from "vitest";
import {
  HOSPITALITY_TRADE_CONTENT,
  REQUIRED_HOSP_TRADE_KEYS,
  getHospitalityTradeContent,
} from "./hospitality-trade-content";

describe("hospitality per-trade resume content (drafted, pending RVM)", () => {
  it("includes every required hospitality trade", () => {
    const keys = new Set(HOSPITALITY_TRADE_CONTENT.map((t) => t.trade_key));
    for (const required of REQUIRED_HOSP_TRADE_KEYS) {
      expect(keys.has(required)).toBe(true);
    }
  });

  it("has unique, lowercase-slug, hosp_-prefixed trade keys (no duplicates)", () => {
    const keys = HOSPITALITY_TRADE_CONTENT.map((t) => t.trade_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of HOSPITALITY_TRADE_CONTENT) {
      expect(t.trade_key).toMatch(/^hosp_[a-z0-9_]+$/);
    }
  });

  it("every trade has non-empty required content rows (exact parity with manufacturing)", () => {
    for (const t of HOSPITALITY_TRADE_CONTENT) {
      expect(t.display_name.length).toBeGreaterThan(0);
      expect(t.headline_template.length).toBeGreaterThan(0);
      expect(t.summary_template.length).toBeGreaterThan(0);
      expect(t.core_skills.length).toBeGreaterThan(0);
      expect(t.machine_tools.length).toBeGreaterThan(0);
      expect(t.inspection_tools.length).toBeGreaterThan(0);
      expect(t.responsibilities.length).toBeGreaterThan(0);
      expect(t.safety_points.length).toBeGreaterThan(0);
      expect(t.experience_phrases.length).toBeGreaterThan(0);
      expect(t.fresher_phrases.length).toBeGreaterThan(0);
      expect(t.certification_phrases.length).toBeGreaterThan(0);
      expect(t.keywords.length).toBeGreaterThan(0);
    }
  });

  it("uses only the allowed template variables ({{role}}, {{years}}, {{primary_machine}})", () => {
    const allowed = new Set(["role", "years", "primary_machine"]);
    for (const t of HOSPITALITY_TRADE_CONTENT) {
      const text = `${t.headline_template} ${t.summary_template}`;
      for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) {
        expect(allowed.has(m[1]!)).toBe(true);
      }
    }
  });

  it("contains NO fabricated specifics — no company names, salaries, or invented numbers", () => {
    for (const t of HOSPITALITY_TRADE_CONTENT) {
      const blob = JSON.stringify(t);
      expect(blob).not.toMatch(/₹|rupee|salary|lakh|lpa/i);
      expect(blob).not.toMatch(/\b(Pvt|Ltd|Limited|Industries|Engineering Works)\b/);
    }
  });

  it("getHospitalityTradeContent resolves by key and returns undefined for unknown", () => {
    expect(getHospitalityTradeContent("hosp_barista")?.display_name).toBe("Barista");
    expect(getHospitalityTradeContent("does_not_exist")).toBeUndefined();
  });
});
