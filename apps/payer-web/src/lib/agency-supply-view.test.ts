import { describe, expect, it } from "vitest";
import { accrualBasisLabel, payoutBlockedLabel } from "./agency-view";
import { maskLast4 } from "./masking";

/**
 * Agency SUPPLY-money presentational helpers (ADR-0022 Amendment 2). PURE — no I/O.
 * Pins the config-sourced accrual basis sentence, the blocked-payout friendly copy
 * (threshold woven in), and the masked last-4 motif (never a full PAN/bank number).
 */

describe("accrualBasisLabel — config-sourced, never hard-coded", () => {
  it("builds the 25% × ₹40 within 90 days sentence from bps/₹/days", () => {
    expect(accrualBasisLabel(2500, 40, 90)).toBe(
      "25% × ₹40 per contact unlock on your referred workers within 90 days",
    );
  });
  it("renders a fractional rate (2550 bps → 25.50%) and en-IN ₹ grouping", () => {
    expect(accrualBasisLabel(2550, 100000, 30)).toBe(
      "25.50% × ₹1,00,000 per contact unlock on your referred workers within 30 days",
    );
  });
});

describe("payoutBlockedLabel — friendly, no-oracle copy", () => {
  it("maps kyc_not_verified", () => {
    expect(payoutBlockedLabel("kyc_not_verified", 500)).toMatch(/Complete KYC verification/i);
  });
  it("maps below_threshold with the ₹ threshold woven in", () => {
    expect(payoutBlockedLabel("below_threshold", 500)).toBe(
      "You need at least ₹500 to request a payout.",
    );
  });
  it("maps disabled", () => {
    expect(payoutBlockedLabel("disabled", 500)).toMatch(/aren't enabled/i);
  });
  it("falls back to a neutral message for a null reason", () => {
    expect(payoutBlockedLabel(null, 500)).toMatch(/can't be requested/i);
  });
});

describe("maskLast4 — masked motif, never a full number", () => {
  it("masks to four bullets + the last 4", () => {
    expect(maskLast4("234F")).toBe("••••234F");
    expect(maskLast4("6789")).toBe("••••6789");
  });
  it("renders a neutral dash for empty / nullish (not-yet-submitted)", () => {
    expect(maskLast4(null)).toBe("—");
    expect(maskLast4(undefined)).toBe("—");
    expect(maskLast4("  ")).toBe("—");
  });
});
