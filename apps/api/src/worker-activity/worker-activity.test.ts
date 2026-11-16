import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOT_RECENTLY_ACTIVE_DAYS,
  daysBetween,
  isNotRecentlyActive,
  istDayOf,
  lastActiveDayOf,
  workerActivityEnabled,
} from "./worker-activity";

/**
 * #2753 items 4 and 7 — the pure rules: which IST day an instant is, the one definition of the
 * last active day, and the "not recently active" boundary.
 */
describe("workerActivityEnabled — the one read of the switch", () => {
  it("only `true` is on; false, a missing key and a missing config are off", () => {
    expect(
      workerActivityEnabled({ WORKER_ACTIVITY_ENABLED: true, NOT_RECENTLY_ACTIVE_DAYS: 90 }),
    ).toBe(true);
    expect(
      workerActivityEnabled({ WORKER_ACTIVITY_ENABLED: false, NOT_RECENTLY_ACTIVE_DAYS: 90 }),
    ).toBe(false);
    expect(workerActivityEnabled({} as never)).toBe(false);
    expect(workerActivityEnabled(undefined)).toBe(false);
  });
});

describe("istDayOf — the Asia/Kolkata calendar day", () => {
  it("turns over at 18:30 UTC (IST midnight), not at UTC midnight", () => {
    expect(istDayOf(new Date("2026-11-15T18:29:59.999Z"))).toBe("2026-11-15");
    expect(istDayOf(new Date("2026-11-15T18:30:00.000Z"))).toBe("2026-11-16");
    // 00:10 UTC is already 05:40 IST of the same calendar day.
    expect(istDayOf(new Date("2026-11-16T00:10:00.000Z"))).toBe("2026-11-16");
  });
});

describe("lastActiveDayOf — the later of the table's day and the device sighting", () => {
  const NOW = new Date("2026-11-16T06:00:00.000Z");

  it("takes the table's day when it is later (he used the app after his last sign-in)", () => {
    expect(lastActiveDayOf("2026-11-10", "2026-08-01T10:00:00.000Z", NOW)).toBe("2026-11-10");
  });

  it("takes the device day when it is later (history from before the table, or the switch off)", () => {
    expect(lastActiveDayOf("2026-09-01", "2026-11-12T10:00:00.000Z", NOW)).toBe("2026-11-12");
  });

  it("reads the device time as an IST day: 19:00 UTC is the next day in India", () => {
    expect(lastActiveDayOf(null, "2026-11-12T19:00:00.000Z", NOW)).toBe("2026-11-13");
    expect(lastActiveDayOf("2026-11-12", new Date("2026-11-12T19:00:00.000Z"), NOW)).toBe(
      "2026-11-13",
    );
  });

  it("either one alone is the day; neither is null", () => {
    expect(lastActiveDayOf("2026-11-01", null, NOW)).toBe("2026-11-01");
    expect(lastActiveDayOf(null, "2026-11-01T03:00:00.000Z", NOW)).toBe("2026-11-01");
    expect(lastActiveDayOf(null, null, NOW)).toBeNull();
  });

  it("a malformed table day is ignored, never compared as a string", () => {
    expect(lastActiveDayOf("16/11/2026", null, NOW)).toBeNull();
    expect(lastActiveDayOf("garbage", "2026-11-01T03:00:00.000Z", NOW)).toBe("2026-11-01");
  });

  it("a device time in the future (clock skew) reads as today, never a day to come", () => {
    expect(lastActiveDayOf(null, "2027-01-01T00:00:00.000Z", NOW)).toBe("2026-11-16");
  });
});

describe("isNotRecentlyActive — the item 7 boundary", () => {
  const TODAY = "2026-11-16";

  it("defaults to the owner's 90 days", () => {
    expect(DEFAULT_NOT_RECENTLY_ACTIVE_DAYS).toBe(90);
  });

  it("day 90 without activity is NOT marked; day 91 is", () => {
    // 2026-08-18 is 90 days before 2026-11-16; 2026-08-17 is 91.
    expect(daysBetween("2026-08-18", TODAY)).toBe(90);
    expect(isNotRecentlyActive("2026-08-18", TODAY, 90)).toBe(false);
    expect(daysBetween("2026-08-17", TODAY)).toBe(91);
    expect(isNotRecentlyActive("2026-08-17", TODAY, 90)).toBe(true);
  });

  it("active today, or yesterday, is never marked", () => {
    expect(isNotRecentlyActive(TODAY, TODAY, 90)).toBe(false);
    expect(isNotRecentlyActive("2026-11-15", TODAY, 90)).toBe(false);
  });

  it("no last active day at all is NOT marked (never seen is not 'gone quiet')", () => {
    expect(isNotRecentlyActive(null, TODAY, 90)).toBe(false);
    expect(isNotRecentlyActive(undefined, TODAY, 90)).toBe(false);
    expect(isNotRecentlyActive("not-a-day", TODAY, 90)).toBe(false);
  });

  it("honours a custom setting: 30 days marks day 31, not day 30", () => {
    expect(isNotRecentlyActive("2026-10-17", TODAY, 30)).toBe(false);
    expect(isNotRecentlyActive("2026-10-16", TODAY, 30)).toBe(true);
    // ...and the same day is not marked under the default.
    expect(isNotRecentlyActive("2026-10-16", TODAY, 90)).toBe(false);
  });

  it("counts calendar days across a month and a year end", () => {
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
  });
});
