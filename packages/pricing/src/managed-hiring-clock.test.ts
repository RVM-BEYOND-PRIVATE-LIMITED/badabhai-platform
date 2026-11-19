/**
 * #2751 item 13 — the Managed Hiring clock: week ends, holidays, month and year end, the IST day
 * boundary, and the refusals. All instants are written in IST (+05:30) so the test reads as a
 * calendar.
 */
import { describe, expect, it } from "vitest";

import { isManagedHiringWorkingDay, istDateOf, managedHiringClock } from "./managed-hiring-clock";

const ist = (local: string) => new Date(`${local}+05:30`);
const BRIEF = { workingDays: 7, extensionDays: 30 } as const;

describe("istDateOf", () => {
  it("reads the IST calendar day, not the UTC one", () => {
    // 23:59 IST on 30 Nov is 18:29 UTC the same day; 00:10 IST on 1 Dec is 18:40 UTC on 30 Nov.
    expect(istDateOf(ist("2026-11-30T23:59:00"))).toBe("2026-11-30");
    expect(istDateOf(ist("2026-12-01T00:10:00"))).toBe("2026-12-01");
  });

  it("refuses an invalid Date", () => {
    expect(() => istDateOf(new Date("nope"))).toThrow(RangeError);
  });
});

describe("isManagedHiringWorkingDay", () => {
  it("Monday to Saturday work, Sunday does not", () => {
    const none = new Set<string>();
    expect(isManagedHiringWorkingDay("2026-11-23", none)).toBe(true); // Mon
    expect(isManagedHiringWorkingDay("2026-11-28", none)).toBe(true); // Sat
    expect(isManagedHiringWorkingDay("2026-11-29", none)).toBe(false); // Sun
  });

  it("a listed holiday is not a working day", () => {
    expect(isManagedHiringWorkingDay("2026-11-24", new Set(["2026-11-24"]))).toBe(false);
  });
});

describe("managedHiringClock", () => {
  it("the issue's example: paid on a Saturday, day 1 is Monday, deadline skips Sunday", () => {
    const clock = managedHiringClock({ capturedAt: ist("2026-11-21T10:00:00"), ...BRIEF });
    expect(clock.firstWorkingDay).toBe("2026-11-23");
    // Mon 23, Tue 24, Wed 25, Thu 26, Fri 27, Sat 28, (Sun 29 off), Mon 30.
    expect(clock.lastWorkingDay).toBe("2026-11-30");
    expect(clock.dueAt.toISOString()).toBe(ist("2026-12-01T00:00:00").toISOString());
    // 30 calendar days from the start of day 1: the end of Tue 22 Dec.
    expect(clock.extensionEndsAt.toISOString()).toBe(ist("2026-12-23T00:00:00").toISOString());
  });

  it("a payment on a working day still starts the clock the NEXT working day", () => {
    const clock = managedHiringClock({ capturedAt: ist("2026-11-23T09:00:00"), ...BRIEF });
    expect(clock.firstWorkingDay).toBe("2026-11-24");
    expect(clock.lastWorkingDay).toBe("2026-12-01");
  });

  it("a payment just before IST midnight counts on that day; just after, on the next", () => {
    const late = managedHiringClock({ capturedAt: ist("2026-11-27T23:59:59"), ...BRIEF });
    const early = managedHiringClock({ capturedAt: ist("2026-11-28T00:00:01"), ...BRIEF });
    expect(late.firstWorkingDay).toBe("2026-11-28"); // Fri → Sat
    expect(early.firstWorkingDay).toBe("2026-11-30"); // Sat → Mon (Sun off)
  });

  it("crosses a month end and a year end", () => {
    const clock = managedHiringClock({ capturedAt: ist("2026-12-26T12:00:00"), ...BRIEF });
    // Sat 26 → Mon 28 Dec; Mon 28, Tue 29, Wed 30, Thu 31, Fri 1 Jan, Sat 2, (Sun 3), Mon 4.
    expect(clock.firstWorkingDay).toBe("2026-12-28");
    expect(clock.lastWorkingDay).toBe("2027-01-04");
    expect(clock.extensionEndsAt.toISOString()).toBe(ist("2027-01-27T00:00:00").toISOString());
  });

  it("handles February's month end (28 days)", () => {
    const clock = managedHiringClock({ capturedAt: ist("2027-02-25T15:00:00"), ...BRIEF });
    // Thu 25 → Fri 26; Fri 26, Sat 27, (Sun 28), Mon 1 Mar … Fri 5 Mar.
    expect(clock.firstWorkingDay).toBe("2027-02-26");
    expect(clock.lastWorkingDay).toBe("2027-03-05");
  });

  it("skips holidays on top of Sundays, including a holiday on day 1", () => {
    const clock = managedHiringClock({
      capturedAt: ist("2026-11-21T10:00:00"),
      ...BRIEF,
      holidays: ["2026-11-23", "2026-11-26"],
    });
    // Mon 23 off → day 1 Tue 24; Tue 24, Wed 25, (Thu 26 off), Fri 27, Sat 28, (Sun), Mon 30,
    // Tue 1, Wed 2.
    expect(clock.firstWorkingDay).toBe("2026-11-24");
    expect(clock.lastWorkingDay).toBe("2026-12-02");
    expect(clock.extensionEndsAt.toISOString()).toBe(ist("2026-12-24T00:00:00").toISOString());
  });

  it("an empty holiday list is the same as none", () => {
    const a = managedHiringClock({ capturedAt: ist("2026-11-21T10:00:00"), ...BRIEF });
    const b = managedHiringClock({
      capturedAt: ist("2026-11-21T10:00:00"),
      ...BRIEF,
      holidays: [],
    });
    expect(b).toEqual(a);
  });

  it("the extension never ends before the deadline", () => {
    const clock = managedHiringClock({
      capturedAt: ist("2026-11-21T10:00:00"),
      workingDays: 7,
      extensionDays: 3,
    });
    expect(clock.extensionEndsAt.getTime()).toBe(clock.dueAt.getTime());
  });

  it("one working day: the deadline is the end of day 1", () => {
    const clock = managedHiringClock({
      capturedAt: ist("2026-11-23T10:00:00"),
      workingDays: 1,
      extensionDays: 1,
    });
    expect(clock.firstWorkingDay).toBe("2026-11-24");
    expect(clock.lastWorkingDay).toBe("2026-11-24");
    expect(clock.dueAt.toISOString()).toBe(ist("2026-11-25T00:00:00").toISOString());
  });

  it("refuses bad input rather than guess a deadline", () => {
    const capturedAt = ist("2026-11-21T10:00:00");
    expect(() => managedHiringClock({ capturedAt, workingDays: 0, extensionDays: 30 })).toThrow(
      RangeError,
    );
    expect(() => managedHiringClock({ capturedAt, workingDays: 7, extensionDays: 0 })).toThrow(
      RangeError,
    );
    expect(() => managedHiringClock({ capturedAt, ...BRIEF, holidays: ["2026-02-30"] })).toThrow(
      RangeError,
    );
    expect(() => managedHiringClock({ capturedAt: new Date("nope"), ...BRIEF })).toThrow(
      RangeError,
    );
  });

  it("fails loud, never loops, when the holiday list leaves no working day in reach", () => {
    const capturedAt = ist("2026-11-21T10:00:00");
    // Every day for the next 401 days is a holiday.
    const holidays = Array.from({ length: 401 }, (_, i) =>
      istDateOf(new Date(capturedAt.getTime() + (i + 1) * 86_400_000)),
    );
    expect(() => managedHiringClock({ capturedAt, ...BRIEF, holidays })).toThrow(/no working day/);
  });
});
