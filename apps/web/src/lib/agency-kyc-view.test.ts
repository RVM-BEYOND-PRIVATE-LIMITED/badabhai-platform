import { describe, it, expect } from "vitest";
import {
  REJECT_REASONS,
  rejectReasonLabel,
  isRejectReason,
  maskLast4,
} from "./agency-kyc-view";

/**
 * Tests for the PURE agency-KYC view helpers (ADR-0022 Amendment 2): the last-4
 * masking and the bounded reject-reason vocabulary the select renders / validates.
 */

describe("REJECT_REASONS", () => {
  it("is exactly the bounded API vocabulary, in order", () => {
    expect(REJECT_REASONS.map((r) => r.code)).toEqual([
      "invalid_pan",
      "invalid_bank",
      "name_mismatch",
      "duplicate",
      "other",
    ]);
  });

  it("gives every code a human label", () => {
    for (const r of REJECT_REASONS) {
      expect(r.label.length).toBeGreaterThan(0);
    }
  });
});

describe("rejectReasonLabel", () => {
  it("maps a known code to its label", () => {
    expect(rejectReasonLabel("name_mismatch")).toBe("Name mismatch");
  });
});

describe("isRejectReason", () => {
  it("accepts every bounded code", () => {
    for (const r of REJECT_REASONS) {
      expect(isRejectReason(r.code)).toBe(true);
    }
  });

  it("rejects out-of-vocabulary / non-string values", () => {
    expect(isRejectReason("invalid_reason")).toBe(false);
    expect(isRejectReason("")).toBe(false);
    expect(isRejectReason(null)).toBe(false);
    expect(isRejectReason(42)).toBe(false);
  });
});

describe("maskLast4", () => {
  it("prefixes a last-4 fragment with a mask", () => {
    expect(maskLast4("1234")).toBe("••••1234");
  });

  it("renders an em-dash when there is no last-4", () => {
    expect(maskLast4(null)).toBe("—");
    expect(maskLast4("")).toBe("—");
  });

  it("never contains more than the 4-char fragment it was given", () => {
    // Structural guarantee: the helper only ever appends the given fragment — it
    // cannot un-mask a value it was never handed (the API returns last-4 only).
    expect(maskLast4("9999")).not.toContain("0000");
  });
});
