import { describe, expect, it } from "vitest";
import { partnerSharePaise } from "./pay-on-joining.share";

/**
 * #2753 item 11 — the partner's share: floor(fee_paise * percent / 100), in integers. BadaBhai
 * keeps the remainder paisa.
 */
describe("partnerSharePaise", () => {
  it("70% of ₹5,000 (500000 paise) is ₹3,500 (350000 paise)", () => {
    expect(partnerSharePaise(500_000, 70)).toBe(350_000);
  });

  it("70% of ₹5,900 with GST (590000 paise) is 413000 paise", () => {
    expect(partnerSharePaise(590_000, 70)).toBe(413_000);
  });

  it("FLOORS: a share that is not whole paise loses the fraction, never rounds up", () => {
    // 70% of 1 paisa is 0.7 → 0; of 3 paise 2.1 → 2; of 999 paise 699.3 → 699.
    expect(partnerSharePaise(1, 70)).toBe(0);
    expect(partnerSharePaise(3, 70)).toBe(2);
    expect(partnerSharePaise(999, 70)).toBe(699);
    // 33% of 100001 paise is 33000.33 → 33000; BadaBhai keeps 67001.
    expect(partnerSharePaise(100_001, 33)).toBe(33_000);
    // 99% of 199 paise is 197.01 → 197 (Math.round would also say 197; 199 * 0.99 = 197.01).
    expect(partnerSharePaise(199, 99)).toBe(197);
  });

  it("a zero fee owes nothing, whatever the percent", () => {
    expect(partnerSharePaise(0, 70)).toBe(0);
    expect(partnerSharePaise(0, 100)).toBe(0);
  });

  it("0% owes the partner nothing; 100% owes the whole fee", () => {
    expect(partnerSharePaise(500_000, 0)).toBe(0);
    expect(partnerSharePaise(500_000, 100)).toBe(500_000);
    expect(partnerSharePaise(Number.MAX_SAFE_INTEGER, 100)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is exact for a large fee where a float product would be off", () => {
    // 9007199254740988 * 70 = 630503947831869160, past 2^53: the float product rounds, and its
    // floor would pay the partner one paisa too many.
    const fee = 9_007_199_254_740_988;
    expect(partnerSharePaise(fee, 70)).toBe(Number((BigInt(fee) * 70n) / 100n));
    expect(partnerSharePaise(fee, 70)).toBe(6_305_039_478_318_691);
    expect(Math.floor((fee * 70) / 100)).toBe(6_305_039_478_318_692);
    expect(partnerSharePaise(Number.MAX_SAFE_INTEGER, 33)).toBe(2_972_375_754_064_527);
    expect(Math.floor((Number.MAX_SAFE_INTEGER * 33) / 100)).toBe(2_972_375_754_064_526);
  });

  it("is exact where a fractional multiplier would be off, even for small fees", () => {
    // 90 paise * 0.7 is 62.99999999999999 in floating point; the share is 63.
    expect(Math.floor(90 * 0.7)).toBe(62);
    expect(partnerSharePaise(90, 70)).toBe(63);
    expect(partnerSharePaise(170, 70)).toBe(119);
  });

  it("always answers a safe integer no larger than the fee", () => {
    const fee = Number.MAX_SAFE_INTEGER;
    for (const percent of [1, 33, 69, 70, 71, 99]) {
      const share = partnerSharePaise(fee, percent);
      expect(Number.isSafeInteger(share), String(percent)).toBe(true);
      expect(share).toBeLessThanOrEqual(fee);
    }
  });

  it("refuses a fee that is negative, fractional or past a safe integer, and a percent outside 0..100", () => {
    expect(() => partnerSharePaise(-1, 70)).toThrow(RangeError);
    expect(() => partnerSharePaise(100.5, 70)).toThrow(RangeError);
    expect(() => partnerSharePaise(Number.MAX_SAFE_INTEGER + 1, 70)).toThrow(RangeError);
    expect(() => partnerSharePaise(Number.NaN, 70)).toThrow(RangeError);
    expect(() => partnerSharePaise(500_000, -1)).toThrow(RangeError);
    expect(() => partnerSharePaise(500_000, 101)).toThrow(RangeError);
    expect(() => partnerSharePaise(500_000, 70.5)).toThrow(RangeError);
  });
});
