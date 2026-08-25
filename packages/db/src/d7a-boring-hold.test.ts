/**
 * D-7A — `skill_boring` is HELD, and the hold has a measured shape worth protecting.
 *
 * The point of these tests is the CONTRAST with D-7B. Both are "widening crosswalks", and it
 * would be natural to treat them as one problem with one containment. The measurements say
 * otherwise:
 *
 *   D-7B  deprecation ALONE arms it — the nearest active neighbour is a bridged successor.
 *         Withholding the retag contains nothing.
 *   D-7A  deprecation alone does NOT arm it — the nearest active neighbour is `skill_drilling`,
 *         deliberately unmapped. The RETAG's alias move is what would arm it.
 *
 * So containment differs per crosswalk. Generalising one to the other is the mistake this file
 * exists to prevent.
 *
 * Nothing here selects an option. `skill_boring` stays active, unmapped, unseeded, unretagged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TO_MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { missingProvenance } from "./evidence-provenance";

interface ChainArtifact {
  skill_id: string;
  status: string;
  replaced_by: string | null;
  successor_id: string | null;
  successor_source: "production" | "corpus" | "none";
  subject_match_skills: string[] | null;
  successor_match_skills: string[] | null;
  match_skills_gained_by_retag: string[];
  crosswalk_widening: boolean;
  successor_already_reachable_domains: number;
  if_deprecated_above_floor: { alias: string; job_domain_id: string; top_skill: string; score: number }[];
}

const load = (name: string): ChainArtifact =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions", name),
      "utf8",
    ),
  ) as ChainArtifact;

const boring = load("d7a-boring-chain.json");
const chassis = load("d7b-crosswalk-chain.json");

describe("skill_boring — the held state", () => {
  it("the artifact carries provenance", () => {
    expect(missingProvenance(boring)).toEqual([]);
  });

  it("is still ACTIVE in production with no pointer — nothing was seeded", () => {
    expect(boring.status).toBe("active");
    expect(boring.replaced_by).toBeNull();
  });

  it("its successor is declared by the CORPUS only — this is the drift", () => {
    expect(boring.successor_source).toBe("corpus");
    expect(boring.successor_id).toBe("skill_turning");
  });

  it("remains deliberately unmapped, and no new mskill was invented for it", () => {
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_boring"]).toEqual([]);
    // The bridge's doctrine: near-universal shop-floor operations stay attributes.
    for (const id of ["skill_drilling", "skill_tapping_threading", "skill_deburring"]) {
      expect(ATTRIBUTE_TO_MATCH_SKILLS[id], id).toEqual([]);
    }
  });
});

describe("D-7A is the INVERSE of D-7B", () => {
  // THE CONTRAST. Same category of defect, opposite containment.
  it("D-7B's successor is already reachable today; D-7A's is not", () => {
    expect(chassis.successor_already_reachable_domains).toBeGreaterThan(0);
    expect(boring.successor_already_reachable_domains).toBe(0);
  });

  it("deprecating boring would land on an UNBRIDGED skill — no claim is conferred", () => {
    expect(boring.if_deprecated_above_floor.length).toBeGreaterThan(0);
    for (const r of boring.if_deprecated_above_floor) {
      expect(r.top_skill).toBe("skill_drilling");
      expect(ATTRIBUTE_TO_MATCH_SKILLS[r.top_skill]).toEqual([]);
    }
  });

  it("but the RETAG would still widen it, via skill_turning", () => {
    expect(boring.crosswalk_widening).toBe(true);
    expect(boring.match_skills_gained_by_retag).toEqual(["mskill_cnc_turner"]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_turning"]).toEqual(["mskill_cnc_turner"]);
  });

  it("so 'withhold the retag' contains D-7A and does NOT contain D-7B", () => {
    // Stated as an assertion so a future reader cannot collapse the two cases.
    const d7bContainedByWithholdingRetag = chassis.successor_already_reachable_domains === 0;
    const d7aContainedByWithholdingRetag = boring.successor_already_reachable_domains === 0;
    expect(d7bContainedByWithholdingRetag).toBe(false);
    expect(d7aContainedByWithholdingRetag).toBe(true);
  });
});

describe("the secondary defect seeding would introduce", () => {
  // Not a matching problem — a taxonomy-correctness one. Boring and drilling are different
  // operations, and 0.7556 is above the floor, so it would be ASSIGNED rather than left open.
  it("'boring' would canonicalize to skill_drilling above the floor", () => {
    const hit = boring.if_deprecated_above_floor.find((r) => r.alias === "boring");
    expect(hit?.top_skill).toBe("skill_drilling");
    expect(hit?.score ?? 0).toBeGreaterThanOrEqual(0.75);
  });

  it("and the corpus's intended successor would NOT win — retrieval ignores the crosswalk", () => {
    // skill_turning scores below the floor for this phrase; the crosswalk names it anyway.
    const winners = new Set(boring.if_deprecated_above_floor.map((r) => r.top_skill));
    expect(winners.has("skill_turning")).toBe(false);
    expect(boring.successor_id).toBe("skill_turning");
  });

  it("which is why D-7C seeds THREE and not four", () => {
    // The three-vs-four split is load-bearing, not tidiness.
    expect(SKILL_CORPUS.filter((s) => s.status === "deprecated").map((s) => s.skillId).sort()).toEqual([
      "skill_boring",
      "skill_cad_interpretation",
      "skill_dimensional_inspection",
      "skill_gdt_reading",
    ]);
  });
});
