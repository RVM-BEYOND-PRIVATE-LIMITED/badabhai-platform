/**
 * D-7C — the three "match-set neutral" deprecations, verified through HOP 0.
 *
 * Two things are asserted here, and they are not the same thing:
 *
 *   1. MATCH-SET NEUTRALITY holds. No phrase gains an `mskill_*` it could not already confer.
 *      This is the claim D-7C rests on, and it is now measured through the retrieval hop
 *      rather than inferred from a bridge subtraction.
 *   2. NEUTRALITY IS NOT SAFETY. The same measurement found two above-floor misassignments
 *      and nine phrases that stop resolving. A future reader who quotes (1) without (2) will
 *      seed a defect that this file already found.
 *
 * The D-7A/D-7C distinction is pinned explicitly: `skill_boring` is excluded, and the reason
 * it is excluded is the SAME defect class that one of the three D-7C subjects turns out to
 * exhibit. Generalising "these are neutral, therefore deprecations are safe" is the mistake
 * these tests exist to block.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TO_MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import {
  classifyLanding,
  D7C_SEED_EXCLUSIONS,
  matchSetDelta,
  summarizeHop0,
  type Hop0Input,
  type Hop0Observation,
} from "./deprecation-hop0";
import { missingProvenance } from "./evidence-provenance";
import { heldSkillIds } from "./seed-skills";

const FLOOR = 0.75;

const D7C = ["skill_gdt_reading", "skill_cad_interpretation", "skill_dimensional_inspection"];

interface ArtifactObservation extends Hop0Observation {
  successor_id: string | null;
  verdict: string;
  subject_bridge: string[];
  landing_bridge: string[];
}

interface Artifact {
  floor: number;
  subjects: string[];
  excluded: Record<string, string>;
  production_state: {
    skill_id: string;
    status: string;
    replaced_by: string | null;
    corpus_successor: string | null;
    active_edges: number;
  }[];
  observations: ArtifactObservation[];
  summary: {
    total: number;
    match_set_neutral: boolean;
    gained_match_skills: string[];
    misassignments: number;
    coverage_losses: number;
    neutral_only_via_floor: number;
  };
  production_mutation_performed: boolean;
}

const artifact = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions", "d7c-hop0.json"),
    "utf8",
  ),
) as Artifact;

const obs = (phrase: string, scope: string): ArtifactObservation => {
  const found = artifact.observations.find((o) => o.phrase === phrase && o.scope === scope);
  if (found === undefined) throw new Error(`no observation for "${phrase}" in ${scope}`);
  return found;
};

// ---------------------------------------------------------------------------
// The rule, tested without a database.
// ---------------------------------------------------------------------------
describe("classifyLanding", () => {
  const base = {
    subject: "s",
    phrase: "p",
    scope: "d",
    scopeKind: "legacy" as const,
    today: { skillId: "s", score: 1 },
  };

  it("UNCHANGED outranks everything — a landing that already happens is not caused by the deprecation", () => {
    // The successor carrying a duplicate alias is the NORMAL post-merge state, so this branch
    // is the common case, not an edge case.
    const o = { ...base, today: { skillId: "succ", score: 1 }, ifSeeded: { skillId: "succ", score: 1 } };
    expect(classifyLanding(o, "succ", FLOOR)).toBe("UNCHANGED");
    // ...and it stays UNCHANGED even when the landing is NOT the declared successor.
    expect(classifyLanding({ ...o, today: { skillId: "other", score: 1 }, ifSeeded: { skillId: "other", score: 1 } }, "succ", FLOOR)).toBe("UNCHANGED");
  });

  it("separates the successor from any other above-floor landing", () => {
    expect(classifyLanding({ ...base, ifSeeded: { skillId: "succ", score: 0.9 } }, "succ", FLOOR)).toBe("LANDS_ON_SUCCESSOR");
    expect(classifyLanding({ ...base, ifSeeded: { skillId: "other", score: 0.9 } }, "succ", FLOOR)).toBe("LANDS_ELSEWHERE_ABOVE_FLOOR");
  });

  it("treats a below-floor landing and an empty scope alike — neither resolves", () => {
    expect(classifyLanding({ ...base, ifSeeded: { skillId: "other", score: 0.74 } }, "succ", FLOOR)).toBe("FALLS_BELOW_FLOOR");
    expect(classifyLanding({ ...base, ifSeeded: null }, "succ", FLOOR)).toBe("FALLS_BELOW_FLOOR");
  });

  it("uses >= at the floor, matching the runtime comparison", () => {
    expect(classifyLanding({ ...base, ifSeeded: { skillId: "succ", score: FLOOR } }, "succ", FLOOR)).toBe("LANDS_ON_SUCCESSOR");
  });
});

describe("matchSetDelta", () => {
  it("confers the LANDING's bridge, not the successor's — the whole point of HOP 0", () => {
    const d = matchSetDelta([], { skillId: "other", score: 0.9 }, ["mskill_fitter"], FLOOR);
    expect(d.gained).toEqual(["mskill_fitter"]);
  });

  it("a below-floor landing confers nothing, and says so was the floor's doing", () => {
    const d = matchSetDelta([], { skillId: "other", score: 0.6 }, ["mskill_cam_programmer"], FLOOR);
    expect(d.gained).toEqual([]);
    expect(d.neutralOnlyViaFloor).toBe(true);
  });

  it("an unbridged landing below the floor is not 'neutral only via floor' — nothing was at stake", () => {
    expect(matchSetDelta([], { skillId: "other", score: 0.6 }, [], FLOOR).neutralOnlyViaFloor).toBe(false);
  });

  it("identical bridges gain and lose nothing", () => {
    const d = matchSetDelta(["mskill_quality_inspector"], { skillId: "succ", score: 0.9 }, ["mskill_quality_inspector"], FLOOR);
    expect(d.gained).toEqual([]);
    expect(d.lost).toEqual([]);
  });
});

describe("summarizeHop0", () => {
  const mk = (score: number, landingBridge: string[]): Hop0Input => ({
    observation: {
      subject: "s", phrase: "p", scope: "d", scopeKind: "legacy",
      today: { skillId: "s", score: 1 },
      ifSeeded: { skillId: "other", score },
    },
    successorId: "succ",
    subjectBridge: [],
    landingBridge,
  });

  it("is NOT neutral the moment any single observation gains a claim", () => {
    const s = summarizeHop0([mk(0.6, []), mk(0.9, ["mskill_fitter"])], FLOOR);
    expect(s.matchSetNeutral).toBe(false);
    expect(s.gainedMatchSkills).toEqual(["mskill_fitter"]);
  });

  it("reports misassignment and coverage loss separately from neutrality", () => {
    const s = summarizeHop0([mk(0.9, []), mk(0.6, [])], FLOOR);
    expect(s.matchSetNeutral).toBe(true);
    expect(s.misassignments).toHaveLength(1); // above floor, not the successor
    expect(s.coverageLosses).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The measurement.
// ---------------------------------------------------------------------------
describe("D-7C measured against production", () => {
  it("the artifact carries provenance and records that nothing was written", () => {
    expect(missingProvenance(artifact)).toEqual([]);
    expect(artifact.production_mutation_performed).toBe(false);
  });

  it("measures exactly the three, at the floor that is actually shipped", () => {
    expect([...artifact.subjects].sort()).toEqual([...D7C].sort());
    expect(artifact.floor).toBe(FLOOR);
  });

  it("all three are still ACTIVE in production — nothing was seeded", () => {
    for (const r of artifact.production_state) {
      expect(r.status, r.skill_id).toBe("active");
      expect(r.replaced_by, r.skill_id).toBeNull();
    }
  });

  // THE CLAIM D-7C RESTS ON.
  it("MATCH-SET NEUTRAL: no phrase gains a match skill, in any scope", () => {
    expect(artifact.summary.match_set_neutral).toBe(true);
    expect(artifact.summary.gained_match_skills).toEqual([]);
  });

  it("every above-floor landing is either unbridged or carries the subject's own claim", () => {
    // The mechanical reason neutrality holds — asserted so a future re-measure that breaks it
    // fails here rather than in a document nobody re-reads.
    for (const o of artifact.observations) {
      if (o.ifSeeded === null || o.ifSeeded.score < FLOOR) continue;
      for (const m of o.landing_bridge) expect(o.subject_bridge, `${o.phrase} @ ${o.scope}`).toContain(m);
    }
  });

  it("both retrieval scopes were measured — one alone would have missed the defect", () => {
    const kinds = new Set(artifact.observations.map((o) => o.scopeKind));
    expect(kinds).toEqual(new Set(["legacy", "canonical"]));
    // The two misassignments are canonical-only; a legacy-only audit reports a clean pass.
    const bad = artifact.observations.filter((o) => o.verdict === "LANDS_ELSEWHERE_ABOVE_FLOOR");
    expect(bad.every((o) => o.scopeKind === "canonical")).toBe(true);
  });
});

describe("neutral is not the same as safe", () => {
  it("skill_gdt_reading is the genuinely clean one — every phrase lands on the named successor", () => {
    const its = artifact.observations.filter((o) => o.subject === "skill_gdt_reading");
    expect(its).toHaveLength(4);
    for (const o of its) {
      expect(o.ifSeeded?.skillId, o.phrase).toBe("skill_drawing_reading");
      expect(o.ifSeeded?.score, o.phrase).toBe(1);
    }
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_gdt_reading"]).toEqual([]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_drawing_reading"]).toEqual([]);
  });

  it("skill_cad_interpretation is neutral only because the floor holds it back", () => {
    // All four phrases stop resolving; two of the skills they fall onto ARE bridged. Neutral
    // today, and neutral for exactly as long as 0.75 stays where it is.
    const its = artifact.observations.filter((o) => o.subject === "skill_cad_interpretation");
    expect(its).toHaveLength(4);
    expect(its.every((o) => o.verdict === "FALLS_BELOW_FLOOR")).toBe(true);
    const bridgedLandings = its.filter((o) => o.landing_bridge.length > 0);
    expect(bridgedLandings.length).toBeGreaterThan(0);
    for (const o of bridgedLandings) expect(o.ifSeeded?.score).toBeLessThan(FLOOR);
  });

  it("skill_dimensional_inspection carries a BORING-CLASS misassignment", () => {
    // 'dimensional inspection' -> skill_drawing_reading above the floor, in BOTH canonical
    // domains. Reading a drawing is not inspecting a part. Unbridged, so no claim — which is
    // precisely the shape of the D-7A defect that got skill_boring held back.
    for (const scope of ["jd_nco_7313_2601", "jd_nco_7543_2001"]) {
      const o = obs("dimensional inspection", scope);
      expect(o.verdict).toBe("LANDS_ELSEWHERE_ABOVE_FLOOR");
      expect(o.ifSeeded?.skillId).toBe("skill_drawing_reading");
      expect(o.ifSeeded?.score).toBeGreaterThanOrEqual(FLOOR);
      expect(o.successor_id).toBe("skill_quality_control");
      expect(o.landing_bridge).toEqual([]);
    }
    expect(artifact.summary.misassignments).toBe(2);
  });

  it("its one above-floor CORRECT landing is 'quality check', which keeps the identical claim", () => {
    const o = obs("quality check", "metrology-quality");
    expect(o.verdict).toBe("LANDS_ON_SUCCESSOR");
    expect(o.ifSeeded?.skillId).toBe("skill_quality_control");
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_dimensional_inspection"]).toEqual(["mskill_quality_inspector"]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_quality_control"]).toEqual(["mskill_quality_inspector"]);
  });
});

// ---------------------------------------------------------------------------
// The D-7A / D-7C distinction. The user's explicit requirement.
// ---------------------------------------------------------------------------
describe("D-7A stays out, and the reason generalises to one of the three", () => {
  it("skill_boring is excluded by name, with a recorded reason", () => {
    expect(Object.keys(D7C_SEED_EXCLUSIONS)).toContain("skill_boring");
    expect(D7C_SEED_EXCLUSIONS["skill_boring"]).toMatch(/D-7A/);
    expect(artifact.subjects).not.toContain("skill_boring");
    expect(Object.keys(artifact.excluded)).toContain("skill_boring");
  });

  it("no measurement in this artifact touches skill_boring", () => {
    for (const o of artifact.observations) {
      expect(o.subject).not.toBe("skill_boring");
      expect(o.ifSeeded?.skillId ?? "").not.toBe("skill_boring");
    }
  });

  it("boring and dimensional_inspection share ONE defect class and differ in claim", () => {
    // Both: above-floor landing on a skill the crosswalk never named.
    // Boring's landing (skill_drilling) and dimensional_inspection's (skill_drawing_reading)
    // are both unbridged, so NEITHER creates a match claim. The defect is taxonomy
    // correctness in both cases — which is why neutrality did not clear boring, and does not
    // by itself clear dimensional_inspection.
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_drilling"]).toEqual([]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_drawing_reading"]).toEqual([]);
    const di = obs("dimensional inspection", "jd_nco_7313_2601");
    expect(di.verdict).toBe("LANDS_ELSEWHERE_ABOVE_FLOOR");
  });

  it("the corpus still deprecates exactly four, so the three-of-four split stays deliberate", () => {
    expect(SKILL_CORPUS.filter((s) => s.status === "deprecated").map((s) => s.skillId).sort()).toEqual([
      "skill_boring",
      "skill_cad_interpretation",
      "skill_dimensional_inspection",
      "skill_gdt_reading",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Why no seed ran.
// ---------------------------------------------------------------------------
describe("the existing mechanism cannot seed three of four", () => {
  it("--preserve-existing-status is all-or-nothing: it holds every differing row", () => {
    const allActive = new Map(
      SKILL_CORPUS.filter((s) => s.status === "deprecated").map((s) => [s.skillId, "active"]),
    );
    const held = heldSkillIds(SKILL_CORPUS, allActive).map((h) => h.skillId);
    // With the flag: all four held, nothing seeded. Without it: all four written, boring
    // included. There is no third invocation, so no way to write exactly the three.
    expect(held).toEqual([
      "skill_boring",
      "skill_cad_interpretation",
      "skill_dimensional_inspection",
      "skill_gdt_reading",
    ]);
    expect(held).toContain("skill_boring");
  });

  it("so the seed is blocked, and the artifact records that nothing was written", () => {
    expect(artifact.production_mutation_performed).toBe(false);
    for (const r of artifact.production_state) expect(r.status).toBe("active");
  });
});
