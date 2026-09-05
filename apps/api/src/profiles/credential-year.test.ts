import { describe, expect, it, vi } from "vitest";

import { CREDENTIAL_YEAR_FLOOR, credentialYearSchema, currentYear } from "./credential-year";
import { SetMyPreferencesSchema } from "./worker-preferences.dto";

/**
 * THE AWARD-YEAR CEILING (#1407).
 *
 * WHAT WAS WRONG. Both `credentialYear` and `education_year` were `.min(1950).max(2100)`, while
 * both doc comments said the rule was "a year IN THE FUTURE or before living memory is a typo".
 * A fixed 2100 does not implement "in the future" — it accepted 2099 — and it would not have
 * implemented it at any point in this platform's life.
 *
 * WHY THE INTERESTING TEST IS THE ONE ABOUT THE CLOCK. Swapping `.max(2100)` for
 * `.max(new Date().getFullYear())` read ONCE at import would pass every naive test written today
 * and then reject the current year's certificates from every 1 January until the next deploy —
 * rejecting TRUE statements, on a date nobody is deploying. `movesWithTheClock` below is the
 * assertion that separates the two implementations, and it is the reason `currentYear` takes an
 * injectable `now`.
 */
describe("credential award year", () => {
  const thisYear = currentYear();

  it("accepts the current year — a certificate can be dated the year it is issued", () => {
    expect(credentialYearSchema.safeParse(thisYear).success).toBe(true);
  });

  it("refuses next year", () => {
    expect(credentialYearSchema.safeParse(thisYear + 1).success).toBe(false);
  });

  it("refuses 2099 — the row the old fixed ceiling let through", () => {
    // CATCHES a revert to `.max(2100)`. Under the old bound this parsed cleanly and a worker
    // could print an ITI certificate dated 2099 beside a real one.
    expect(credentialYearSchema.safeParse(2099).success).toBe(false);
  });

  it("floors at 1950 and refuses 1949", () => {
    expect(credentialYearSchema.safeParse(CREDENTIAL_YEAR_FLOOR).success).toBe(true);
    expect(credentialYearSchema.safeParse(CREDENTIAL_YEAR_FLOOR - 1).success).toBe(false);
  });

  it("refuses a non-integer year", () => {
    expect(credentialYearSchema.safeParse(2019.5).success).toBe(false);
  });

  it("MOVES WITH THE CLOCK — the SCHEMA's ceiling is read per parse, not frozen at import", () => {
    // CATCHES the module-level `const CEILING = new Date().getFullYear()` implementation, which
    // is the obvious way to write this and is wrong every January: it would refuse the current
    // year's certificates from 1 January until the next deploy — rejecting TRUE statements, on a
    // date nobody is deploying.
    //
    // ASSERTED BY MOVING THE SYSTEM CLOCK, not by calling `currentYear(now)` with an argument.
    // The injectable form proves only that the helper reads its input; it says nothing about
    // whether the schema calls it again on the next parse. This is the difference, and it is the
    // whole reason the refinement exists instead of a `.max()`.
    const future = 2031;
    expect(credentialYearSchema.safeParse(future).success).toBe(false);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(`${future}-06-15T00:00:00Z`));
      expect(credentialYearSchema.safeParse(future).success).toBe(true);
      expect(credentialYearSchema.safeParse(future + 1).success).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    // And back, on the same module instance — a frozen ceiling could not do this either.
    expect(credentialYearSchema.safeParse(future).success).toBe(false);
  });

  it("currentYear reads the date it is given", () => {
    expect(currentYear(new Date("2031-06-15T00:00:00Z"))).toBe(2031);
    expect(currentYear(new Date("2032-01-01T00:00:00Z"))).toBe(2032);
  });

  /**
   * THE POINT OF THE SHARED MODULE. The bug was two literals that agreed with each other and
   * disagreed with their own stated rule, so the regression to guard is "one caller is fixed and
   * the other is not". Asserted through the real `SetMyPreferencesSchema`, not through the
   * exported schema, because that is the surface a client actually posts to.
   */
  describe("both callers use it", () => {
    it("education_year on the preferences form refuses a future year", () => {
      expect(SetMyPreferencesSchema.safeParse({ education_year: thisYear }).success).toBe(true);
      expect(SetMyPreferencesSchema.safeParse({ education_year: thisYear + 1 }).success).toBe(
        false,
      );
      expect(SetMyPreferencesSchema.safeParse({ education_year: 2099 }).success).toBe(false);
    });

    it("education_year still accepts null — 'no year given' stays a legal answer", () => {
      // `.nullable()` must short-circuit the refinement rather than run it against null.
      expect(SetMyPreferencesSchema.safeParse({ education_year: null }).success).toBe(true);
    });
  });
});
