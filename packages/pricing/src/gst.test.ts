import { describe, expect, it } from "vitest";
import { GST_RATE_BPS, formatPackPriceLine, gstPriceLine } from "./index";

/**
 * Why a line is inconsistent, or null: taxable + gst + roundOff must equal the total, the total
 * is whole rupees, the round-off is −49…+50, and every field is a safe integer.
 */
function inconsistency(priceInr: number, rateBps?: number): string | null {
  const line = gstPriceLine(priceInr, rateBps);
  if (line.taxablePaise + line.gstPaise + line.roundOffPaise !== line.totalPaise) return "sum";
  if (line.totalPaise % 100 !== 0) return "total not whole rupees";
  if (line.roundOffPaise < -49 || line.roundOffPaise > 50) return "round-off out of range";
  if (!Object.values(line).every((v) => Number.isSafeInteger(v))) return "not a safe integer";
  return null;
}

function expectConsistent(priceInr: number, rateBps?: number): void {
  expect(inconsistency(priceInr, rateBps)).toBeNull();
}

describe("gstPriceLine — integer paise, 18% GST, total rounded half-up to the rupee (#2749)", () => {
  it("is 18% (1800 bps) by default", () => {
    expect(GST_RATE_BPS).toBe(1800);
    expect(gstPriceLine(999).gstRateBps).toBe(1800);
  });

  it("₹999 → 99,900 / 17,982 / +18 / 1,17,900 (the issue's worked example)", () => {
    expect(gstPriceLine(999)).toEqual({
      taxablePaise: 99_900,
      gstPaise: 17_982,
      roundOffPaise: 18,
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

  it("the round-off is NEGATIVE when the rupee rounds down (₹1,001 → ₹1,181)", () => {
    expect(gstPriceLine(1001)).toEqual({
      taxablePaise: 100_100,
      gstPaise: 18_018,
      roundOffPaise: -18,
      totalPaise: 118_100,
      gstRateBps: 1800,
    });
  });

  it("a total of exactly half a rupee rounds UP (₹25: ₹29.50 → ₹30, round-off +50)", () => {
    expect(gstPriceLine(25)).toEqual({
      taxablePaise: 2500,
      gstPaise: 450,
      roundOffPaise: 50,
      totalPaise: 3000,
      gstRateBps: 1800,
    });
  });

  it("just below half a rupee rounds DOWN, just above rounds UP", () => {
    // ₹36: 3,600 + 648 = 4,248 → 48 paise, below half → ₹42 (round-off −48).
    expect(gstPriceLine(36)).toMatchObject({ gstPaise: 648, roundOffPaise: -48, totalPaise: 4200 });
    // ₹14: 1,400 + 252 = 1,652 → 52 paise → ₹17 (round-off +48).
    expect(gstPriceLine(14)).toMatchObject({ gstPaise: 252, roundOffPaise: 48, totalPaise: 1700 });
  });

  it("a GST of exactly half a paisa rounds UP; just below half rounds DOWN (non-18% rate)", () => {
    // At 18% a whole-rupee price never yields a fractional paisa, so the paisa rounding is pinned
    // at 1 bps: tax = price ÷ 100 paise.
    expect(gstPriceLine(50, 1).gstPaise).toBe(1); // 0.50 paisa → 1
    expect(gstPriceLine(49, 1).gstPaise).toBe(0); // 0.49 paisa → 0
    expect(gstPriceLine(150, 1).gstPaise).toBe(2); // 1.50 → 2
    expect(gstPriceLine(149, 1).gstPaise).toBe(1); // 1.49 → 1
    // 12.5%: an odd rupee price lands on a half paisa.
    expect(gstPriceLine(1, 1250).gstPaise).toBe(13); // 12.5 → 13
    expect(gstPriceLine(3, 1250).gstPaise).toBe(38); // 37.5 → 38
    expectConsistent(50, 1);
    expectConsistent(3, 1250);
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
});
