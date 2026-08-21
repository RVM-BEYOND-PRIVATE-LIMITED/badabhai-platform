/**
 * The distinction this audit exists to draw.
 *
 * "Reaches no match skill" has three causes with very different meanings: triaged to nothing on
 * purpose, in the corpus with the mapping forgotten, or never in the corpus at all. Only the
 * middle one is visible to the existing exhaustiveness test. Collapsing them would turn the
 * measurement into the same false comfort the audit was written to remove.
 */
import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TO_MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { classifyBridgeCoverage, readAcceptedSkillIds } from "./audit-runtime-bridge-coverage";

const CORPUS = new Set(["skill_in_mapped", "skill_in_empty", "skill_in_nokey"]);
const BRIDGE: Record<string, readonly string[]> = {
  skill_in_mapped: ["mskill_fitter"],
  skill_in_empty: [],
  // skill_in_nokey deliberately absent
};

describe("classifyBridgeCoverage", () => {
  it("separates the three reasons a skill reaches nothing", () => {
    const c = classifyBridgeCoverage(
      ["skill_in_mapped", "skill_in_empty", "skill_in_nokey", "skill_never_seeded"],
      CORPUS,
      BRIDGE,
    );
    expect(c.counts).toEqual({
      MAPPED: 1,
      INTENTIONALLY_UNMAPPED: 1,
      MISSING_MAPPING: 1,
      OUTSIDE_CORPUS: 1,
    });
  });

  it("an empty mapping is a DECISION, never confused with a missing one", () => {
    const c = classifyBridgeCoverage(["skill_in_empty"], CORPUS, BRIDGE);
    expect(c.counts.INTENTIONALLY_UNMAPPED).toBe(1);
    expect(c.counts.MISSING_MAPPING).toBe(0);
  });

  it("a skill outside the corpus is not reported as a missing mapping", () => {
    // It cannot be: the exhaustiveness test never asked about it, so nothing was forgotten.
    const c = classifyBridgeCoverage(["skill_never_seeded"], CORPUS, BRIDGE);
    expect(c.counts.OUTSIDE_CORPUS).toBe(1);
    expect(c.counts.MISSING_MAPPING).toBe(0);
    expect(c.byBucket.OUTSIDE_CORPUS).toEqual(["skill_never_seeded"]);
  });

  it("totals the input and sorts each bucket, so two runs compare cleanly", () => {
    const c = classifyBridgeCoverage(["skill_z", "skill_a"], new Set(), BRIDGE);
    expect(c.total).toBe(2);
    expect(c.byBucket.OUTSIDE_CORPUS).toEqual(["skill_a", "skill_z"]);
  });

  it("empty input is an empty report, not an error", () => {
    const c = classifyBridgeCoverage([], CORPUS, BRIDGE);
    expect(c.total).toBe(0);
    expect(c.counts.MAPPED).toBe(0);
  });
});

describe("the measurement it produced, pinned", () => {
  // Not a gate — a tripwire. If a later change moves a growth skill into SKILL_CORPUS, or
  // extends the bridge, this fails and the 9B report has to be re-stated rather than silently
  // becoming wrong. It asserts the SHAPE of the finding, not that the gap must persist.
  it("today, no promotable growth skill is inside the runtime bridge's universe", () => {
    const accepted = readAcceptedSkillIds(
      "data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d",
    );
    const c = classifyBridgeCoverage(
      accepted,
      new Set(SKILL_CORPUS.map((s) => s.skillId)),
      ATTRIBUTE_TO_MATCH_SKILLS as Readonly<Record<string, readonly string[]>>,
    );
    expect(c.total).toBe(96);
    expect(c.counts.OUTSIDE_CORPUS).toBe(96);
    expect(c.counts.MAPPED).toBe(0);
  });

  it("the bridge's universe is SKILL_CORPUS, which is why the gap is invisible to it", () => {
    const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));
    expect(Object.keys(ATTRIBUTE_TO_MATCH_SKILLS).every((k) => corpusIds.has(k))).toBe(true);
  });
});
