import { describe, expect, it } from "vitest";
import { formatInr } from "./format";

describe("formatInr — whole-rupee en-IN money strings", () => {
  it("formats small amounts with no space after ₹", () => {
    expect(formatInr(40)).toBe("₹40");
  });

  it("formats ₹0 (boundary) as '₹0'", () => {
    expect(formatInr(0)).toBe("₹0");
  });

  it("groups thousands en-IN", () => {
    expect(formatInr(2000)).toBe("₹2,000");
    expect(formatInr(20000)).toBe("₹20,000");
    expect(formatInr(35000)).toBe("₹35,000");
  });

  it("uses lakh/crore grouping for large amounts", () => {
    expect(formatInr(100000)).toBe("₹1,00,000");
    expect(formatInr(1000000)).toBe("₹10,00,000");
    expect(formatInr(10000000)).toBe("₹1,00,00,000");
  });

  it("reproduces the exact strings the screens/tests assert", () => {
    // credits history top-up amount + agency pay band ends
    expect(formatInr(2000)).toBe("₹2,000");
    expect(formatInr(20000)).toBe("₹20,000");
    // the per-unlock unit price interpolated into copy
    expect(`${formatInr(40)} per unlock`).toBe("₹40 per unlock");
  });

  it("REJECTS non-integer (paise) input with a RangeError", () => {
    expect(() => formatInr(40.5)).toThrow(RangeError);
    expect(() => formatInr(0.1)).toThrow(RangeError);
    expect(() => formatInr(Number.NaN)).toThrow(RangeError);
    expect(() => formatInr(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("REJECTS negative input with a RangeError", () => {
    expect(() => formatInr(-1)).toThrow(RangeError);
    expect(() => formatInr(-2000)).toThrow(RangeError);
  });
});
