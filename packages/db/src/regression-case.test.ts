/**
 * GP-04 — the one case standing between the corpus and a passing `NO_REGRESSION`.
 *
 * The gate reports `R@1 0.9912 (-0.0088)` and stops, which is correct for a gate and useless as
 * input to the decision it forces: fix the corpus, or record a waiver. This pins what the
 * measurement actually shows, so the choice is made against facts and so the facts cannot
 * quietly stop being true.
 *
 * The load-bearing one is the floor. A rank-1 miss whose winner sits at 0.70 is refused by
 * canonicalization and returns `unresolved`; a rank-1 miss at 0.85 is a confident wrong answer
 * delivered to a worker. Recall@1 cannot tell them apart — it ranks, and the floor is applied
 * downstream of ranking.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { missingProvenance } from "./evidence-provenance";
import { CANONICALIZATION_FLOOR } from "./promote-skills";
import { rankSkills, type RegressionMiss } from "./audit-regression-case";

const DOCS = join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions");

interface Artifact {
  ai_spend_inr: number;
  production_mutation_performed: boolean;
  floor: number;
  embedding_model: string;
  checked: number;
  unmeasured: string[];
  misses: RegressionMiss[];
}

const art = JSON.parse(
  readFileSync(join(DOCS, "regression-case-2026-08-26.json"), "utf8"),
) as Artifact;

describe("rankSkills", () => {
  const row = (skill: string, alias: string, score: number) => ({
    skill_id: skill,
    alias_id: alias,
    text: `t-${alias}`,
    score,
  });

  it("collapses a skill's aliases to its BEST score, as production does", () => {
    const r = rankSkills([row("a", "a1", 0.4), row("a", "a2", 0.9), row("b", "b1", 0.7)], new Set());
    expect(r.skill).toBe("a");
    expect(r.score).toBeCloseTo(0.9, 4);
  });

  it("skipping the winning ALIAS can hand the case to another skill — the whole simulation", () => {
    // A de-election removes one row, not one skill. If that row was the skill's only strong
    // alias the skill drops; if it had another, it stays. Exactly what applying the pending
    // corpus work does.
    const rows = [row("a", "a1", 0.9), row("a", "a2", 0.5), row("b", "b1", 0.7)];
    expect(rankSkills(rows, new Set(["a1"])).skill).toBe("b");
    expect(rankSkills(rows, new Set(["b1"])).skill).toBe("a");
  });

  it("returns a null skill rather than throwing when everything is skipped", () => {
    expect(rankSkills([row("a", "a1", 0.9)], new Set(["a1"]))).toEqual({
      skill: null,
      score: 0,
      via: "",
    });
  });
});

describe("the measured artifact", () => {
  it("carries provenance, cost nothing, wrote nothing", () => {
    expect(missingProvenance(art)).toEqual([]);
    expect(art.ai_spend_inr).toBe(0);
    expect(art.production_mutation_performed).toBe(false);
  });

  it("measured EVERY scoreable case — nothing was skipped for want of a vector", () => {
    // An audit that quietly drops the cases it cannot afford reports a clean bill of health
    // for a fixture it only partly ran.
    expect(art.unmeasured).toEqual([]);
    expect(art.checked).toBeGreaterThan(100);
  });

  it("exactly ONE case regresses, and it is GP-04", () => {
    expect(art.misses).toHaveLength(1);
    const m = art.misses[0]!;
    expect(m.case_id).toBe("GP-04");
    expect(m.category).toBe("paraphrase_latin");
    expect(m.expected).toEqual(["skill_coolant_management"]);
    expect(m.got_now).toBe("skill_turning");
  });
});

describe("what GP-04 actually is", () => {
  const m = art.misses[0]!;

  it("NOTHING in the candidate set clears the floor — served behaviour does not change", () => {
    // THE FACT THAT DECIDES THE WAIVER. Top-1 is 0.7031 against a 0.75 floor, so production
    // returns `unresolved` for this phrase whichever skill ranks first. The regression is real
    // in Recall@1 and invisible to a worker.
    expect(m.any_candidate_above_floor).toBe(false);
    expect(m.score_now).toBeLessThan(CANONICALIZATION_FLOOR);
    for (const r of m.ranking) expect(r.above_floor, r.skill_id).toBe(false);
  });

  it("the expected skill is SECOND, and reachable only through a Devanagari alias", () => {
    // The remedy this points at is corpus, not threshold: `skill_coolant_management` has no
    // Latin-script alias covering "coolant level", so an English paraphrase has nothing close
    // to match. Ratifying such an alias is TAX-0 gate (d) — an owner act — and no alias is
    // invented here.
    const expected = m.ranking.find((r) => r.expected)!;
    expect(m.ranking.indexOf(expected)).toBe(1);
    expect(expected.via).toBe("कूलेंट भरना");
    expect(expected.score).toBeLessThan(m.score_now);
  });

  it("and the ratified-but-unapplied corpus work does NOT fix it", () => {
    // Worth pinning both ways round: it would be convenient if the pending de-elections and
    // the D-7C seed cleared this, and they do not. Nobody should wait for step 4 expecting it.
    expect(m.fixed_by_pending).toBe(false);
    expect(m.score_after_pending).toBeCloseTo(m.score_now, 4);
  });

  it("lowering the floor would NOT rescue it either", () => {
    // Pre-empts the tempting wrong fix. The floor is prohibited from moving, and moving it
    // would not help: the expected skill is not merely below the floor, it is BEHIND a wrong
    // answer. Any floor that admits 0.6630 admits 0.7031 first.
    const expected = m.ranking.find((r) => r.expected)!;
    expect(expected.score).toBeLessThan(m.score_now);
  });
});
