import { describe, expect, it } from "vitest";
import {
  calendarMonthsBetween,
  calendarMonthsOf,
  computeIndustryTenure,
  mergeIntervals,
  tenureFor,
} from "./tenure";
import type { WorkerSkillRow } from "./types";

const MFG = "ind_industrial_manufacturing";
const QCOM = "ind_quick_commerce";

function row(skillId: string, monthsBucketed: number, industryId = MFG): WorkerSkillRow {
  return {
    skillId: skillId as WorkerSkillRow["skillId"],
    industryId: industryId as WorkerSkillRow["industryId"],
    monthsBucketed,
    wants: true,
    startedAt: null,
    endedAt: null,
  };
}

describe("computeIndustryTenure", () => {
  it("uses the bucketed total when it is the larger number", () => {
    const tenure = computeIndustryTenure([row("mskill_vmc_operator", 12)], 5, 6);
    expect(tenureFor(tenure, MFG)).toBe(60);
  });

  it("CLAMPS UP to the longest skill row in that industry (E8, by construction)", () => {
    const tenure = computeIndustryTenure([row("mskill_vmc_operator", 36)], 2, 6);
    expect(tenureFor(tenure, MFG)).toBe(36);
  });

  it("keeps industries separate", () => {
    const tenure = computeIndustryTenure(
      [row("mskill_cnc_turner", 24), row("mskill_delivery_rider", 18, QCOM)],
      null,
      6,
    );
    expect(tenureFor(tenure, MFG)).toBe(24);
    expect(tenureFor(tenure, QCOM)).toBe(18);
  });

  it("takes the MAX across rows within one industry, never the sum", () => {
    const tenure = computeIndustryTenure(
      [row("mskill_cnc_turner", 24), row("mskill_vmc_operator", 18)],
      null,
      6,
    );
    expect(tenureFor(tenure, MFG)).toBe(24);
  });

  it("an industry with no rows is 0, not a guess", () => {
    const tenure = computeIndustryTenure([row("mskill_cnc_turner", 24)], 3, 6);
    expect(tenureFor(tenure, QCOM)).toBe(0);
    expect(tenure.has(QCOM)).toBe(false);
  });

  it("counts history the worker no longer wants — tenure is history, not supply", () => {
    const tenure = computeIndustryTenure(
      [{ ...row("mskill_vmc_operator", 48), wants: false }],
      null,
      6,
    );
    expect(tenureFor(tenure, MFG)).toBe(48);
  });

  it("treats a corrupt row as 0 months rather than propagating NaN", () => {
    const tenure = computeIndustryTenure(
      [row("mskill_vmc_operator", Number.NaN), row("mskill_cnc_turner", -12)],
      null,
      6,
    );
    expect(tenureFor(tenure, MFG)).toBe(0);
  });

  it("no rows means no industries", () => {
    expect(computeIndustryTenure([], 5, 6).size).toBe(0);
  });
});

describe("calendarMonthsBetween", () => {
  it.each([
    ["2020-01-01", "2022-01-01", 24],
    ["2020-01-01", "2020-01-31", 0], // a partial month does not count
    ["2020-01-15", "2020-02-14", 0],
    ["2020-01-15", "2020-02-15", 1],
    ["2020-01-31", "2021-01-01", 11],
  ])("%s -> %s is %s months", (start, end, expected) => {
    expect(calendarMonthsBetween(start, end)).toBe(expected);
  });

  it("never returns a negative number", () => {
    expect(calendarMonthsBetween("2022-01-01", "2020-01-01")).toBe(0);
  });

  it("returns 0 for unparseable input rather than throwing", () => {
    expect(calendarMonthsBetween("yesterday", "2020-01-01")).toBe(0);
    expect(calendarMonthsBetween("2020-13-01", "2021-01-01")).toBe(0);
    expect(calendarMonthsBetween("", "")).toBe(0);
  });

  it("accepts a full ISO timestamp and reads only the date part", () => {
    expect(calendarMonthsBetween("2020-01-01T09:30:00.000Z", "2021-01-01T23:00:00.000Z")).toBe(12);
  });
});

describe("mergeIntervals", () => {
  it("merges overlapping stints", () => {
    expect(
      mergeIntervals([
        { start: "2020-01-01", end: "2021-07-01" },
        { start: "2021-01-01", end: "2022-01-01" },
      ]),
    ).toEqual([{ start: "2020-01-01", end: "2022-01-01" }]);
  });

  it("merges touching stints", () => {
    expect(
      mergeIntervals([
        { start: "2020-01-01", end: "2020-07-01" },
        { start: "2020-07-01", end: "2021-01-01" },
      ]),
    ).toEqual([{ start: "2020-01-01", end: "2021-01-01" }]);
  });

  it("keeps genuinely disjoint stints apart", () => {
    const disjoint = [
      { start: "2018-01-01", end: "2019-01-01" },
      { start: "2021-01-01", end: "2022-01-01" },
    ];
    expect(mergeIntervals(disjoint)).toEqual(disjoint);
  });

  it("absorbs a contained stint", () => {
    expect(
      mergeIntervals([
        { start: "2020-01-01", end: "2024-01-01" },
        { start: "2021-01-01", end: "2022-01-01" },
      ]),
    ).toEqual([{ start: "2020-01-01", end: "2024-01-01" }]);
  });

  it("an open-ended stint swallows everything after it", () => {
    expect(
      mergeIntervals([
        { start: "2020-01-01", end: null },
        { start: "2021-01-01", end: "2022-01-01" },
        { start: "2030-01-01", end: "2031-01-01" },
      ]),
    ).toEqual([{ start: "2020-01-01", end: null }]);
  });

  it("DROPS a stint that ends before it starts — counting it would credit negative time", () => {
    expect(mergeIntervals([{ start: "2022-01-01", end: "2020-01-01" }])).toEqual([]);
  });

  it("drops unparseable stints instead of throwing", () => {
    expect(
      mergeIntervals([
        { start: "not-a-date", end: "2020-01-01" },
        { start: "2020-01-01", end: "2021-01-01" },
      ]),
    ).toEqual([{ start: "2020-01-01", end: "2021-01-01" }]);
  });

  it("is order-independent and idempotent", () => {
    const stints = [
      { start: "2021-01-01", end: "2022-01-01" },
      { start: "2018-01-01", end: "2019-01-01" },
      { start: "2021-06-01", end: "2023-01-01" },
    ];
    const merged = mergeIntervals(stints);
    expect(mergeIntervals([...stints].reverse())).toEqual(merged);
    expect(mergeIntervals(merged)).toEqual(merged);
    expect(merged).toEqual([
      { start: "2018-01-01", end: "2019-01-01" },
      { start: "2021-01-01", end: "2023-01-01" },
    ]);
  });

  it("handles the empty case", () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe("calendarMonthsOf", () => {
  it("counts an overlap ONCE", () => {
    expect(
      calendarMonthsOf([
        { start: "2020-01-01", end: "2022-01-01" },
        { start: "2020-01-01", end: "2022-01-01" },
      ]),
    ).toBe(24);
  });

  it("sums disjoint stints", () => {
    expect(
      calendarMonthsOf([
        { start: "2018-01-01", end: "2019-01-01" },
        { start: "2021-01-01", end: "2022-01-01" },
      ]),
    ).toBe(24);
  });

  it("an ongoing stint contributes 0 without an explicit asOf — the package has no clock", () => {
    const ongoing = [{ start: "2020-01-01", end: null }];
    expect(calendarMonthsOf(ongoing)).toBe(0);
    expect(calendarMonthsOf(ongoing, null)).toBe(0);
    expect(calendarMonthsOf(ongoing, "not-a-date")).toBe(0);
    expect(calendarMonthsOf(ongoing, "2023-01-01")).toBe(36);
  });

  it("is 0 for no stints", () => {
    expect(calendarMonthsOf([])).toBe(0);
  });
});
