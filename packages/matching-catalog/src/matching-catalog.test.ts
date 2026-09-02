import { describe, it, expect } from "vitest";
import {
  FIXTURE_CATALOG,
  HIGHER_TIER_TO_OPERATOR,
  OPERATOR_TO_HIGHER_TIER,
  LOCKED_COLLAR_TIERS,
  LOCKED_FUNCTION_VALUES,
  MATCHING_CATALOG_SCHEMA_VERSION,
  PROPOSED_FUNCTION_VALUES,
  formatPath,
  validateMatchingCatalog,
  describeIssues,
  type MatchingCatalog,
} from "./index";

/** Deep clone so a mutation in one case cannot leak into another. */
const clone = (): MatchingCatalog => structuredClone(FIXTURE_CATALOG);

describe("the fixture is valid — so the rejection tests below prove rejection, not breakage", () => {
  it("validates", () => {
    const res = validateMatchingCatalog(FIXTURE_CATALOG);
    expect(res.ok).toBe(true);
  });

  it("is NOT vacuous: it carries roles, an adjacency edge and both multiplier tables", () => {
    // Guards against the fixture degrading into {} — which would pass every
    // reference check by having nothing to reference.
    expect(FIXTURE_CATALOG.roles.length).toBeGreaterThanOrEqual(2);
    expect(FIXTURE_CATALOG.adjacency.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(FIXTURE_CATALOG.functionMultiplier.matrix).length).toBeGreaterThan(0);
    expect(Object.keys(FIXTURE_CATALOG.collarTierBand.matrix).length).toBeGreaterThan(0);
  });

  it("uses only obviously-synthetic placeholder ids — no real taxonomy leaked in", () => {
    for (const r of FIXTURE_CATALOG.roles) expect(r.id).toMatch(/^role_placeholder_/);
    for (const d of FIXTURE_CATALOG.domains) expect(d.id).toMatch(/^dom_placeholder_/);
    for (const f of FIXTURE_CATALOG.families) expect(f.id).toMatch(/^fam_placeholder_/);
  });
});

// ---------------------------------------------------------------------------
// The four rejections P1 requires, each asserting the PATH and not just failure.
// ---------------------------------------------------------------------------
describe("REJECTS: the four invalid catalogs, each naming the offending path", () => {
  it("1. an adjacency edge referencing an unknown role_id", () => {
    const bad = clone();
    bad.adjacency[0]!.to = "role_does_not_exist";

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");

    const issue = res.issues.find((i) => i.code === "unknown_role");
    expect(issue).toBeDefined();
    expect(issue!.path).toBe("adjacency[0].to");
    expect(issue!.message).toContain("role_does_not_exist");
  });

  it("2. a multiplier of 1.4 — outside [0.00, 1.00]", () => {
    const bad = clone();
    bad.adjacency[0]!.multiplier = 1.4;

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");

    const issue = res.issues.find((i) => i.path === "adjacency[0].multiplier");
    expect(issue).toBeDefined();
    expect(issue!.code).toBe("schema");
    expect(issue!.message).toContain("<= 1.00");
  });

  it("2b. a NEGATIVE multiplier is rejected at the same path", () => {
    const bad = clone();
    bad.functionMultiplier.default = -0.1;

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.issues.some((i) => i.path === "functionMultiplier.default")).toBe(true);
  });

  it("2c. a multiplier deep inside the function matrix names its full path", () => {
    const bad = clone();
    bad.functionMultiplier.matrix.operator!.programmer = 3;

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.issues.some((i) => i.path === "functionMultiplier.matrix.operator.programmer")).toBe(
      true,
    );
  });

  it("3a. a role with NO family (key absent)", () => {
    const bad = clone() as unknown as { roles: Array<Record<string, unknown>> };
    delete bad.roles[0]!.familyId;

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.issues.some((i) => i.path === "roles[0].familyId")).toBe(true);
  });

  it("3b. a role whose family DANGLES — present, but not in families[]", () => {
    // The nastier half: shape-valid, so Zod alone would pass it. Silently costs the
    // pair its 0.90 same-family edge.
    const bad = clone();
    bad.roles[0]!.familyId = "fam_not_declared";

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");

    const issue = res.issues.find((i) => i.code === "unknown_family");
    expect(issue!.path).toBe("roles[0].familyId");
    expect(issue!.message).toContain("fam_not_declared");
  });

  it("3c. a role whose domain dangles", () => {
    const bad = clone();
    bad.roles[1]!.domainId = "dom_not_declared";

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.issues.find((i) => i.code === "unknown_domain")!.path).toBe("roles[1].domainId");
  });

  it("4. a role declaring a function value outside the locked enum", () => {
    const bad = clone() as unknown as { roles: Array<{ functions: string[] }> };
    bad.roles[0]!.functions = ["operator", "welding_supervisor"];

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.issues.some((i) => i.path === "roles[0].functions[1]")).toBe(true);
  });
});

describe("R1 is unsigned — setter_programmer is NOT representable yet", () => {
  it("is absent from the locked enum and present in the proposed list", () => {
    expect(LOCKED_FUNCTION_VALUES).not.toContain("setter_programmer");
    expect(PROPOSED_FUNCTION_VALUES).toContain("setter_programmer");
    expect(LOCKED_FUNCTION_VALUES).toHaveLength(9);
  });

  it("a role declaring setter_programmer is REJECTED, naming the path", () => {
    const bad = clone() as unknown as { roles: Array<{ functions: string[] }> };
    bad.roles[0]!.functions = ["operator", "setter_programmer"];

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.issues.some((i) => i.path === "roles[0].functions[1]")).toBe(true);
  });
});

describe("the shape carries the two locked asymmetric multipliers (spec §A4)", () => {
  it("higher-tier -> operator is 0.85 and operator -> higher-tier is 0.25", () => {
    const m = FIXTURE_CATALOG.functionMultiplier.matrix;
    expect(m.programmer?.operator).toBe(0.85);
    expect(m.setter?.operator).toBe(0.85);
    expect(m.operator?.programmer).toBe(0.25);
    expect(m.operator?.setter).toBe(0.25);
    expect(HIGHER_TIER_TO_OPERATOR).toBe(0.85);
    expect(OPERATOR_TO_HIGHER_TIER).toBe(0.25);
  });

  it("the matrix is DIRECTED — the two directions genuinely differ", () => {
    const m = FIXTURE_CATALOG.functionMultiplier.matrix;
    expect(m.programmer?.operator).not.toBe(m.operator?.programmer);
  });

  it("the adjacency list is directed too", () => {
    const [ab, ba] = FIXTURE_CATALOG.adjacency;
    expect(ab!.from).toBe(ba!.to);
    expect(ab!.to).toBe(ba!.from);
    expect(ab!.multiplier).not.toBe(ba!.multiplier);
  });

  it("the 'function not confirmed' default is non-zero — a partial profile is never excluded", () => {
    expect(FIXTURE_CATALOG.functionMultiplier.default).toBeGreaterThan(0);
  });
});

describe("structural guards", () => {
  it("rejects an unknown top-level key rather than ignoring it", () => {
    const bad = { ...clone(), adjacencies: [] };
    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
  });

  it("rejects a duplicate role id, naming the later index and the earlier one", () => {
    const bad = clone();
    bad.roles[1]!.id = bad.roles[0]!.id;

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");

    const issue = res.issues.find((i) => i.code === "duplicate_id");
    expect(issue!.path).toBe("roles[1].id");
    expect(issue!.message).toContain("roles[0]");
  });

  it("rejects a schemaVersion that is not the pinned contract version", () => {
    const bad = { ...clone(), schemaVersion: MATCHING_CATALOG_SCHEMA_VERSION + 1 };
    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.issues.some((i) => i.path === "schemaVersion")).toBe(true);
  });

  it("rejects null, undefined and a non-object without throwing", () => {
    for (const raw of [null, undefined, "nope", 42, []]) {
      expect(validateMatchingCatalog(raw).ok).toBe(false);
    }
  });

  it("reports EVERY issue at once, not just the first", () => {
    const bad = clone();
    bad.roles[0]!.familyId = "fam_nope";
    bad.roles[1]!.domainId = "dom_nope";
    bad.adjacency[0]!.to = "role_nope";

    const res = validateMatchingCatalog(bad);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("locks the four collar tiers", () => {
    expect(LOCKED_COLLAR_TIERS).toEqual([
      "elementary",
      "semi-skilled",
      "skilled trade",
      "technician",
    ]);
  });
});

describe("formatPath / describeIssues", () => {
  it("renders array indices with brackets and object keys with dots", () => {
    expect(formatPath(["roles", 3, "functions", 0])).toBe("roles[3].functions[0]");
    expect(formatPath(["functionMultiplier", "matrix", "operator", "setter"])).toBe(
      "functionMultiplier.matrix.operator.setter",
    );
    expect(formatPath([])).toBe("(root)");
  });

  it("describeIssues puts the path in front of every message", () => {
    const res = validateMatchingCatalog({ ...clone(), schemaVersion: 99 });
    if (res.ok) throw new Error("unreachable");
    expect(describeIssues(res.issues)).toContain("schemaVersion:");
  });
});
