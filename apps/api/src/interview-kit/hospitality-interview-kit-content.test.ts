import { describe, it, expect } from "vitest";
import {
  HOSPITALITY_INTERVIEW_KITS,
  REQUIRED_HOSP_KIT_TRADE_KEYS,
  HOSP_COMMON_DOCS,
  getHospitalityInterviewKit,
} from "./hospitality-interview-kit-content";

describe("hospitality interview-kit content (drafted, pending RVM)", () => {
  it("includes every required hospitality kit trade", () => {
    const keys = new Set(HOSPITALITY_INTERVIEW_KITS.map((k) => k.trade_key));
    for (const required of REQUIRED_HOSP_KIT_TRADE_KEYS) {
      expect(keys.has(required)).toBe(true);
    }
  });

  it("has unique, lowercase-slug, hosp_-prefixed trade keys", () => {
    const keys = HOSPITALITY_INTERVIEW_KITS.map((k) => k.trade_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of HOSPITALITY_INTERVIEW_KITS) expect(k.trade_key).toMatch(/^hosp_[a-z0-9_]+$/);
  });

  it("every kit has non-empty sections (overview + all question groups + checklist)", () => {
    for (const k of HOSPITALITY_INTERVIEW_KITS) {
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

  it("every kit carries the COMMON_DOCS baseline in documents_to_carry", () => {
    for (const k of HOSPITALITY_INTERVIEW_KITS) {
      for (const doc of HOSP_COMMON_DOCS) {
        expect(k.documents_to_carry).toContain(doc);
      }
    }
  });

  it("contains no fabricated specifics (no company names or salary figures)", () => {
    for (const k of HOSPITALITY_INTERVIEW_KITS) {
      const blob = JSON.stringify(k);
      expect(blob).not.toMatch(/₹|salary|lakh|lpa/i);
      expect(blob).not.toMatch(/\b(Pvt|Ltd|Limited|Industries)\b/);
    }
  });

  it("getHospitalityInterviewKit resolves by key and returns undefined for unknown", () => {
    expect(getHospitalityInterviewKit("hosp_steward_waiter")?.display_name).toBe("Steward / Waiter");
    expect(getHospitalityInterviewKit("nope")).toBeUndefined();
  });
});
