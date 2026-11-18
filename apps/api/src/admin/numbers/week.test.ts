import { describe, expect, it } from "vitest";
import {
  NUMBERS_MAX_WEEKS_LISTED,
  NUMBERS_WEEK_RULE,
  assertWeekStart,
  isWeekStart,
  nextWeek,
  previousWeek,
  weekEndDayOf,
  weekRange,
  weekStartOf,
  weeksBetween,
} from "./week";

/** #2755 item 1 — the week is Monday to Sunday, India time, named by its Monday. */

const at = (iso: string) => new Date(iso);

describe("weekStartOf — the IST Monday of an instant", () => {
  it("the IST/UTC midnight edge: Sunday 18:29:59.999Z is still Sunday, 18:30:00Z is Monday", () => {
    // 2026-11-22 is a Sunday. 18:29:59.999 UTC is 23:59:59.999 IST on that Sunday.
    expect(weekStartOf(at("2026-11-22T18:29:59.999Z"))).toBe("2026-11-16");
    expect(weekStartOf(at("2026-11-22T18:29:59Z"))).toBe("2026-11-16");
    // 18:30:00 UTC is Monday 2026-11-23 00:00 IST: the next week.
    expect(weekStartOf(at("2026-11-22T18:30:00.000Z"))).toBe("2026-11-23");
    expect(weekStartOf(at("2026-11-22T18:30:00.001Z"))).toBe("2026-11-23");
  });

  it("a UTC Monday before 18:30 that is already Monday in India stays in the new week", () => {
    expect(weekStartOf(at("2026-11-23T00:00:00Z"))).toBe("2026-11-23");
    expect(weekStartOf(at("2026-11-23T18:29:59Z"))).toBe("2026-11-23");
    // …and a UTC Sunday 23:00 is already Monday 04:30 IST.
    expect(weekStartOf(at("2026-11-29T23:00:00Z"))).toBe("2026-11-30");
  });

  it("every day of one week maps to its Monday", () => {
    // Monday 2026-11-30 00:00 IST is 2026-11-29T18:30Z; step 7 days in 6-hour moves.
    const from = Date.parse("2026-11-29T18:30:00Z");
    for (let ms = from; ms < from + 7 * 24 * 3600 * 1000; ms += 6 * 3600 * 1000) {
      expect(weekStartOf(new Date(ms)), new Date(ms).toISOString()).toBe("2026-11-30");
    }
    expect(weekStartOf(new Date(from - 1))).toBe("2026-11-23");
    expect(weekStartOf(new Date(from + 7 * 24 * 3600 * 1000))).toBe("2026-12-07");
  });

  it("year boundaries: the week that spans New Year is named by its December Monday", () => {
    // 2026-12-28 is a Monday; 2027-01-03 a Sunday.
    expect(weekStartOf(at("2026-12-31T12:00:00Z"))).toBe("2026-12-28");
    expect(weekStartOf(at("2027-01-01T00:00:00Z"))).toBe("2026-12-28");
    expect(weekStartOf(at("2027-01-03T18:29:59Z"))).toBe("2026-12-28");
    expect(weekStartOf(at("2027-01-03T18:30:00Z"))).toBe("2027-01-04");
    // New Year's Eve 18:30 UTC is already 1 January in India (a Thursday in 2026).
    expect(weekStartOf(at("2025-12-31T18:30:00Z"))).toBe("2025-12-29");
    expect(weekStartOf(at("2025-12-31T18:29:59Z"))).toBe("2025-12-29");
    // 2024-12-30 is a Monday: a week that starts in one year and holds 1 January of the next.
    expect(weekStartOf(at("2025-01-01T06:00:00Z"))).toBe("2024-12-30");
  });

  it("leap day and month ends", () => {
    expect(weekStartOf(at("2028-02-29T10:00:00Z"))).toBe("2028-02-28");
    expect(weekStartOf(at("2028-03-01T10:00:00Z"))).toBe("2028-02-28");
    expect(weekStartOf(at("2027-03-01T10:00:00Z"))).toBe("2027-03-01");
  });

  it("refuses an invalid Date", () => {
    expect(() => weekStartOf(new Date("nope"))).toThrow(RangeError);
  });
});

describe("weekRange — the half-open UTC interval of a week", () => {
  it("Monday 00:00 IST to the next Monday 00:00 IST, as UTC", () => {
    const { fromUtc, toUtcExclusive } = weekRange("2026-11-23");
    expect(fromUtc.toISOString()).toBe("2026-11-22T18:30:00.000Z");
    expect(toUtcExclusive.toISOString()).toBe("2026-11-29T18:30:00.000Z");
    expect(toUtcExclusive.getTime() - fromUtc.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("agrees with weekStartOf on both edges (no instant falls between two weeks)", () => {
    for (const week of ["2026-11-30", "2026-12-28", "2027-01-25", "2028-02-28"]) {
      const { fromUtc, toUtcExclusive } = weekRange(week);
      expect(weekStartOf(fromUtc)).toBe(week);
      expect(weekStartOf(new Date(toUtcExclusive.getTime() - 1))).toBe(week);
      expect(weekStartOf(toUtcExclusive)).toBe(nextWeek(week));
    }
  });

  it("across the year boundary", () => {
    const { fromUtc, toUtcExclusive } = weekRange("2026-12-28");
    expect(fromUtc.toISOString()).toBe("2026-12-27T18:30:00.000Z");
    expect(toUtcExclusive.toISOString()).toBe("2027-01-03T18:30:00.000Z");
  });

  it("refuses a day that is not a Monday, a malformed day and an impossible date", () => {
    for (const bad of ["2026-11-24", "2026-11-22", "2026-11-3", "2026-02-30", "", "monday"]) {
      expect(() => weekRange(bad), bad).toThrow(RangeError);
    }
  });
});

describe("previousWeek / nextWeek / weekEndDayOf", () => {
  it("step seven days, across month and year ends", () => {
    expect(previousWeek("2026-11-30")).toBe("2026-11-23");
    expect(previousWeek("2027-01-04")).toBe("2026-12-28");
    expect(nextWeek("2026-12-28")).toBe("2027-01-04");
    expect(previousWeek("2028-03-06")).toBe("2028-02-28");
    expect(weekEndDayOf("2026-12-28")).toBe("2027-01-03");
    expect(weekEndDayOf("2027-01-25")).toBe("2027-01-31");
  });

  it("refuse a non-Monday", () => {
    expect(() => previousWeek("2026-12-01")).toThrow(RangeError);
    expect(() => nextWeek("2026-12-01")).toThrow(RangeError);
    expect(() => weekEndDayOf("2026-12-01")).toThrow(RangeError);
  });
});

describe("weeksBetween — the inclusive series", () => {
  it("the January target: eight weeks of growth ending Sunday 31 January need nine weeks", () => {
    const weeks = weeksBetween("2026-11-30", "2027-01-25");
    expect(weeks).toHaveLength(9);
    expect(weeks[0]).toBe("2026-11-30");
    expect(weeks.at(-1)).toBe("2027-01-25");
    expect(weekEndDayOf(weeks.at(-1)!)).toBe("2027-01-31");
    expect(weeks).toContain("2026-12-28");
    expect(weeks).toContain("2027-01-04");
    for (const w of weeks) expect(isWeekStart(w)).toBe(true);
  });

  it("one week for equal bounds; refuses a reversed range and an over-long span", () => {
    expect(weeksBetween("2026-11-30", "2026-11-30")).toEqual(["2026-11-30"]);
    expect(() => weeksBetween("2026-12-07", "2026-11-30")).toThrow(RangeError);
    expect(() => weeksBetween("2000-01-03", "2026-11-30")).toThrow(/over/);
    expect(weeksBetween("2026-11-30", "2026-11-30").length).toBeLessThanOrEqual(
      NUMBERS_MAX_WEEKS_LISTED,
    );
  });
});

describe("isWeekStart / assertWeekStart / the rule text", () => {
  it("accepts a real Monday only", () => {
    expect(isWeekStart("2026-11-30")).toBe(true);
    expect(isWeekStart("2026-11-29")).toBe(false);
    expect(isWeekStart("2026-13-01")).toBe(false);
    expect(isWeekStart(20261130)).toBe(false);
    expect(isWeekStart(null)).toBe(false);
    expect(() => assertWeekStart("2026-11-29")).toThrow(RangeError);
  });

  it("the served rule names the days, the zone and the boundary", () => {
    expect(NUMBERS_WEEK_RULE).toMatch(/Monday 00:00/);
    expect(NUMBERS_WEEK_RULE).toMatch(/Sunday 23:59:59/);
    expect(NUMBERS_WEEK_RULE).toMatch(/UTC\+5:30/);
    expect(NUMBERS_WEEK_RULE).toMatch(/18:30:00 UTC/);
  });
});
