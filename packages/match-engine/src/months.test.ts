import { describe, expect, it } from "vitest";
import { bucketMonthValue, bucketMonths } from "./months";

describe("bucketMonths", () => {
  it.each([
    [0, 0],
    [0.4, 0], // under five months -> nothing to claim yet
    [0.5, 6],
    [1, 12],
    [1.9, 18], // 22.8 months -> 18, rounded DOWN
    [2, 24],
    [3, 36],
    [3.5, 42],
    [10, 120],
  ])("%s years -> %s months at bucket 6", (years, expected) => {
    expect(bucketMonths(years, 6)).toBe(expected);
  });

  it("ALWAYS rounds down — bucketing up would inflate a worker's claim", () => {
    expect(bucketMonths(2.99, 6)).toBe(30); // 35.88 months
    expect(bucketMonths(3.0, 6)).toBe(36);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("%s becomes 0 — 'we do not know' is never a guess", (_label, value) => {
    expect(bucketMonths(value, 6)).toBe(0);
  });

  it("clamps negatives to 0", () => {
    expect(bucketMonths(-1, 6)).toBe(0);
    expect(bucketMonths(-0.5, 6)).toBe(0);
  });

  it("survives a garbage bucket dial by falling back to 1 (no bucketing)", () => {
    expect(bucketMonths(2, 0)).toBe(24);
    expect(bucketMonths(2, -6)).toBe(24);
    expect(bucketMonths(2, Number.NaN)).toBe(24);
    expect(bucketMonths(2, Number.POSITIVE_INFINITY)).toBe(24);
    // ...and never produces NaN months, which would poison every comparison.
    expect(Number.isFinite(bucketMonths(2, Number.NaN))).toBe(true);
  });

  it("honours a different bucket size", () => {
    expect(bucketMonths(2.5, 12)).toBe(24);
    expect(bucketMonths(2.5, 3)).toBe(30);
    expect(bucketMonths(2.5, 1)).toBe(30);
  });

  it("is idempotent — bucketing an already-bucketed value changes nothing", () => {
    for (const years of [0.5, 1, 1.9, 2, 3.5, 10]) {
      const once = bucketMonths(years, 6);
      expect(bucketMonthValue(once, 6)).toBe(once);
    }
  });
});

describe("bucketMonthValue", () => {
  it.each([
    [0, 0],
    [5, 0],
    [6, 6],
    [11, 6],
    [23, 18],
    [24, 24],
    [47, 42],
  ])("%s months -> %s at bucket 6", (months, expected) => {
    expect(bucketMonthValue(months, 6)).toBe(expected);
  });

  it("treats unknown / negative / non-finite as 0", () => {
    expect(bucketMonthValue(null, 6)).toBe(0);
    expect(bucketMonthValue(undefined, 6)).toBe(0);
    expect(bucketMonthValue(-12, 6)).toBe(0);
    expect(bucketMonthValue(Number.NaN, 6)).toBe(0);
  });
});
