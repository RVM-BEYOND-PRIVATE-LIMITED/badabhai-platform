import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_CONFIG, parseMatchConfig } from "./config";
import { deriveWorkerSkills } from "./derive";

const cfg = DEFAULT_MATCH_CONFIG;

describe("deriveWorkerSkills — the COARSE launch rule", () => {
  it("derives the match skill from the canonical role", () => {
    const rows = deriveWorkerSkills({ canonicalRoleId: "role_vmc_operator", totalYears: 4 }, cfg);
    expect(rows).toEqual([
      {
        skillId: "mskill_vmc_operator",
        industryId: "ind_industrial_manufacturing",
        monthsBucketed: 48,
        wants: true,
        startedAt: null,
        endedAt: null,
      },
    ]);
  });

  it("UNIONS the role with every match skill the attributes imply", () => {
    const rows = deriveWorkerSkills(
      {
        canonicalRoleId: "role_cnc_turner_operator",
        // turning -> cnc_turner (same as the role), milling -> vmc_operator,
        // CMM + inspection -> quality_inspector (deduped to one row).
        profileSkills: ["skill_turning", "skill_milling", "skill_cmm", "skill_dimensional_inspection"],
        totalYears: 3,
      },
      cfg,
    );
    expect(rows.map((r) => r.skillId)).toEqual([
      "mskill_cnc_turner",
      "mskill_quality_inspector",
      "mskill_vmc_operator",
    ]);
  });

  it("applies ONE bucketed total identically to every derived row (the coarse rule)", () => {
    // A real limitation, stated rather than hidden: eight years total reads as eight
    // years on each derived skill, because the profile carries no per-skill duration.
    const rows = deriveWorkerSkills(
      { canonicalRoleId: "role_welder", profileSkills: ["skill_tig_welding"], totalYears: 8 },
      cfg,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.monthsBucketed).toBe(96);
  });

  it("returns [] when nothing implies a posting-level skill — never fabricates reach", () => {
    // GD&T and a micrometer make a man employable; they do not make him a vacancy.
    expect(
      deriveWorkerSkills({ profileSkills: ["skill_gdt_reading", "skill_measuring_instruments"], totalYears: 10 }, cfg),
    ).toEqual([]);
    expect(deriveWorkerSkills({}, cfg)).toEqual([]);
    expect(deriveWorkerSkills({ canonicalRoleId: null, profileSkills: [], totalYears: 5 }, cfg)).toEqual([]);
    expect(deriveWorkerSkills({ canonicalRoleId: "role_does_not_exist", totalYears: 5 }, cfg)).toEqual([]);
  });

  it("carries the industry from the vocabulary, not from the caller", () => {
    const rows = deriveWorkerSkills({ canonicalRoleId: "role_plumber", totalYears: 1 }, cfg);
    expect(rows[0]?.industryId).toBe("ind_industrial_manufacturing");
  });

  it("defaults wants to true and leaves the stint dates null", () => {
    const rows = deriveWorkerSkills({ canonicalRoleId: "role_carpenter", totalYears: 2 }, cfg);
    expect(rows[0]?.wants).toBe(true);
    expect(rows[0]?.startedAt).toBeNull();
    expect(rows[0]?.endedAt).toBeNull();
  });

  it("unknown duration derives 0 months, not a guess", () => {
    const rows = deriveWorkerSkills({ canonicalRoleId: "role_vmc_operator", totalYears: null }, cfg);
    expect(rows[0]?.monthsBucketed).toBe(0);
  });

  it("is DETERMINISTIC — sorted by skillId, stable across input order", () => {
    const a = deriveWorkerSkills(
      { profileSkills: ["skill_milling", "skill_turning", "skill_arc_welding"], totalYears: 2 },
      cfg,
    );
    const b = deriveWorkerSkills(
      { profileSkills: ["skill_arc_welding", "skill_milling", "skill_turning"], totalYears: 2 },
      cfg,
    );
    expect(a).toEqual(b);
    expect(a.map((r) => r.skillId)).toEqual([...a.map((r) => r.skillId)].sort());
  });

  it("ignores non-string attribute entries instead of throwing", () => {
    const rows = deriveWorkerSkills(
      { profileSkills: [null as unknown as string, 7 as unknown as string, "skill_turning"], totalYears: 1 },
      cfg,
    );
    expect(rows.map((r) => r.skillId)).toEqual(["mskill_cnc_turner"]);
  });

  it("honours a different month bucket from config", () => {
    const yearly = parseMatchConfig({ monthBucket: 12 });
    const rows = deriveWorkerSkills({ canonicalRoleId: "role_vmc_operator", totalYears: 2.5 }, yearly);
    expect(rows[0]?.monthsBucketed).toBe(24);
  });
});
