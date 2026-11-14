import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { assertCampusTime } from "./campus-clock";
import { CAMPUS_EARLIEST_DECISION_TIME, CAMPUS_MAX_CLOCK_SKEW_MS } from "./campus-link.contract";

/** #2746 PR 5 — a Campus time must be orderable and storable: after the floor, not from the future. */
describe("assertCampusTime", () => {
  const NOW = Date.parse("2026-11-14T10:00:00.000Z");
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  function refusal(field: "decided_at" | "as_of", value: string): unknown {
    try {
      assertCampusTime(field, value, NOW);
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it("is a 60-second skew bound and a 2026-01-01 floor, both named", () => {
    expect(CAMPUS_MAX_CLOCK_SKEW_MS).toBe(60 * 1000);
    expect(CAMPUS_EARLIEST_DECISION_TIME).toBe("2026-01-01T00:00:00.000Z");
  });

  it("accepts the floor itself, the past, now, and up to the bound ahead (offsets included)", () => {
    expect(refusal("decided_at", CAMPUS_EARLIEST_DECISION_TIME)).toBeUndefined();
    expect(refusal("decided_at", at(-86_400_000))).toBeUndefined();
    expect(refusal("decided_at", at(0))).toBeUndefined();
    expect(refusal("as_of", at(CAMPUS_MAX_CLOCK_SKEW_MS))).toBeUndefined();
    // The same instant written in IST.
    expect(refusal("decided_at", "2026-11-14T15:30:30.000+05:30")).toBeUndefined();
  });

  it("refuses one millisecond past the bound with 400 VALIDATION_FAILED naming the field", () => {
    for (const field of ["decided_at", "as_of"] as const) {
      const err = refusal(field, at(CAMPUS_MAX_CLOCK_SKEW_MS + 1));
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: "VALIDATION_FAILED",
        issues: [{ path: field }],
      });
    }
  });

  it("refuses a time before the floor, year 0000 included (it parses, then fails timestamptz: 22008)", () => {
    for (const value of [
      "0000-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
      "2025-12-31T23:59:59.999Z",
      "2026-01-01T05:29:59.000+05:30",
    ]) {
      const err = refusal("decided_at", value);
      expect(err, value).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: "VALIDATION_FAILED",
        issues: [{ path: "decided_at" }],
      });
    }
  });

  it("refuses a value that is not a time at all (fail closed)", () => {
    expect(refusal("as_of", "not-a-time")).toBeInstanceOf(BadRequestException);
  });
});
