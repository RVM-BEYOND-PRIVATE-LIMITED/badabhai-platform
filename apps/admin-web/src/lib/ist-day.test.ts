import { describe, expect, it } from "vitest";
import { isCalendarDay, istDayEnd, istDayStart } from "./ist-day";

/**
 * The Events date range (A4, #2574): two IST days, both inclusive. The API compares instants
 * (`occurred_at >= occurredFrom`, `<= occurredTo`), so a day becomes its first or last IST instant.
 */
describe("isCalendarDay", () => {
  it("accepts a YYYY-MM-DD day that exists", () => {
    expect(isCalendarDay("2026-11-01")).toBe(true);
    expect(isCalendarDay("2028-02-29")).toBe(true);
  });

  it("refuses a day the calendar does not have, and anything that is not a day", () => {
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay("2026-13-01")).toBe(false);
    expect(isCalendarDay("2026-11-1")).toBe(false);
    expect(isCalendarDay("2026-11-01T00:00")).toBe(false);
    expect(isCalendarDay("yesterday")).toBe(false);
    expect(isCalendarDay("")).toBe(false);
    expect(isCalendarDay(undefined)).toBe(false);
  });
});

describe("the IST bounds of a day", () => {
  it("from: the day's first instant in IST — 18:30 UTC the evening before", () => {
    expect(istDayStart("2026-11-01")).toBe("2026-11-01T00:00:00.000+05:30");
    expect(new Date(istDayStart("2026-11-01")).toISOString()).toBe("2026-10-31T18:30:00.000Z");
  });

  it("to: the day's last instant in IST, so the whole of that day is in range", () => {
    expect(istDayEnd("2026-11-03")).toBe("2026-11-03T23:59:59.999+05:30");
    expect(new Date(istDayEnd("2026-11-03")).toISOString()).toBe("2026-11-03T18:29:59.999Z");
  });

  it("an event at 11pm IST on the last day is inside the range; one a millisecond later is not", () => {
    const end = new Date(istDayEnd("2026-11-03")).getTime();
    expect(new Date("2026-11-03T23:00:00+05:30").getTime()).toBeLessThanOrEqual(end);
    expect(new Date("2026-11-04T00:00:00+05:30").getTime()).toBeGreaterThan(end);
  });
});
