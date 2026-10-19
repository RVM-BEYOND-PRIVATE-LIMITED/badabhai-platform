import { describe, expect, it } from "vitest";

import { formatDurationMonths } from "./format-duration-months";

describe("formatDurationMonths", () => {
  it.each([
    [36, "3 years"],
    [42, "3 years 6 months"],
    [12, "1 year"],
    [13, "1 year 1 month"],
    [6, "6 months"],
    [1, "1 month"],
    [24, "2 years"],
    [25, "2 years 1 month"],
    [11, "11 months"],
  ])("formats %s months as %s", (months, expected) => {
    expect(formatDurationMonths(months)).toBe(expected);
  });

  it.each([0, -3, null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns empty for %s",
    (months) => {
      expect(formatDurationMonths(months as number | null)).toBe("");
    },
  );

  it("rounds a fractional input to the nearest month first", () => {
    expect(formatDurationMonths(42.4)).toBe("3 years 6 months");
    expect(formatDurationMonths(12.6)).toBe("1 year 1 month");
  });
});
