/**
 * The ask_if / skip_if evaluator.
 *
 * TWO PROPERTIES ARE LOAD-BEARING and neither is about a happy path:
 *
 *  1. EVALUATION IS TOTAL. Every malformed shape yields `false`, never a throw. A pack row
 *     is config; a live interview must not die because someone typed an operator wrong.
 *     The tests below feed it nulls, wrong arities, unknown operators and hostile-looking
 *     objects, and assert it keeps returning a boolean.
 *  2. UNKNOWN IS NOT "DIFFERENT FROM EVERYTHING". `neq` on an unanswered field is FALSE.
 *     Get this wrong and "the worker's trade is not welding" fires at the top of every
 *     interview, before anyone has said anything.
 *
 * Validation is tested separately from evaluation because they are deliberately opposite:
 * the validator is exhaustive and loud at build time, the evaluator silent at run time.
 */
import { describe, expect, it } from "vitest";

import {
  evaluatePredicate,
  predicateFields,
  validatePredicate,
  type PredicateContext,
} from "./question-pack-predicate";

function ctx(over: Partial<PredicateContext> = {}): PredicateContext {
  return {
    answers: { experience_years: 7, trade: "welding", has_iti: true },
    declined: new Set(["salary_expected"]),
    jobDomainId: "jd_nco_7212_0100",
    occupationAncestors: ["7212", "721", "72", "7"],
    phase: "OCCUPATION_SPECIFIC",
    askCount: 4,
    ...over,
  };
}

const F = (field: string) => ({ field });
const C = (value: string | number | boolean | null) => ({ const: value });

describe("evaluatePredicate — logic", () => {
  it("all / any / not compose", () => {
    const c = ctx();
    expect(evaluatePredicate({ op: "all", args: [{ op: "answered", args: [F("trade")] }, { op: "gte", args: [F("experience_years"), C(5)] }] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "any", args: [{ op: "answered", args: [F("nope")] }, { op: "answered", args: [F("trade")] }] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "not", args: [{ op: "answered", args: [F("nope")] }] }, c)).toBe(true);
  });

  it("answered is false for an absent field and for an explicit null", () => {
    expect(evaluatePredicate({ op: "answered", args: [F("nope")] }, ctx())).toBe(false);
    expect(evaluatePredicate({ op: "answered", args: [F("x")] }, ctx({ answers: { x: null } }))).toBe(false);
  });

  it("declined is separate from answered", () => {
    // "nahi pata" is a COMPLETE answer to the engine but leaves no value to work with, so
    // a question gated on `answered` must not fire while `declined` must.
    const c = ctx();
    expect(evaluatePredicate({ op: "declined", args: [F("salary_expected")] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "answered", args: [F("salary_expected")] }, c)).toBe(false);
  });

  it("eq and neq are BOTH false when the field is unanswered", () => {
    // The property that stops "trade is not welding" firing before anyone has spoken.
    const c = ctx({ answers: {} });
    expect(evaluatePredicate({ op: "eq", args: [F("trade"), C("welding")] }, c)).toBe(false);
    expect(evaluatePredicate({ op: "neq", args: [F("trade"), C("welding")] }, c)).toBe(false);
  });

  it("eq compares strictly, without coercion", () => {
    // "5" >= 5 being true in one pack and false in another, depending on whether a
    // normalizer ran, is a bug that only shows up for one trade.
    const c = ctx({ answers: { n: "7" } });
    expect(evaluatePredicate({ op: "eq", args: [F("n"), C(7)] }, c)).toBe(false);
    expect(evaluatePredicate({ op: "gte", args: [F("n"), C(5)] }, c)).toBe(false);
  });

  it("gte / lte work on numbers and refuse everything else", () => {
    const c = ctx();
    expect(evaluatePredicate({ op: "gte", args: [F("experience_years"), C(7)] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "lte", args: [F("experience_years"), C(6)] }, c)).toBe(false);
    expect(evaluatePredicate({ op: "gte", args: [F("trade"), C(5)] }, c)).toBe(false);
  });

  it("in matches against a list of operands", () => {
    const c = ctx();
    expect(evaluatePredicate({ op: "in", args: [F("trade"), [C("welding"), C("fitting")]] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "in", args: [F("trade"), [C("cooking")]] }, c)).toBe(false);
    expect(evaluatePredicate({ op: "in", args: [F("trade"), C("welding")] }, c)).toBe(false);
  });

  it("occupation_is is exact and occupation_under walks ancestors", () => {
    const c = ctx();
    expect(evaluatePredicate({ op: "occupation_is", args: [C("jd_nco_7212_0100")] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "occupation_is", args: [C("7212")] }, c)).toBe(false);
    expect(evaluatePredicate({ op: "occupation_under", args: [C("72")] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "occupation_under", args: [C("81")] }, c)).toBe(false);
  });

  it("phase_is and turn_gte read the engine, not an answer", () => {
    const c = ctx();
    expect(evaluatePredicate({ op: "phase_is", args: [C("OCCUPATION_SPECIFIC")] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "turn_gte", args: [C(4)] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "turn_gte", args: [C(5)] }, c)).toBe(false);
  });
});

describe("evaluatePredicate — TOTALITY, the run-time safety property", () => {
  const c = ctx();
  const junk: unknown[] = [
    null,
    undefined,
    42,
    "answered",
    [],
    {},
    { op: "nope", args: [] },
    { op: "all" },
    { op: "all", args: [] },
    { op: "not", args: [] },
    { op: "not", args: [F("a"), F("b")] },
    { op: "eq", args: [F("trade")] },
    { op: "eq", args: [{ field: "" }, C(1)] },
    { op: "eq", args: [{ field: "a", const: 1 }, C(1)] },
    { op: "gte", args: [{ nope: 1 }, C(1)] },
    { op: "answered", args: [C("trade")] },
    { op: "all", args: [{ op: "all", args: [{ op: "nope" }] }] },
  ];

  it("returns a boolean for every malformed shape, never throws", () => {
    for (const bad of junk) {
      expect(() => evaluatePredicate(bad, c), JSON.stringify(bad)).not.toThrow();
      expect(typeof evaluatePredicate(bad, c), JSON.stringify(bad)).toBe("boolean");
    }
  });

  it("a deeply nested structure does not blow the stack", () => {
    let node: unknown = { op: "answered", args: [F("trade")] };
    for (let i = 0; i < 200; i++) node = { op: "not", args: [node] };
    expect(() => evaluatePredicate(node, c)).not.toThrow();
  });

  it("cannot reach anything outside the context", () => {
    // The operand shape is {field}|{const}, so there is no path to a prototype, a global,
    // or the raw transcript. This pins that: a lookalike operand resolves to nothing.
    const evil = { op: "eq", args: [{ field: "__proto__" }, C("x")] };
    expect(evaluatePredicate(evil, c)).toBe(false);
    const evil2 = { op: "eq", args: [{ field: "constructor" }, C("x")] };
    expect(evaluatePredicate(evil2, c)).toBe(false);
  });
});

describe("validatePredicate — BUILD time, exhaustive and loud", () => {
  const known = new Set(["trade", "experience_years"]);

  it("accepts a well-formed predicate", () => {
    expect(validatePredicate({ op: "gte", args: [F("experience_years"), C(5)] }, known, "p")).toEqual([]);
  });

  it("rejects an unknown operator and names the allowed set", () => {
    const [p] = validatePredicate({ op: "exec", args: [] }, known, "p");
    expect(p).toContain("unknown operator");
    expect(p).toContain("occupation_under");
  });

  it("catches a dangling field — the most likely authoring mistake", () => {
    // It evaluates false forever, so the gated question silently never appears. Nothing
    // at run time would ever report it.
    const [p] = validatePredicate({ op: "answered", args: [F("typo_key")] }, known, "p");
    expect(p).toContain("not a question_key in this pack");
  });

  it("checks arity", () => {
    expect(validatePredicate({ op: "eq", args: [F("trade")] }, known, "p")[0]).toContain("exactly 2");
    expect(validatePredicate({ op: "all", args: [] }, known, "p")[0]).toContain("at least one");
  });

  it("recurses into all / any / not", () => {
    const problems = validatePredicate(
      { op: "all", args: [{ op: "answered", args: [F("ghost")] }] },
      known,
      "p",
    );
    expect(problems[0]).toContain("p.args[0].args[0]");
  });

  it("validates in's operand list", () => {
    expect(validatePredicate({ op: "in", args: [F("trade"), C("x")] }, known, "p")[0]).toContain("array of operands");
    expect(validatePredicate({ op: "in", args: [F("trade"), [{ nope: 1 }]] }, known, "p")[0]).toContain("[0]");
  });

  it("returns EVERY problem, not just the first", () => {
    // Same discipline as validateJobDomainCorpus: fixing corpus errors one exception per
    // run is miserable, and they arrive in families.
    const problems = validatePredicate(
      { op: "all", args: [{ op: "answered", args: [F("ghost1")] }, { op: "answered", args: [F("ghost2")] }] },
      known,
      "p",
    );
    expect(problems).toHaveLength(2);
  });

  it("bounds recursion depth", () => {
    let node: unknown = { op: "answered", args: [F("trade")] };
    for (let i = 0; i < 20; i++) node = { op: "not", args: [node] };
    expect(validatePredicate(node, known, "p")[0]).toContain("nested deeper");
  });
});

describe("predicateFields", () => {
  it("collects every field a predicate reads, including inside in-lists", () => {
    const node = {
      op: "all",
      args: [
        { op: "answered", args: [F("a")] },
        { op: "in", args: [F("b"), [F("c"), C("x")]] },
      ],
    };
    expect([...predicateFields(node)].sort()).toEqual(["a", "b", "c"]);
  });
});
