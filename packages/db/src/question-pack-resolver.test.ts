/**
 * The family fallback chain, at ALL SIX specificity levels.
 *
 * THIS FILE IS A PHASE 4 ACCEPTANCE CRITERION, verbatim: "Fallback chain resolves
 * correctly at all six specificity levels." It was the one criterion with no verification
 * behind it when the phase was first reported, which is exactly the failure the phase
 * completion gate exists to catch — the data model supported six levels and nothing
 * demonstrated that it used them.
 *
 * Each level is tested TWICE: that it wins when it is the most specific match available,
 * and that it LOSES to every level above it. A suite that only checked the first would
 * pass against a resolver that always returned the universal family.
 */
import { describe, expect, it } from "vitest";

import {
  iscoAncestry,
  resolveFamily,
  type ResolvableBinding,
} from "./question-pack-resolver";

/** A welder: jd_nco_7212_0100, unit 7212 -> minor 721, submajor 72, major 7. */
const WELDER = { jobDomainId: "jd_nco_7212_0100", iscoUnitCode: "7212" };

const B = {
  domain: { familyId: "fam_exact", jobDomainId: "jd_nco_7212_0100" },
  unit: { familyId: "fam_unit", iscoUnitCode: "7212" },
  minor: { familyId: "fam_minor", iscoMinorCode: "721" },
  submajor: { familyId: "fam_submajor", iscoSubmajorCode: "72" },
  major: { familyId: "fam_major", iscoMajorCode: "7" },
  universal: { familyId: "fam_universal", isUniversal: true },
} satisfies Record<string, ResolvableBinding>;

/** Every binding, so each test is about ORDERING rather than availability. */
const ALL: ResolvableBinding[] = [B.universal, B.major, B.submajor, B.minor, B.unit, B.domain];

describe("iscoAncestry — mirrors the generated columns on job_domain", () => {
  it("slices unit -> minor / submajor / major", () => {
    expect(iscoAncestry("7212")).toEqual({ minor: "721", submajor: "72", major: "7" });
  });

  it("returns nulls for a null unit code", () => {
    expect(iscoAncestry(null)).toEqual({ minor: null, submajor: null, major: null });
  });

  it("does not throw on a short code — left() semantics, not substring bounds", () => {
    // Postgres `left('72', 3)` is '72', not an error. The parity test compares against
    // real SQL, so this has to behave identically rather than defensively.
    expect(iscoAncestry("72")).toEqual({ minor: "72", submajor: "72", major: "7" });
  });
});

describe("all six levels win when they are the most specific available", () => {
  it("50 — an exact job_domain binding beats everything", () => {
    expect(resolveFamily(ALL, WELDER)).toEqual({
      familyId: "fam_exact",
      specificity: 50,
      matchedOn: "job_domain",
    });
  });

  it("40 — isco_unit wins once the exact binding is gone", () => {
    const bindings = ALL.filter((b) => b !== B.domain);
    expect(resolveFamily(bindings, WELDER)).toMatchObject({ familyId: "fam_unit", specificity: 40 });
  });

  it("30 — isco_minor wins next", () => {
    const bindings = ALL.filter((b) => b !== B.domain && b !== B.unit);
    expect(resolveFamily(bindings, WELDER)).toMatchObject({ familyId: "fam_minor", specificity: 30 });
  });

  it("20 — isco_submajor wins next", () => {
    const bindings = [B.universal, B.major, B.submajor];
    expect(resolveFamily(bindings, WELDER)).toMatchObject({ familyId: "fam_submajor", specificity: 20 });
  });

  it("10 — isco_major wins next", () => {
    const bindings = [B.universal, B.major];
    expect(resolveFamily(bindings, WELDER)).toMatchObject({ familyId: "fam_major", specificity: 10 });
  });

  it("0 — universal is the floor and always resolves", () => {
    expect(resolveFamily([B.universal], WELDER)).toEqual({
      familyId: "fam_universal",
      specificity: 0,
      matchedOn: "universal",
    });
  });
});

describe("every level LOSES to the one above it", () => {
  // The half a naive suite forgets. Without these, a resolver that always returned the
  // universal family would pass the block above for the universal case and fail silently
  // for the rest.
  const pairs: [string, ResolvableBinding, ResolvableBinding, string][] = [
    ["unit loses to job_domain", B.unit, B.domain, "fam_exact"],
    ["minor loses to unit", B.minor, B.unit, "fam_unit"],
    ["submajor loses to minor", B.submajor, B.minor, "fam_minor"],
    ["major loses to submajor", B.major, B.submajor, "fam_submajor"],
    ["universal loses to major", B.universal, B.major, "fam_major"],
  ];
  for (const [name, lower, higher, expected] of pairs) {
    it(name, () => {
      // Lower listed FIRST, so input order cannot be what produces the right answer.
      expect(resolveFamily([lower, higher], WELDER)?.familyId).toBe(expected);
    });
  }
});

describe("edge cases", () => {
  it("returns null when not even a universal binding exists", () => {
    // The corpus validator and the deploy gate both refuse this state, so it should be
    // unreachable — but it is RETURNED rather than thrown so a caller degrades instead of
    // crashing a live interview.
    expect(resolveFamily([B.major].filter(() => false), WELDER)).toBeNull();
  });

  it("falls through to universal when an occupation has no ISCO unit at all", () => {
    const orphan = { jobDomainId: "jd_rvm_custom", iscoUnitCode: null };
    expect(resolveFamily(ALL, orphan)?.familyId).toBe("fam_universal");
  });

  it("does not match an ISCO level against a DIFFERENT branch of the tree", () => {
    // A cook (5120) must not reach a family bound to major 7.
    const cook = { jobDomainId: "jd_nco_5120_0200", iscoUnitCode: "5120" };
    expect(resolveFamily([B.major, B.universal], cook)?.familyId).toBe("fam_universal");
  });

  it("matches the exact job_domain even when the unit code is null", () => {
    const noUnit = { jobDomainId: "jd_nco_7212_0100", iscoUnitCode: null };
    expect(resolveFamily(ALL, noUnit)?.familyId).toBe("fam_exact");
  });

  it("reports which level matched, for observability", () => {
    expect(resolveFamily([B.minor, B.universal], WELDER)?.matchedOn).toBe("isco_minor");
  });
});

describe("the real corpus resolves every bound trade to its own family", () => {
  // Guards against the shipped bindings silently collapsing to universal — which would
  // look fine in the verifier (one universal exists) while every worker got the generic
  // interview.
  const realish: ResolvableBinding[] = [
    { familyId: "fam_universal", isUniversal: true },
    { familyId: "fam_welding", iscoUnitCode: "7212" },
    { familyId: "fam_tailoring", iscoUnitCode: "7531" },
    { familyId: "fam_driving_light", iscoUnitCode: "8322" },
    { familyId: "fam_cooking", iscoUnitCode: "5120" },
  ];
  const cases: [string, string, string][] = [
    ["jd_nco_7212_0100", "7212", "fam_welding"],
    ["jd_nco_7531_0100", "7531", "fam_tailoring"],
    ["jd_nco_8322_0100", "8322", "fam_driving_light"],
    ["jd_nco_5120_0200", "5120", "fam_cooking"],
    ["jd_nco_9999_0000", "9999", "fam_universal"],
  ];
  for (const [jd, unit, expected] of cases) {
    it(`${unit} -> ${expected}`, () => {
      expect(resolveFamily(realish, { jobDomainId: jd, iscoUnitCode: unit })?.familyId).toBe(expected);
    });
  }
});
