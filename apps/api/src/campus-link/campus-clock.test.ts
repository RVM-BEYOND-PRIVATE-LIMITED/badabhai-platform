import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { assertNotAheadOfBadaBhai } from "./campus-clock";
import { CAMPUS_MAX_CLOCK_SKEW_MS } from "./campus-link.contract";

/** #2746 PR 5 — a Campus time may be at most the skew bound ahead of BadaBhai's clock. */
describe("assertNotAheadOfBadaBhai", () => {
  const NOW = Date.parse("2026-11-14T10:00:00.000Z");
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  it("is five minutes, named", () => {
    expect(CAMPUS_MAX_CLOCK_SKEW_MS).toBe(5 * 60 * 1000);
  });

  it("accepts the past, now, and up to the bound ahead (offsets included)", () => {
    expect(() => assertNotAheadOfBadaBhai("decided_at", at(-86_400_000), NOW)).not.toThrow();
    expect(() => assertNotAheadOfBadaBhai("decided_at", at(0), NOW)).not.toThrow();
    expect(() =>
      assertNotAheadOfBadaBhai("as_of", at(CAMPUS_MAX_CLOCK_SKEW_MS), NOW),
    ).not.toThrow();
    // The same instant written in IST.
    expect(() =>
      assertNotAheadOfBadaBhai("decided_at", "2026-11-14T15:34:00.000+05:30", NOW),
    ).not.toThrow();
  });

  it("refuses one millisecond past the bound with 400 VALIDATION_FAILED naming the field", () => {
    for (const field of ["decided_at", "as_of"] as const) {
      let caught: unknown;
      try {
        assertNotAheadOfBadaBhai(field, at(CAMPUS_MAX_CLOCK_SKEW_MS + 1), NOW);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as BadRequestException).getResponse()).toMatchObject({
        code: "VALIDATION_FAILED",
        issues: [{ path: field }],
      });
    }
  });

  it("refuses a value that is not a time at all (fail closed)", () => {
    expect(() => assertNotAheadOfBadaBhai("decided_at", "not-a-time", NOW)).toThrow(
      BadRequestException,
    );
  });
});
