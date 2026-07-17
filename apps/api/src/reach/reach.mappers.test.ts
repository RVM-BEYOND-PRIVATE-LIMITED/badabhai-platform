import { describe, it, expect } from "vitest";
import {
  workerProfileRowToSignals,
  workerProfileRowToBands,
  experienceBandFromYears,
  lastActiveDaysAgoFrom,
  type WorkerProfileSignalRow,
} from "./reach.mappers";

const WORKER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-06-16T12:00:00.000Z");

/** A fully-populated, canonical-shape signal row (ai-contracts JSONB shapes). */
function fullRow(overrides: Partial<WorkerProfileSignalRow> = {}): WorkerProfileSignalRow {
  return {
    workerId: WORKER,
    canonicalRoleId: "vmc_operator",
    canonicalTradeId: "cnc_vmc",
    experience: { total_years: 6, summary: "skilled" },
    salaryExpectation: { amount_min: 22000, amount_max: 30000, currency: "INR", period: "monthly" },
    locationPreference: {
      preferred_cities: ["pune", "mumbai"],
      willing_to_relocate: true,
      centroid: { lat: 18.5204, lng: 73.8567 },
      travel_radius_km: 35,
    },
    availability: { status: "immediate", notice_period_days: 0 },
    updatedAt: new Date("2026-06-06T12:00:00.000Z"), // 10 days before NOW
    ...overrides,
  };
}

describe("workerProfileRowToSignals — canonical JSONB parsing", () => {
  it("maps every canonical field correctly", () => {
    const s = workerProfileRowToSignals(fullRow(), NOW);
    expect(s.workerId).toBe(WORKER);
    expect(s.roleId).toBe("vmc_operator");
    expect(s.experienceYears).toBe(6);
    expect(s.expectedSalary).toBe(22000); // amount_min preferred (the floor)
    expect(s.location).toEqual({ lat: 18.5204, lng: 73.8567 });
    expect(s.city).toBe("pune"); // first preferred city
    expect(s.travelRadiusKm).toBe(35);
    expect(s.availability).toBe("immediate");
    expect(s.lastActiveDaysAgo).toBe(10);
    expect(s.secondaryRoleIds).toEqual([]);
  });

  it("falls back to amount_max when amount_min is missing", () => {
    const s = workerProfileRowToSignals(
      fullRow({ salaryExpectation: { amount_max: 27000, period: "monthly" } }),
      NOW,
    );
    expect(s.expectedSalary).toBe(27000);
  });

  it("treats a non-monthly salary period as unknown (null), never inventing a rate", () => {
    const s = workerProfileRowToSignals(
      fullRow({ salaryExpectation: { amount_min: 900, period: "daily" } }),
      NOW,
    );
    expect(s.expectedSalary).toBeNull();
  });
});

describe("workerProfileRowToSignals — skills (ADR-0033 supply-side ids)", () => {
  it("passes canonical closed-set ids through, trimmed + deduplicated", () => {
    const s = workerProfileRowToSignals(
      fullRow({ skills: ["skill_milling", " skill_turning ", "skill_milling"] }),
      NOW,
    );
    expect(s.skillIds).toEqual(["skill_milling", "skill_turning"]);
  });

  it("an absent skills column maps to [] (pre-ADR-0033 rows/fixtures — never a drop)", () => {
    const s = workerProfileRowToSignals(fullRow(), NOW); // fixture omits `skills`
    expect(s.skillIds).toEqual([]);
  });

  it("garbage skills JSONB maps to [] (non-array, non-string entries, blanks)", () => {
    for (const garbage of ["not-an-array", 42, { a: 1 }, null, [42, {}, "", "   ", null]]) {
      const s = workerProfileRowToSignals(fullRow({ skills: garbage }), NOW);
      expect(s.skillIds).toEqual([]);
    }
  });
});

describe("workerProfileRowToSignals — NULL / BLANK PASS-THROUGH (never drop, never penalize)", () => {
  it("an entirely-blank row yields nulls/[], NOT a dropped or empty mapping", () => {
    const s = workerProfileRowToSignals(
      {
        workerId: WORKER,
        canonicalRoleId: null,
        canonicalTradeId: null,
        experience: {},
        salaryExpectation: {},
        locationPreference: {},
        availability: {},
        updatedAt: null,
      },
      NOW,
    );
    // The worker is still mapped (presence preserved); blanks are null, not absent.
    expect(s.workerId).toBe(WORKER);
    expect(s.roleId).toBeNull();
    expect(s.experienceYears).toBeNull();
    expect(s.expectedSalary).toBeNull();
    expect(s.location).toBeNull();
    expect(s.city).toBeNull();
    expect(s.travelRadiusKm).toBeNull();
    expect(s.availability).toBeNull();
    expect(s.lastActiveDaysAgo).toBeNull();
    expect(s.secondaryRoleIds).toEqual([]);
  });

  it("a blank string canonical role becomes null (unknown), not empty string", () => {
    const s = workerProfileRowToSignals(fullRow({ canonicalRoleId: "   " }), NOW);
    expect(s.roleId).toBeNull();
  });

  it("garbage / wrong-typed JSONB is treated as unknown (null), never throws", () => {
    const s = workerProfileRowToSignals(
      {
        workerId: WORKER,
        canonicalRoleId: "vmc_operator",
        canonicalTradeId: "cnc_vmc",
        experience: "not-an-object",
        salaryExpectation: 12345,
        locationPreference: ["array", "not", "object"],
        availability: null,
        updatedAt: "not-a-date",
      },
      NOW,
    );
    expect(s.experienceYears).toBeNull();
    expect(s.expectedSalary).toBeNull();
    expect(s.location).toBeNull();
    expect(s.city).toBeNull();
    expect(s.travelRadiusKm).toBeNull();
    expect(s.availability).toBeNull();
    expect(s.lastActiveDaysAgo).toBeNull();
  });

  it("an unrecognised availability status maps to null (neutral), not the raw value", () => {
    const s = workerProfileRowToSignals(fullRow({ availability: { status: "on_holiday" } }), NOW);
    expect(s.availability).toBeNull();
  });

  it("a NaN/Infinity experience number is unknown (null), never a penalty input", () => {
    const s = workerProfileRowToSignals(
      fullRow({ experience: { total_years: Number.POSITIVE_INFINITY } }),
      NOW,
    );
    expect(s.experienceYears).toBeNull();
  });
});

describe("workerProfileRowToSignals — FACELESS (no PII ever crosses the mapper)", () => {
  it("ignores any stray PII-shaped keys on the JSONB and never surfaces them", () => {
    // Even if upstream JSONB carried stray fields, the mapper reads ONLY signals.
    const s = workerProfileRowToSignals(
      fullRow({
        locationPreference: {
          preferred_cities: ["pune"],
          full_name: "Ramesh Kumar",
          phone: "9876543210",
          address: "12 MG Road",
        } as unknown,
      }),
      NOW,
    );
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain("Ramesh");
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("MG Road");
    // The signal it DID need is still present.
    expect(s.city).toBe("pune");
  });

  it("the output keys are exactly the engine's WorkerSignals — no identity fields", () => {
    const s = workerProfileRowToSignals(fullRow(), NOW);
    // `skillIds` joined DELIBERATELY with ADR-0033 (the deterministic skills-overlap
    // factor's supply side). It is a faceless list of canonical closed-set taxonomy
    // tokens — not an identity field; the no-PII assertions above still hold.
    expect(Object.keys(s).sort()).toEqual(
      [
        "availability",
        "city",
        "expectedSalary",
        "experienceYears",
        "lastActiveDaysAgo",
        "location",
        "roleId",
        "secondaryRoleIds",
        "skillIds",
        "travelRadiusKm",
        "workerId",
      ].sort(),
    );
  });
});

describe("experienceBandFromYears — coarse, display-only discretization", () => {
  it("maps years to the established year-range vocabulary", () => {
    expect(experienceBandFromYears(0)).toBe("<1 yr");
    expect(experienceBandFromYears(0.5)).toBe("<1 yr");
    expect(experienceBandFromYears(1)).toBe("1-2 yrs");
    expect(experienceBandFromYears(2)).toBe("1-2 yrs");
    expect(experienceBandFromYears(3)).toBe("3-5 yrs");
    expect(experienceBandFromYears(5)).toBe("3-5 yrs");
    expect(experienceBandFromYears(6)).toBe("6-10 yrs");
    expect(experienceBandFromYears(10)).toBe("6-10 yrs");
    expect(experienceBandFromYears(11)).toBe("10+ yrs");
  });

  it("returns null (unknown) for missing / non-finite / negative years — never throws", () => {
    expect(experienceBandFromYears(null)).toBeNull();
    expect(experienceBandFromYears(Number.NaN)).toBeNull();
    expect(experienceBandFromYears(Number.POSITIVE_INFINITY)).toBeNull();
    expect(experienceBandFromYears(-3)).toBeNull();
  });
});

describe("workerProfileRowToBands — faceless banded taxonomy chips", () => {
  it("resolves the canonical role id to a taxonomy name + coarse experience band + city", () => {
    const b = workerProfileRowToBands(
      fullRow({
        canonicalRoleId: "role_vmc_operator",
        experience: { total_years: 7 },
        locationPreference: { preferred_cities: ["pune", "mumbai"] },
      }),
    );
    expect(b.tradeLabel).toBe("VMC Operator");
    expect(b.experienceBand).toBe("6-10 yrs");
    expect(b.cityLabel).toBe("pune");
  });

  it("falls back to the DOMAIN (trade) name when only the trade id is canonical", () => {
    const b = workerProfileRowToBands(
      fullRow({ canonicalRoleId: null, canonicalTradeId: "dom_vmc_machining" }),
    );
    expect(b.tradeLabel).toBe("VMC Machining");
  });

  it("falls back to the raw canonical id (a faceless token) when it does not resolve", () => {
    const b = workerProfileRowToBands(
      fullRow({ canonicalRoleId: "vmc_operator", canonicalTradeId: "cnc_vmc" }),
    );
    expect(b.tradeLabel).toBe("vmc_operator"); // raw id passthrough, never PII
  });

  it("an entirely-blank row yields all-null bands (never throws, never drops)", () => {
    const b = workerProfileRowToBands({
      workerId: WORKER,
      canonicalRoleId: null,
      canonicalTradeId: null,
      experience: {},
      salaryExpectation: {},
      locationPreference: {},
      availability: {},
      updatedAt: null,
    });
    expect(b).toEqual({ experienceBand: null, tradeLabel: null, cityLabel: null });
  });

  it("is FACELESS: ignores stray PII-shaped JSONB keys, surfaces only bands", () => {
    const b = workerProfileRowToBands(
      fullRow({
        canonicalRoleId: "role_vmc_operator",
        locationPreference: {
          preferred_cities: ["pune"],
          full_name: "Ramesh Kumar",
          phone: "9876543210",
          address: "12 MG Road",
        } as unknown,
      }),
    );
    const serialized = JSON.stringify(b);
    expect(serialized).not.toContain("Ramesh");
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("MG Road");
    expect(Object.keys(b).sort()).toEqual(["cityLabel", "experienceBand", "tradeLabel"]);
  });
});

describe("lastActiveDaysAgoFrom — clock derivation lives OUTSIDE the engine", () => {
  it("floors to whole days since updated_at", () => {
    const updated = new Date("2026-06-10T00:00:00.000Z");
    const now = new Date("2026-06-16T23:00:00.000Z"); // 6 days + 23h
    expect(lastActiveDaysAgoFrom(updated, now)).toBe(6);
  });

  it("accepts an ISO string timestamp", () => {
    expect(lastActiveDaysAgoFrom("2026-06-06T12:00:00.000Z", NOW)).toBe(10);
  });

  it("returns null for a missing, unparseable, or future timestamp (unknown recency)", () => {
    expect(lastActiveDaysAgoFrom(null, NOW)).toBeNull();
    expect(lastActiveDaysAgoFrom("garbage", NOW)).toBeNull();
    expect(lastActiveDaysAgoFrom(new Date("2026-06-20T00:00:00.000Z"), NOW)).toBeNull();
  });
});
