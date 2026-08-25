/**
 * The shipped vernacular aliases are mostly unreachable, and two of them cause a false
 * assignment. This pins that, because it is a live defect in a corpus nobody is watching.
 *
 * ===========================================================================
 * WHY A TEST OVER A COMMITTED ARTIFACT
 * ===========================================================================
 * The measurement needs production, so it cannot run in CI. What CAN run in CI is a check that
 * the committed evidence still says what the documents say it says. The artifact carries
 * `measured_at`, so a reader can see how old it is; this file makes sure nobody regenerates it
 * with different numbers and leaves the prose behind.
 *
 * Pinned two-way on purpose: if the defect is FIXED — by re-domaining the rows, by TAX-6
 * per-label domain resolution, or by de-electing the colliding embedding — regenerating the
 * artifact fails this test, in the commit that earns the change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { missingProvenance } from "./evidence-provenance";

interface Probe {
  alias: string;
  wanted: string;
  got: string | null;
  score: number | null;
  correct: boolean;
  misassignedAboveFloor: boolean;
  via: string | null;
}

interface Artifact {
  kind: string;
  scope: string;
  floor: number;
  candidate_pool: number;
  reachable: number;
  total: number;
  misassigned_above_floor: number;
  anchor_path_negative_ceiling: number;
  probes: Probe[];
}

const artifact = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions", "d60-anchor-path-retrieval.json"),
    "utf8",
  ),
) as Artifact;

describe("the committed anchor-path measurement", () => {
  it("carries provenance like every other evidence artifact", () => {
    expect(missingProvenance(artifact)).toEqual([]);
  });

  it("was taken on the slug both live call sites default to", () => {
    // job-postings.service.ts LEGACY_ANCHOR_SKILL_DOMAIN and config.py
    // skill_canonicalize_default_domain. Measuring any other scope would flatter the result.
    expect(artifact.scope).toBe("cnc-machining");
    expect(artifact.floor).toBe(0.75);
  });

  it("only 8 of the 22 shipped aliases are reachable on that scope", () => {
    expect(artifact.total).toBe(22);
    expect(artifact.reachable).toBe(8);
  });
});

describe("the defect", () => {
  const bad = artifact.probes.filter((p) => p.misassignedAboveFloor);

  // THE FINDING. Two aliases retrieve the WRONG skill at a score above the floor, so
  // canonicalization would assign it rather than leave the phrase unresolved. Both are caused
  // by `drilling ka kaam` — itself one of the 22 — because the shared Hinglish particle
  // "ka kaam" dominates the embedding. The skill path applies no particle stripping.
  it("exactly two aliases would be ASSIGNED to the wrong skill", () => {
    expect(bad.map((p) => p.alias).sort()).toEqual(["fitting ka kaam", "welding ka kaam"]);
    for (const p of bad) {
      expect(p.got, p.alias).toBe("skill_drilling");
      expect(p.via, p.alias).toBe("drilling ka kaam");
      expect(p.score ?? 0, p.alias).toBeGreaterThanOrEqual(artifact.floor);
    }
  });

  it("the anchor-path negative ceiling now EXCEEDS the floor", () => {
    // config.py records "ANCHOR-path negative ceiling 0.7263 — 0.75 clears all three".
    // That was measured on 2026-07-14, before these aliases existed.
    expect(artifact.anchor_path_negative_ceiling).toBeGreaterThan(artifact.floor);
    expect(artifact.anchor_path_negative_ceiling).toBeGreaterThan(0.7263);
  });

  it("a wrong answer BELOW the floor is not counted as a defect", () => {
    // 12 of the 14 misses score under 0.75 and therefore fail closed to UNRESOLVED, which is
    // the floor working. Only the two above it are assignments.
    const wrongBelow = artifact.probes.filter((p) => !p.correct && !p.misassignedAboveFloor);
    expect(wrongBelow).toHaveLength(12);
    expect(artifact.misassigned_above_floor).toBe(2);
  });
});
