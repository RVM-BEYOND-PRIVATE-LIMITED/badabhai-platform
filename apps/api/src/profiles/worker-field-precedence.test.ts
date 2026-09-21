import { describe, expect, it } from "vitest";

import { qualificationFactsFrom } from "../resume/resume-qualification-rows";
import {
  EDUCATION_PRECEDENCE,
  resolveAvailabilityState,
  resolveCityForSummary,
  resolveSalaryBand,
  resolveSalaryPeriod,
  resolveWorkTypes,
  SKILL_SOURCE_OF_RECORD,
} from "./worker-field-precedence";

/**
 * THE PRECEDENCE RULES, PINNED (ADR-0042 D9 / Layer A (c)).
 *
 * Every expectation here is what the SHIPPED reader already does. The point of the file is not
 * that these are good rules — it is that they are the rules, in one place, and a change to any of
 * them is a change to `worker-field-precedence.ts` that this file forces into a review.
 */

describe("city ×3 — the first-party answer wins (profile-summary.mapper readCity)", () => {
  it("prefers the workers column over the profile's extracted city", () => {
    expect(
      resolveCityForSummary({
        workersColumn: "Faridabad",
        profileCurrentCity: "Rajkot",
        profilePreferredCities: ["Pune"],
      }),
    ).toBe("Faridabad");
  });

  it("falls back to the profile current_city, then to its first preferred city", () => {
    expect(
      resolveCityForSummary({
        workersColumn: null,
        profileCurrentCity: "Rajkot",
        profilePreferredCities: ["Pune"],
      }),
    ).toBe("Rajkot");
    expect(
      resolveCityForSummary({
        workersColumn: null,
        profileCurrentCity: null,
        profilePreferredCities: ["Pune", "Nashik"],
      }),
    ).toBe("Pune");
  });

  it("treats blank as absence at every level", () => {
    expect(
      resolveCityForSummary({
        workersColumn: "   ",
        profileCurrentCity: "",
        profilePreferredCities: ["", "Nashik"],
      }),
    ).toBe("Nashik");
  });

  it("is null when nothing is stated — never a guess", () => {
    expect(
      resolveCityForSummary({
        workersColumn: null,
        profileCurrentCity: undefined,
        profilePreferredCities: [],
      }),
    ).toBeNull();
  });
});

describe("salary ×3 — one band, and the upper end is never derived", () => {
  it("composes both stated ends", () => {
    expect(resolveSalaryBand({ expected: 20000, expectedMax: 28000 })).toEqual({
      low: 20000,
      high: 28000,
    });
  });

  it("a one-sided band stays one-sided", () => {
    expect(resolveSalaryBand({ expected: 20000, expectedMax: null })).toEqual({
      low: 20000,
      high: null,
    });
    expect(resolveSalaryBand({ expected: null, expectedMax: 28000 })).toEqual({
      low: 28000,
      high: null,
    });
  });

  it("an inverted band prints the lower figure alone — the formatSalaryBand rule", () => {
    expect(resolveSalaryBand({ expected: 20000, expectedMax: 18000 })).toEqual({
      low: 20000,
      high: null,
    });
  });

  it("no figures is no band", () => {
    expect(resolveSalaryBand({ expected: null, expectedMax: undefined })).toBeNull();
  });

  it("period defaults to month — the meaning the keys already had — and only day/year override", () => {
    expect(resolveSalaryPeriod(null)).toBe("month");
    expect(resolveSalaryPeriod(undefined)).toBe("month");
    expect(resolveSalaryPeriod("fortnight")).toBe("month");
    expect(resolveSalaryPeriod("day")).toBe("day");
    expect(resolveSalaryPeriod("year")).toBe("year");
  });
});

describe("availability ×3 — the worker's answer outranks the model's, parts included", () => {
  it("takes all three parts from the worker's structured answer", () => {
    expect(
      resolveAvailabilityState({
        workerAnswer: {
          status: "within_week",
          available_from: "2026-10-01",
          notice_period_days: 15,
        },
        legacyStatus: "immediate",
      }),
    ).toEqual({ status: "within_week", availableFrom: "2026-10-01", noticePeriodDays: 15 });
  });

  it("falls back to the model's status when the worker has none, and invents no parts for it", () => {
    expect(resolveAvailabilityState({ workerAnswer: null, legacyStatus: "immediate" })).toEqual({
      status: "immediate",
      availableFrom: null,
      noticePeriodDays: null,
    });
  });

  it("drops a malformed part rather than repairing it", () => {
    expect(
      resolveAvailabilityState({
        workerAnswer: { status: 7, available_from: "01-10-2026", notice_period_days: -3 },
        legacyStatus: null,
      }),
    ).toEqual({ status: null, availableFrom: null, noticePeriodDays: null });
  });
});

describe("work_types vs job_type — the multi wins, the single is the fallback", () => {
  it("a non-empty multi wins outright", () => {
    expect(resolveWorkTypes(["contract", "daily_wage"], "permanent")).toEqual([
      "contract",
      "daily_wage",
    ]);
  });

  it("an absent or empty multi falls back to the single, and neither is a guess", () => {
    expect(resolveWorkTypes(null, "permanent")).toEqual(["permanent"]);
    expect(resolveWorkTypes([], "permanent")).toEqual(["permanent"]);
    expect(resolveWorkTypes([], null)).toEqual([]);
  });
});

describe("skills ×4 and education ×3 — the stores and their roles are a closed map", () => {
  it("names exactly the four skill stores, with matching never authored", () => {
    expect(SKILL_SOURCE_OF_RECORD).toEqual({
      display: "worker_profiles.skills",
      authored: "worker_profile_skill",
      matching: "worker_skill",
      historical: "worker_profiles.raw_profile.skills",
    });
  });

  it("education rows win per field, and scalars apply only with no rows — pinned to the real function", () => {
    expect(EDUCATION_PRECEDENCE.rows).toBe("worker_education");
    // With rows: both lists are authoritative, empty included.
    const withRows = qualificationFactsFrom({
      certificates: [],
      educations: [
        { credential: "iti", field: "Machinist", council: "ncvt", year: 2018, institute: null },
      ],
    });
    expect(withRows?.educationHeadline).toBe("ITI — Machinist · NCVT · 2018");
    expect(withRows?.education).toEqual([]);
    // With no rows: `undefined`, which is what lets the caller's `??` read the scalars.
    expect(qualificationFactsFrom({ certificates: [], educations: [] })).toBeUndefined();
  });
});
