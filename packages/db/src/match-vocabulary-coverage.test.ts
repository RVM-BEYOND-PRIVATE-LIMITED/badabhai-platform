/**
 * Q1 — the match-vocabulary tripwire.
 *
 * The safety property under test is ONE distinction:
 *
 *     MISSING_DECISION            no key   -> must FAIL
 *     INTENTIONALLY_UNMATCHED   key, []  -> may PASS
 *
 * Both reach nothing at match time. Only one of them is an answer. Every other assertion here
 * exists to stop that distinction being eroded — by widening the universe back to
 * `SKILL_CORPUS`, by treating an absent key as an empty decision, or by counting a mapping
 * that points at an `mskill_*` which does not exist.
 *
 * These tests read committed files and code only. No database, no pooler.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ATTRIBUTE_TO_MATCH_SKILLS, MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { batchScopeSkillIds } from "./embed-skill-aliases";
import { CRITERIA } from "./promote-skills";
import { missingProvenance } from "./evidence-provenance";
import {
  classifyVocabularyDecision,
  vocabularyCoverage,
  vocabularyTripwireError,
} from "./match-vocabulary-coverage";

const BATCH = "data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d";
const VALID = new Set(["mskill_fitter", "mskill_plumber"]);

interface Artifact {
  batch: string;
  universe: string;
  promotable_skills: number;
  promotable_also_in_skill_corpus: number;
  skill_corpus_size: number;
  match_vocabulary_size: number;
  bridge_keys: number;
  counts: Record<string, number>;
  by_decision: Record<string, string[]>;
  blocking: string[];
  tripwire_passed: boolean;
  decisions_generated: number;
  mappings_proposed: number;
}

const artifact = JSON.parse(
  readFileSync(
    join(
      __dirname, "..", "..", "..",
      "docs", "registers", "taxonomy-decisions", "q1-match-vocabulary-coverage.json",
    ),
    "utf8",
  ),
) as Artifact;

// ---------------------------------------------------------------------------
// THE DISTINCTION.
// ---------------------------------------------------------------------------
describe("missing a decision is not the same as deciding not to match", () => {
  it("an ABSENT key is MISSING_DECISION", () => {
    expect(classifyVocabularyDecision("skill_x", {}, VALID)).toBe("MISSING_DECISION");
  });

  it("a PRESENT key with [] is an explicit decision, and passes", () => {
    expect(classifyVocabularyDecision("skill_x", { skill_x: [] }, VALID)).toBe(
      "INTENTIONALLY_UNMATCHED",
    );
    expect(vocabularyCoverage(["skill_x"], { skill_x: [] }, VALID).passed).toBe(true);
  });

  it("the two are distinguished even though BOTH reach nothing at match time", () => {
    const missing = vocabularyCoverage(["a"], {}, VALID);
    const decided = vocabularyCoverage(["a"], { a: [] }, VALID);
    expect(missing.passed).toBe(false);
    expect(decided.passed).toBe(true);
    // Same runtime reach, opposite verdicts. That IS the safety property.
    expect(missing.counts.MISSING_DECISION).toBe(1);
    expect(decided.counts.INTENTIONALLY_UNMATCHED).toBe(1);
  });

  it("an inherited property is not a decision — hasOwnProperty, not `in`", () => {
    // `{}.toString` is truthy through the prototype chain; a naive `id in bridge` or
    // `bridge[id] !== undefined` would read Object.prototype members as decisions.
    expect(classifyVocabularyDecision("toString", {}, VALID)).toBe("MISSING_DECISION");
    expect(classifyVocabularyDecision("constructor", {}, VALID)).toBe("MISSING_DECISION");
  });
});

describe("a mapping must resolve to be a mapping", () => {
  it("maps to a real mskill -> MATCHED", () => {
    expect(classifyVocabularyDecision("a", { a: ["mskill_fitter"] }, VALID)).toBe("MATCHED");
  });

  it("maps to an unknown mskill -> INVALID_TARGET, and blocks", () => {
    const cov = vocabularyCoverage(["a"], { a: ["mskill_typo"] }, VALID);
    expect(cov.counts.INVALID_TARGET).toBe(1);
    expect(cov.passed).toBe(false);
    expect(cov.blocking).toEqual(["a"]);
  });

  it("one bad target among good ones still blocks", () => {
    expect(classifyVocabularyDecision("a", { a: ["mskill_fitter", "mskill_nope"] }, VALID)).toBe(
      "INVALID_TARGET",
    );
  });
});

describe("the refusal", () => {
  it("is null when everything is decided", () => {
    expect(vocabularyTripwireError(vocabularyCoverage(["a"], { a: [] }, VALID), "s", "b")).toBeNull();
  });

  it("names the blocking skills and both ways to resolve them", () => {
    const msg = vocabularyTripwireError(vocabularyCoverage(["a"], {}, VALID), "s", "b") ?? "";
    expect(msg).toContain("a");
    expect(msg).toContain("ATTRIBUTE_TO_MATCH_SKILLS");
    expect(msg).toMatch(/mapping into the match vocabulary/);
    expect(msg).toMatch(/stays an attribute/);
    // It must say it will not decide for you.
    expect(msg).toMatch(/NOT waivable/);
  });
});

// ---------------------------------------------------------------------------
// THE UNIVERSE. The specific way this went wrong before.
// ---------------------------------------------------------------------------
describe("the universe is the promotable batch, NOT SKILL_CORPUS", () => {
  const scope = batchScopeSkillIds(BATCH);

  it("is the batch that would actually promote", () => {
    expect(scope).toHaveLength(96);
    expect(artifact.promotable_skills).toBe(96);
    expect(artifact.universe).toMatch(/promotable batch/);
  });

  it("and SKILL_CORPUS is a DIFFERENT, non-overlapping set — the whole reason the gap existed", () => {
    const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));
    expect(corpusIds.size).toBe(49);
    // Zero overlap. The exhaustiveness test in @badabhai/taxonomy therefore asks its question
    // of NONE of the 96. If this ever becomes non-zero the two universes are converging and
    // the note below should be revisited — but it must never be assumed.
    expect(scope.filter((id) => corpusIds.has(id))).toEqual([]);
    expect(artifact.promotable_also_in_skill_corpus).toBe(0);
  });

  it("running the tripwire over SKILL_CORPUS instead would look CLEAN — the exact trap", () => {
    const valid = new Set(MATCH_SKILLS.map((m) => m.skillId));
    const wrongUniverse = vocabularyCoverage(
      SKILL_CORPUS.map((s) => s.skillId),
      ATTRIBUTE_TO_MATCH_SKILLS,
      valid,
    );
    const rightUniverse = vocabularyCoverage(batchScopeSkillIds(BATCH), ATTRIBUTE_TO_MATCH_SKILLS, valid);
    expect(wrongUniverse.passed).toBe(true); // <- a green tick that means nothing
    expect(rightUniverse.passed).toBe(false); // <- the truth
  });
});

// ---------------------------------------------------------------------------
// THE MEASUREMENT.
// ---------------------------------------------------------------------------
describe("current coverage, as committed", () => {
  it("the artifact carries provenance", () => {
    expect(missingProvenance(artifact)).toEqual([]);
  });

  it("96 of 96 promotable skills have NO match-vocabulary decision", () => {
    expect(artifact.counts["MISSING_DECISION"]).toBe(96);
    expect(artifact.counts["MATCHED"]).toBe(0);
    expect(artifact.counts["INTENTIONALLY_UNMATCHED"]).toBe(0);
    expect(artifact.counts["INVALID_TARGET"]).toBe(0);
    expect(artifact.tripwire_passed).toBe(false);
    expect(artifact.blocking).toHaveLength(96);
  });

  it("the tripwire reproduces from source — the artifact is not a stale hand-edit", () => {
    const live = vocabularyCoverage(
      batchScopeSkillIds(BATCH),
      ATTRIBUTE_TO_MATCH_SKILLS,
      new Set(MATCH_SKILLS.map((m) => m.skillId)),
    );
    expect(live.counts).toEqual(artifact.counts);
    expect(live.blocking).toEqual(artifact.blocking);
    expect(live.passed).toBe(artifact.tripwire_passed);
  });
});

// ---------------------------------------------------------------------------
// WHERE THE TRIPWIRE LIVES, and why it is not a criterion.
// ---------------------------------------------------------------------------
describe("the tripwire is a batch precondition, not a per-skill criterion", () => {
  it("the closed criteria set is still exactly seven — it was NOT grown", () => {
    // `promote-skills.test.ts` records a deliberate decision to fold new invariants into
    // existing composites rather than extend CRITERIA. Coverage is a property of the SET
    // being promoted, not of one skill's readiness, so it is enforced the way --sweep and
    // --eval are: a precondition that runs before judging.
    expect(CRITERIA).toHaveLength(7);
    for (const c of CRITERIA) expect(c).not.toMatch(/VOCAB|MATCH_SKILL/);
  });

  it("is structurally unwaivable — the refusal takes no waiver set", () => {
    // Every criterion can be waived by a human who reviewed the evidence. This one cannot,
    // because there is no such thing as reviewing a decision that was never made: the only
    // way to clear it is to make the decision. Enforced by the signature, not by convention.
    expect(vocabularyTripwireError).toHaveLength(3); // coverage, script, batchDir — no waivers
  });
});

// ---------------------------------------------------------------------------
// WHAT TASK 20 MUST NOT HAVE DONE.
// ---------------------------------------------------------------------------
describe("the tripwire decided nothing", () => {
  it("no mapping was generated and no decision was invented", () => {
    expect(artifact.decisions_generated).toBe(0);
    expect(artifact.mappings_proposed).toBe(0);
  });

  it("the bridge is untouched — still exactly its SKILL_CORPUS keys", () => {
    // 49 keys for 49 corpus skills. If a future change adds any of the 96 here, it is making
    // a product decision, and it should be reviewed as one rather than arriving with a gate.
    expect(Object.keys(ATTRIBUTE_TO_MATCH_SKILLS)).toHaveLength(49);
    expect(artifact.bridge_keys).toBe(49);
    for (const id of artifact.blocking) {
      expect(Object.prototype.hasOwnProperty.call(ATTRIBUTE_TO_MATCH_SKILLS, id), id).toBe(false);
    }
  });

  it("MATCH_SKILLS was not expanded", () => {
    expect(MATCH_SKILLS).toHaveLength(18);
    expect(artifact.match_vocabulary_size).toBe(18);
  });

  it("the pending D-7 decisions are still pending", () => {
    // skill_boring and skill_chassis_fitting must not have acquired a mapping as a side
    // effect of closing a coverage hole.
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_boring"]).toEqual([]);
    expect(ATTRIBUTE_TO_MATCH_SKILLS["skill_dimensional_inspection"]).toEqual([
      "mskill_quality_inspector",
    ]);
    // chassis_fitting is not a corpus skill and must not have been added to the bridge.
    expect(
      Object.prototype.hasOwnProperty.call(ATTRIBUTE_TO_MATCH_SKILLS, "skill_chassis_fitting"),
    ).toBe(false);
  });
});
