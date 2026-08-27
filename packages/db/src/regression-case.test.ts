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

  it("ZERO cases regress — GP-04 was fixed by one evidenced alias", () => {
    // This read `toHaveLength(1)` and named GP-04. The alias `coolant level` was added to
    // skill_coolant_management on 2026-08-26 after measuring four candidates against the
    // failing query; it scored 0.7121 against the wrong answer's 0.7031 and took the case.
    // Inverted rather than deleted: a NEW miss appearing fails here immediately.
    expect(art.misses).toEqual([]);
  });
});

describe("what GP-04 WAS, and why the fix was an alias rather than a threshold", () => {
  // The case is fixed, so there is no live miss to inspect. What must not be lost is the
  // REASONING, because it is the precedent for the 34 skills still below the floor: the remedy
  // for a below-floor correct answer is vocabulary, not a smaller number.
  it("the corpus now holds the evidenced alias, and only that one", () => {
    const skills = readFileSync(
      join(__dirname, "..", "data", "taxonomy", "skills.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter((l) => l.includes('"skill_coolant_management"'));
    expect(skills).toHaveLength(1);
    const row = JSON.parse(skills[0]!) as { aliases: { text: string; lang: string }[] };
    expect(row.aliases.map((a) => a.text)).toEqual(["coolant top up", "coolant level", "कूलेंट भरना"]);
  });

  it("the floor was NOT moved, and moving it would not have helped anyway", () => {
    // Pre-empts the tempting wrong fix, permanently. GP-04's expected skill scored 0.6630
    // BEHIND a wrong answer at 0.7031 — any floor admitting the right answer admitted the
    // wrong one first. That is why the ruling to hold 0.75 costs nothing here.
    expect(CANONICALIZATION_FLOOR).toBe(0.75);
    expect(art.floor).toBe(0.75);
  });
});
