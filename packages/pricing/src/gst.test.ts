import { describe, expect, it } from "vitest";
import { GST_RATE_BPS, formatGstPriceLine, formatPackPriceLine, gstPriceLine } from "./index";

/**
 * Why a line is inconsistent, or null: taxable + gst = total, the GST and the total are whole
 * rupees, the round-off is always 0, and every field is a safe integer.
 */
function inconsistency(priceInr: number, rateBps?: number): string | null {
  const line = gstPriceLine(priceInr, rateBps);
  if (line.taxablePaise + line.gstPaise !== line.totalPaise) return "sum";
  if (line.roundOffPaise !== 0) return "round-off not zero";
  if (line.gstPaise % 100 !== 0) return "GST not whole rupees";
  if (line.totalPaise % 100 !== 0) return "total not whole rupees";
  if (!Object.values(line).every((v) => Number.isSafeInteger(v))) return "not a safe integer";
  return null;
}

function expectConsistent(priceInr: number, rateBps?: number): void {
  expect(inconsistency(priceInr, rateBps)).toBeNull();
}

/**
 * The rule before the owner ruling of 2026-11-18 (GST to the paisa, the TOTAL rounded to the
 * rupee, the difference a round-off): kept here only to prove the new rule charges the same total.
 */
function earlierTotalPaise(priceInr: number): number {
  const taxable = priceInr * 100;
  const gst = Math.floor((taxable * 1800 + 5000) / 10_000);
  return Math.floor((taxable + gst + 50) / 100) * 100;
}

describe("gstPriceLine — integer paise, 18% GST rounded half-up to the rupee, no round-off (#2749)", () => {
  it("is 18% (1800 bps) by default", () => {
    expect(GST_RATE_BPS).toBe(1800);
    expect(gstPriceLine(999).gstRateBps).toBe(1800);
  });

  it("₹999 → taxable 99,900 + GST 18,000 (₹179.82 rounded to ₹180) = 1,17,900, round-off 0", () => {
    expect(gstPriceLine(999)).toEqual({
      taxablePaise: 99_900,
      gstPaise: 18_000,
      roundOffPaise: 0,
      totalPaise: 117_900,
      gstRateBps: 1800,
    });
  });

  it.each([
    [999, 1179],
    [1599, 1887],
    [2999, 3539],
    [9999, 11799],
    [4000, 4720],
    [8000, 9440],
    [2000, 2360],
  ])("₹%i plus GST is ₹%i (the brief's price list)", (priceInr, totalInr) => {
    expect(gstPriceLine(priceInr).totalPaise).toBe(totalInr * 100);
    expectConsistent(priceInr);
  });

  it("the GST rounds DOWN below half a rupee (₹1,001: ₹180.18 → ₹180, total ₹1,181)", () => {
    expect(gstPriceLine(1001)).toEqual({
      taxablePaise: 100_100,
      gstPaise: 18_000,
      roundOffPaise: 0,
      totalPaise: 118_100,
      gstRateBps: 1800,
    });
  });

  it("a GST of exactly half a rupee rounds UP (₹25: ₹4.50 → ₹5, total ₹30)", () => {
    expect(gstPriceLine(25)).toEqual({
      taxablePaise: 2500,
      gstPaise: 500,
      roundOffPaise: 0,
      totalPaise: 3000,
      gstRateBps: 1800,
    });
  });

  it("just below half a rupee rounds DOWN, just above rounds UP", () => {
    // ₹36: GST ₹6.48 → ₹6 (total ₹42).
    expect(gstPriceLine(36)).toMatchObject({ gstPaise: 600, roundOffPaise: 0, totalPaise: 4200 });
    // ₹14: GST ₹2.52 → ₹3 (total ₹17).
    expect(gstPriceLine(14)).toMatchObject({ gstPaise: 300, roundOffPaise: 0, totalPaise: 1700 });
  });

  it("one rounding, on the exact tax, at a rate where half-rupees occur (non-18% rate)", () => {
    // 1 bps: tax = price ÷ 10,000 rupees.
    expect(gstPriceLine(5000, 1).gstPaise).toBe(100); // ₹0.50 → ₹1
    expect(gstPriceLine(4999, 1).gstPaise).toBe(0); // ₹0.4999 → ₹0 (no double rounding)
    // 12.5%: ₹4 → ₹0.50 → ₹1; ₹12 → ₹1.50 → ₹2.
    expect(gstPriceLine(4, 1250).gstPaise).toBe(100);
    expect(gstPriceLine(12, 1250).gstPaise).toBe(200);
    expectConsistent(5000, 1);
    expectConsistent(12, 1250);
  });

  it("₹0 is all zeros; 0% GST is the price itself", () => {
    expect(gstPriceLine(0)).toEqual({
      taxablePaise: 0,
      gstPaise: 0,
      roundOffPaise: 0,
      totalPaise: 0,
      gstRateBps: 1800,
    });
    expect(gstPriceLine(999, 0)).toMatchObject({
      gstPaise: 0,
      roundOffPaise: 0,
      totalPaise: 99_900,
    });
  });

  // One assertion for the whole sweep (not one per price), and an explicit timeout: CI runs
  // every suite at once, far slower than a laptop.
  it("stays exact and consistent across a sweep of prices", { timeout: 30_000 }, () => {
    const failures: string[] = [];
    for (const price of [...Array.from({ length: 5000 }, (_, i) => i + 1), 32_000, 10_000_000]) {
      const why = inconsistency(price);
      if (why !== null) failures.push(`₹${price}: ${why}`);
    }
    expect(failures).toEqual([]);
  });

  it("charges the same total as the earlier round-off rule for every whole-rupee price at 18%", { timeout: 30_000 }, () => {
    const differ: number[] = [];
    for (let price = 0; price <= 20_000; price += 1) {
      if (gstPriceLine(price).totalPaise !== earlierTotalPaise(price)) differ.push(price);
    }
    expect(differ).toEqual([]);
  });

  it("REJECTS a non-integer, negative or unsafe price and an out-of-range rate", () => {
    expect(() => gstPriceLine(999.5)).toThrow(RangeError);
    expect(() => gstPriceLine(-1)).toThrow(RangeError);
    expect(() => gstPriceLine(Number.NaN)).toThrow(RangeError);
    expect(() => gstPriceLine(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => gstPriceLine(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(() => gstPriceLine(Number.MAX_SAFE_INTEGER, 0)).toThrow(RangeError);
    expect(() => gstPriceLine(999, -1)).toThrow(RangeError);
    expect(() => gstPriceLine(999, 10_001)).toThrow(RangeError);
    expect(() => gstPriceLine(999, 18.5)).toThrow(RangeError);
  });
});

describe("formatPackPriceLine — '₹999 plus GST (₹1,179)' (B4C-06)", () => {
  it("prints the brief's three lines exactly", () => {
    expect(formatPackPriceLine(999)).toBe("₹999 plus GST (₹1,179)");
    expect(formatPackPriceLine(1599)).toBe("₹1,599 plus GST (₹1,887)");
    expect(formatPackPriceLine(2999)).toBe("₹2,999 plus GST (₹3,539)");
  });

  it("groups en-IN on both amounts", () => {
    expect(formatPackPriceLine(9999)).toBe("₹9,999 plus GST (₹11,799)");
    expect(formatPackPriceLine(100_000)).toBe("₹1,00,000 plus GST (₹1,18,000)");
  });

  it("rejects what gstPriceLine rejects", () => {
    expect(() => formatPackPriceLine(999.5)).toThrow(RangeError);
    expect(() => formatPackPriceLine(-1)).toThrow(RangeError);
  });

  it("formatGstPriceLine prints the same line from an already-computed GST line", () => {
    for (const price of [999, 1599, 2999, 9999, 1001, 25, 0]) {
      expect(formatGstPriceLine(gstPriceLine(price))).toBe(formatPackPriceLine(price));
    }
  });
});
