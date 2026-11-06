import { describe, expect, it } from "vitest";
import {
  combineSources,
  FIELD_SOURCES,
  resolveAvailabilityState,
  resolveAvailabilityStateWithSource,
  resolveCityForSummary,
  resolveCityForSummaryWithSource,
  resolveSalaryBand,
  resolveSalaryBandWithSource,
  resolveSalaryPeriod,
  resolveSalaryPeriodWithSource,
  resolveWorkTypes,
  resolveWorkTypesWithSource,
} from "./worker-field-precedence";

/**
 * The `...WithSource` resolvers (ADR-0062, #2560). Two properties, each pinned over a matrix:
 *   1. VALUE PARITY — the value is exactly what the original resolver returns for the same inputs,
 *      so the admin view can never disagree with the employer-facing reads that call the original;
 *   2. SOURCE — the source named is the source of the input that actually won.
 */

describe("FIELD_SOURCES — the closed provenance vocabulary", () => {
  it("is exactly the nine values the admin contract documents (no `chat`: no row can tell it)", () => {
    expect([...FIELD_SOURCES]).toEqual([
      "interview",
      "form",
      "resume_import",
      "worker_edit",
      "ops",
      // #2561 — the admin correction source.
      "admin_override",
      "derived",
      "none",
      "unknown",
    ]);
  });

  it("combineSources: shared source, `none` when nothing contributed, `unknown` when they disagree", () => {
    expect(combineSources([])).toBe("none");
    expect(combineSources(["none", "none"])).toBe("none");
    expect(combineSources(["form", "none", "form"])).toBe("form");
    expect(combineSources(["form", "interview"])).toBe("unknown");
  });
});

describe("resolveCityForSummaryWithSource", () => {
  const SOURCES = { workersColumn: "worker_edit", profile: "interview" } as const;
  const MATRIX = [
    { workersColumn: "Pune", profileCurrentCity: "Chakan", profilePreferredCities: ["Delhi"] },
    { workersColumn: "  ", profileCurrentCity: "Chakan", profilePreferredCities: ["Delhi"] },
    { workersColumn: null, profileCurrentCity: null, profilePreferredCities: ["", " Delhi "] },
    { workersColumn: null, profileCurrentCity: " ", profilePreferredCities: [] },
    { workersColumn: undefined, profileCurrentCity: undefined, profilePreferredCities: null },
  ];

  it("returns EXACTLY resolveCityForSummary's value for every input", () => {
    for (const input of MATRIX) {
      expect(resolveCityForSummaryWithSource(input, SOURCES).value).toBe(
        resolveCityForSummary(input),
      );
    }
  });

  it("names the worker's column when it won, the profile when a profile level won, none when empty", () => {
    expect(resolveCityForSummaryWithSource(MATRIX[0]!, SOURCES)).toEqual({
      value: "Pune",
      source: "worker_edit",
    });
    expect(resolveCityForSummaryWithSource(MATRIX[1]!, SOURCES)).toEqual({
      value: "Chakan",
      source: "interview",
    });
    expect(resolveCityForSummaryWithSource(MATRIX[2]!, SOURCES)).toEqual({
      value: "Delhi",
      source: "interview",
    });
    expect(resolveCityForSummaryWithSource(MATRIX[3]!, SOURCES)).toEqual({
      value: null,
      source: "none",
    });
  });
});

describe("resolveSalaryBandWithSource", () => {
  const base = {
    containerSource: "interview",
    attributeSources: { expected: "form", expectedMax: "form" },
  } as const;

  it("a container figure wins OUTRIGHT over the attributes (the SALARY ×3 rule), with its source", () => {
    const r = resolveSalaryBandWithSource({
      ...base,
      container: { amountMin: 18000, amountMax: 22000 },
      attributes: { expected: 30000, expectedMax: 35000 },
    });
    expect(r).toEqual({
      value: resolveSalaryBand({ expected: 18000, expectedMax: 22000 }),
      source: "interview",
    });
  });

  it("#2561 — an admin correction sits ABOVE the container (the salary overlay contract)", () => {
    // ADR-0062 §3.2: writing only the attribute pair would leave the container showing the
    // extracted salary. The override must win even when a container figure exists.
    const r = resolveSalaryBandWithSource({
      ...base,
      container: { amountMin: 18000, amountMax: 22000 },
      attributes: { expected: 30000, expectedMax: 35000 },
      override: { amountMin: 40000, amountMax: 45000 },
    });
    expect(r).toEqual({
      value: resolveSalaryBand({ expected: 40000, expectedMax: 45000 }),
      source: "admin_override",
    });
    // An override with no usable figure falls through to the normal chain.
    const empty = resolveSalaryBandWithSource({
      ...base,
      container: { amountMin: 18000, amountMax: 22000 },
      attributes: { expected: null, expectedMax: null },
      override: { amountMin: null, amountMax: null },
    });
    expect(empty.source).toBe("interview");
  });

  it("no container figure → the attribute band, through resolveSalaryBand (upper end never derived)", () => {
    for (const attributes of [
      { expected: 15000, expectedMax: null },
      { expected: null, expectedMax: 20000 },
      { expected: 20000, expectedMax: 15000 }, // inverted → the lower figure alone
      { expected: 15000, expectedMax: 20000 },
    ]) {
      const r = resolveSalaryBandWithSource({
        ...base,
        container: { amountMin: null, amountMax: null },
        attributes,
      });
      expect(r.value).toEqual(resolveSalaryBand(attributes));
      expect(r.source).toBe("form");
    }
  });

  it("two figures from DIFFERENT writers → unknown; nothing anywhere → none", () => {
    const mixed = resolveSalaryBandWithSource({
      containerSource: "interview",
      container: { amountMin: null, amountMax: null },
      attributes: { expected: 15000, expectedMax: 20000 },
      attributeSources: { expected: "form", expectedMax: "worker_edit" },
    });
    expect(mixed.source).toBe("unknown");
    expect(
      resolveSalaryBandWithSource({
        ...base,
        container: { amountMin: null, amountMax: null },
        attributes: { expected: null, expectedMax: null },
      }),
    ).toEqual({ value: null, source: "none" });
  });
});

describe("resolveSalaryPeriodWithSource", () => {
  it("returns resolveSalaryPeriod's value; a stated period carries its source, the default is derived", () => {
    for (const p of ["day", "year", "month", null, undefined, "weekly"]) {
      expect(resolveSalaryPeriodWithSource(p, "form").value).toBe(resolveSalaryPeriod(p));
    }
    expect(resolveSalaryPeriodWithSource("day", "form").source).toBe("form");
    expect(resolveSalaryPeriodWithSource(null, "none").source).toBe("derived");
    expect(resolveSalaryPeriodWithSource("weekly", "form").source).toBe("derived");
  });
});

describe("resolveWorkTypesWithSource", () => {
  const S = { workTypes: "worker_edit", jobType: "interview" } as const;
  it("value parity with resolveWorkTypes; the multi's source when it won, else the single's", () => {
    for (const [multi, single] of [
      [["contract"], "permanent"],
      [[], "permanent"],
      [null, "permanent"],
      [null, ""],
      [undefined, undefined],
    ] as const) {
      expect(resolveWorkTypesWithSource(multi, single, S).value).toEqual(
        resolveWorkTypes(multi, single),
      );
    }
    expect(resolveWorkTypesWithSource(["contract"], "permanent", S).source).toBe("worker_edit");
    expect(resolveWorkTypesWithSource([], "permanent", S).source).toBe("interview");
    expect(resolveWorkTypesWithSource(null, null, S).source).toBe("none");
  });
});

describe("resolveAvailabilityStateWithSource", () => {
  const S = { workerAnswer: "form", legacy: "interview" } as const;
  const MATRIX = [
    { workerAnswer: { status: "within_week" }, legacyStatus: "immediate" },
    { workerAnswer: null, legacyStatus: "immediate" },
    { workerAnswer: { available_from: "2026-12-01" }, legacyStatus: "immediate" },
    { workerAnswer: { available_from: "2026-12-01" }, legacyStatus: null },
    { workerAnswer: undefined, legacyStatus: null },
  ];

  it("returns EXACTLY resolveAvailabilityState's value for every input", () => {
    for (const input of MATRIX) {
      expect(resolveAvailabilityStateWithSource(input, S).value).toEqual(
        resolveAvailabilityState(input),
      );
    }
  });

  it("the worker's status → its source; the legacy status → its source; mixed → unknown; nothing → none", () => {
    expect(resolveAvailabilityStateWithSource(MATRIX[0]!, S).source).toBe("form");
    expect(resolveAvailabilityStateWithSource(MATRIX[1]!, S).source).toBe("interview");
    expect(resolveAvailabilityStateWithSource(MATRIX[2]!, S).source).toBe("unknown");
    expect(resolveAvailabilityStateWithSource(MATRIX[3]!, S).source).toBe("form");
    expect(resolveAvailabilityStateWithSource(MATRIX[4]!, S).source).toBe("none");
  });
});
