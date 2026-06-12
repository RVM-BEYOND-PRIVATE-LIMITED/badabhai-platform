import { describe, it, expect } from "vitest";
import {
  INTERVIEW_KITS,
  REQUIRED_KIT_TRADE_KEYS,
  getInterviewKit,
} from "./interview-kit-content";

describe("interview-kit content (Task 4)", () => {
  it("includes every required Phase-1 kit trade", () => {
    const keys = new Set(INTERVIEW_KITS.map((k) => k.trade_key));
    for (const required of REQUIRED_KIT_TRADE_KEYS) {
      expect(keys.has(required)).toBe(true);
    }
  });

  it("has unique, lowercase-slug trade keys", () => {
    const keys = INTERVIEW_KITS.map((k) => k.trade_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of INTERVIEW_KITS) expect(k.trade_key).toMatch(/^[a-z0-9_]+$/);
  });

  it("every kit has non-empty sections (overview + all question groups + checklist)", () => {
    for (const k of INTERVIEW_KITS) {
      expect(k.display_name.length).toBeGreaterThan(0);
      expect(k.overview.length).toBeGreaterThan(0);
      expect(k.common_questions.length).toBeGreaterThan(0);
      expect(k.practical_questions.length).toBeGreaterThan(0);
      expect(k.safety_questions.length).toBeGreaterThan(0);
      expect(k.drawing_measurement_questions.length).toBeGreaterThan(0);
      expect(k.skill_checklist.length).toBeGreaterThan(0);
      expect(k.revise_before.length).toBeGreaterThan(0);
      expect(k.documents_to_carry.length).toBeGreaterThan(0);
      expect(k.common_mistakes.length).toBeGreaterThan(0);
      expect(k.hinglish_note.length).toBeGreaterThan(0);
    }
  });

  it("contains no fabricated specifics (no company names or salary figures)", () => {
    for (const k of INTERVIEW_KITS) {
      const blob = JSON.stringify(k);
      expect(blob).not.toMatch(/₹|salary|lakh|lpa/i);
      expect(blob).not.toMatch(/\b(Pvt|Ltd|Limited|Industries)\b/);
    }
  });

  it("getInterviewKit resolves by key and returns undefined for unknown", () => {
    expect(getInterviewKit("cnc_operator")?.display_name).toBe("CNC Operator");
    expect(getInterviewKit("nope")).toBeUndefined();
  });
});
