/**
 * What the evaluation fixture actually covers — and the hygiene rule that keeps a vernacular
 * case measurable.
 *
 * The tripwire in the last block is unusual and deliberate: it pins a coverage gap AT ZERO.
 * `hinglish_latin` has no cases, the particle corpus that exists to handle exactly that
 * register has therefore never been evaluated, and a silent drift in either direction should
 * break a test. When the D6-1 fixture lands, this expectation changes in the same commit that
 * earns the change — which is the point.
 */
import { describe, expect, it } from "vitest";

import { occupationParticles } from "@badabhai/profiling-lexicon";

import { loadEvalFixture } from "./taxonomy-eval-fixture";
import { loadTaxonomyCorpus } from "./taxonomy-corpus";
import {
  classifyRegister,
  HYGIENE_RULE,
  siblingLexicalLeaks,
  summarizeRegisters,
} from "./vernacular-coverage";

const DEVANAGARI_RE = /[ऀ-ॿ]/u;
const latinParticles = new Set(
  [...occupationParticles().tokens, ...occupationParticles().suffixes].filter(
    (t) => !DEVANAGARI_RE.test(t),
  ),
);

const fixture = loadEvalFixture("data/taxonomy/eval/retrieval-v3.jsonl");
const corpus = loadTaxonomyCorpus();

describe("classifyRegister", () => {
  it("Devanagari script is Devanagari", () => {
    expect(classifyRegister("वेल्डिंग का काम", latinParticles)).toBe("devanagari");
  });

  it("romanized Hindi is caught by its particles, not by a language guess", () => {
    expect(classifyRegister("welding ka kaam karta hun", latinParticles)).toBe("hinglish_latin");
    expect(classifyRegister("panel ki wiring", latinParticles)).toBe("hinglish_latin");
  });

  it("plain English is English", () => {
    expect(classifyRegister("driving the forklift in the warehouse", latinParticles)).toBe(
      "english_latin",
    );
  });

  // The miscount this classifier exists to prevent.
  it("a code-switched string is Devanagari, never filed under English", () => {
    expect(classifyRegister("panel ka वायरिंग", latinParticles)).toBe("devanagari");
  });

  it("matches whole tokens — 'make' does not contain the particle 'ka'", () => {
    expect(classifyRegister("make the joint", latinParticles)).toBe("english_latin");
    expect(classifyRegister("kerb laying", latinParticles)).toBe("english_latin");
  });

  it("an empty query is English rather than a crash", () => {
    expect(classifyRegister("", latinParticles)).toBe("english_latin");
  });
});

describe("siblingLexicalLeaks — the generalized TP-36 / TP-19 rule", () => {
  const identity = new Map([
    ["skill_target", ["target skill", "target"]],
    ["skill_sibling", ["mig welding", "mig"]],
  ]);
  const siblings = new Map([["jd_x", ["skill_target", "skill_sibling"]]]);

  it("catches a positive case carrying a sibling's identity", () => {
    const leaks = siblingLexicalLeaks(
      [{ case_id: "C1", query: "changing the tip on the mig machine", job_domain_id: "jd_x", expected_skill_id: "skill_target" }],
      identity,
      siblings,
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.sibling_skill_id).toBe("skill_sibling");
    expect(leaks[0]?.token).toBe("mig");
  });

  it("does NOT object to a case using its OWN skill's words", () => {
    expect(
      siblingLexicalLeaks(
        [{ case_id: "C2", query: "doing the target work", job_domain_id: "jd_x", expected_skill_id: "skill_target" }],
        identity,
        siblings,
      ),
    ).toEqual([]);
  });

  it("skips a case with no domain scope rather than reporting a leak", () => {
    expect(
      siblingLexicalLeaks([{ case_id: "C3", query: "mig welding" }], identity, siblings),
    ).toEqual([]);
  });
});

describe("the committed fixture, measured", () => {
  const queries = fixture.cases.map((c) => c.query);
  const coverage = summarizeRegisters(queries, latinParticles);

  it("holds 168 cases in exactly two registers", () => {
    expect(coverage.total).toBe(168);
    expect(coverage.byRegister.english_latin).toBe(127);
    expect(coverage.byRegister.devanagari).toBe(41);
  });

  // THE GAP, PINNED — and scoped precisely. Romanized Hindi IS measured elsewhere, by the
  // wedge eval (`apps/ai-service/tests/wedge_eval/scores_2026_07_14.json`, 13 romanized cases).
  // What this asserts is narrower and worse: the fixture wired to the PROMOTION GATES has no
  // romanized coverage, so the register the 38-token particle corpus exists for is invisible
  // to every gate decision. Asserting the zero keeps that visible in CI.
  it("the gate-bearing fixture has NO romanized-Hindi coverage — the D-6 gap", () => {
    expect(coverage.byRegister.hinglish_latin).toBe(0);
    expect(coverage.absent).toEqual(["hinglish_latin"]);
  });

  it("declares only en and hi, though the platform's LanguageCode allows twelve", () => {
    expect([...new Set(fixture.cases.map((c) => c.lang))].sort()).toEqual(["en", "hi"]);
  });

  // Previously asserted for the 41 trainer cases only. It holds for all 168, so the weaker
  // scope was leaving the inherited v2 cases unguarded for no reason.
  it("is sibling-clean across EVERY case, not only the trainer pack", () => {
    const identity = new Map(
      corpus.skills.map((s) => [
        s.skill_id,
        [...new Set(
          [s.label_en, s.label_hi, ...(s.aliases ?? []).map((a) => a.text)]
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .map((x) => x.trim().toLowerCase()),
        )],
      ]),
    );
    const siblings = new Map<string, string[]>();
    for (const e of corpus.edges) {
      siblings.set(e.job_domain_id, [...(siblings.get(e.job_domain_id) ?? []), e.skill_id]);
    }
    expect(siblingLexicalLeaks(fixture.cases, identity, siblings)).toEqual([]);
  });
});

describe("the rule", () => {
  it("says hygiene is not translation quality", () => {
    expect(HYGIENE_RULE).toMatch(/not merely/);
    expect(HYGIENE_RULE).toMatch(/no correct answer exists/);
  });
});
