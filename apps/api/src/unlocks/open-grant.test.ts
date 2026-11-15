import { describe, expect, it } from "vitest";
import { isOpenGrant, needsOpenForGoodDate, OPEN_FOR_GOOD_UNTIL, openUntilOf } from "./open-grant";

/** #2747 (ADR-0064 §3.4) — the one definition of an open contact. */
describe("isOpenGrant", () => {
  const NOW = new Date("2026-11-15T12:00:00.000Z");
  const LAPSED = new Date("2026-11-01T00:00:00.000Z");
  const LATER = new Date("2026-11-20T00:00:00.000Z");

  it("rule off: granted or revealed, and unexpired (the old window)", () => {
    expect(
      isOpenGrant({ status: "granted", expiresAt: LATER }, { openForGood: false, now: NOW }),
    ).toBe(true);
    expect(
      isOpenGrant({ status: "revealed", expiresAt: LATER }, { openForGood: false, now: NOW }),
    ).toBe(true);
    expect(
      isOpenGrant({ status: "granted", expiresAt: LAPSED }, { openForGood: false, now: NOW }),
    ).toBe(false);
    expect(
      isOpenGrant({ status: "granted", expiresAt: NOW }, { openForGood: false, now: NOW }),
    ).toBe(false);
    expect(
      isOpenGrant({ status: "granted", expiresAt: null }, { openForGood: false, now: NOW }),
    ).toBe(false);
  });

  it("rule on: granted or revealed, whatever the date (past opens honoured)", () => {
    expect(
      isOpenGrant({ status: "granted", expiresAt: LAPSED }, { openForGood: true, now: NOW }),
    ).toBe(true);
    expect(
      isOpenGrant({ status: "revealed", expiresAt: null }, { openForGood: true, now: NOW }),
    ).toBe(true);
  });

  it("never opens a row that was not a grant, whatever the rule", () => {
    for (const status of ["requested", "denied", "expired", "revoked"]) {
      for (const openForGood of [true, false]) {
        expect(isOpenGrant({ status, expiresAt: LATER }, { openForGood, now: NOW })).toBe(false);
      }
    }
  });
});

describe("needsOpenForGoodDate and openUntilOf", () => {
  it("only a date short of 'for good' needs the stored date moved", () => {
    expect(
      needsOpenForGoodDate({ status: "granted", expiresAt: new Date("2026-11-01T00:00:00Z") }),
    ).toBe(true);
    expect(needsOpenForGoodDate({ status: "granted", expiresAt: null })).toBe(true);
    expect(needsOpenForGoodDate({ status: "granted", expiresAt: OPEN_FOR_GOOD_UNTIL })).toBe(false);
  });

  it("open_until is null for good, else the window's end", () => {
    const end = new Date("2026-11-29T00:00:00.000Z");
    expect(openUntilOf(true, OPEN_FOR_GOOD_UNTIL)).toBeNull();
    expect(openUntilOf(false, end)).toBe(end.toISOString());
  });

  it("the for-good date is one a shipped client can parse", () => {
    expect(Number.isNaN(Date.parse(OPEN_FOR_GOOD_UNTIL.toISOString()))).toBe(false);
    expect(OPEN_FOR_GOOD_UNTIL.toISOString()).toBe("2099-12-31T23:59:59.000Z");
  });
});
