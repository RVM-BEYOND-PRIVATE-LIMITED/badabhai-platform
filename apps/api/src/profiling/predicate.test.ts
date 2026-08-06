import { describe, expect, it } from "vitest";

import type { AnswerRecord, OccupationPin, Predicate } from "@badabhai/ai-contracts";
import { PREDICATE_OPS } from "@badabhai/ai-contracts";

import type { AnswerMap } from "./answer-map";
import {
  evaluatePredicate,
  isQuestionEligible,
  isValidPredicate,
  MAX_PREDICATE_DEPTH,
  type EvaluationContext,
} from "./predicate";

function answer(partial: Partial<AnswerRecord> & { question_key: string }): AnswerRecord {
  return {
    question_key: partial.question_key,
    target_field: partial.target_field ?? null,
    value_raw: partial.value_raw ?? null,
    value_normalized: partial.value_normalized ?? null,
    status: partial.status ?? "answered",
    evidence: partial.evidence ?? null,
    turn: partial.turn ?? 1,
    history: partial.history ?? [],
  };
}

function ctx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    answers: overrides.answers ?? ({} as AnswerMap),
    occupation: overrides.occupation ?? null,
    phase: overrides.phase ?? "occupation_specific",
    turn: overrides.turn ?? 3,
  };
}

function pin(overrides: Partial<OccupationPin> = {}): OccupationPin {
  // SPREAD, not `??` per field: an rvm-minted row has `isco_unit_code: null` on purpose, and
  // `overrides.isco_unit_code ?? "7223"` silently replaces that null with the default — which
  // made this helper assert the opposite of the case it was written for.
  return {
    job_domain_id: "jd_isco_7223",
    label: "CNC Operator",
    isco_unit_code: "7223",
    match_status: "matched_lexical",
    match_score: 0.9,
    match_layer: "l0_exact",
    pack_id: null,
    pack_version: null,
    catalog_version: null,
    ...overrides,
  };
}

describe("the evaluator is TOTAL — a bad pack can never end a live interview", () => {
  it("never throws, whatever it is handed", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      {},
      { op: "nope" },
      { op: "eq" }, // arity violation: no operands
      { op: "all", predicates: null },
      { op: "not" },
      [],
      "eq",
      42,
    ];
    // Asserted per-input with the culprit in the message. A bare loop reports only "expected
    // true to be false", which costs a bisect every time one of these regresses — and three of
    // them did while this file was being written (`all` with a null list, `eq` with no operands,
    // and `not` with no child all returned TRUE).
    for (const candidate of garbage) {
      const label = JSON.stringify(candidate) ?? String(candidate);
      expect(() => evaluatePredicate(candidate as Predicate, ctx())).not.toThrow();
      expect(evaluatePredicate(candidate as Predicate, ctx()), `${label} must be false`).toBe(
        false,
      );
    }
  });

  it("survives a pathologically nested condition instead of blowing the stack", () => {
    let deep: Predicate = { op: "turn_gte", turn: 0 };
    for (let i = 0; i < MAX_PREDICATE_DEPTH + 50; i += 1) deep = { op: "not", predicate: deep };
    expect(() => evaluatePredicate(deep, ctx())).not.toThrow();
  });

  it("fails toward SKIP for ask_if and toward ASK for skip_if", () => {
    const broken = { op: "nope" } as unknown as Predicate;
    // An unevaluatable ask_if means the question is not asked; an unevaluatable skip_if means it
    // is. Both are recoverable, and neither fabricates an answer.
    expect(isQuestionEligible(broken, null, ctx())).toBe(false);
    expect(isQuestionEligible(null, broken, ctx())).toBe(true);
  });
});

describe("what a predicate is allowed to READ", () => {
  it("reads value_normalized, never value_raw", () => {
    const answers = {
      experience: answer({
        question_key: "experience",
        value_raw: "saat saal",
        value_normalized: 7,
      }),
    } as AnswerMap;
    // The raw string would not be >= 5; the normalized number is. A condition that could reach
    // raw text would be untestable and unreviewable.
    expect(
      evaluatePredicate(
        { op: "gte", left: { field: "experience" }, right: { const: 5 } },
        ctx({ answers }),
      ),
    ).toBe(true);
  });

  it("has no other inputs at all — the context type IS the whole list", () => {
    // A compile-time-ish guard: if someone widens EvaluationContext, this list must change too,
    // and that is exactly the review moment we want.
    expect(Object.keys(ctx()).sort()).toEqual(["answers", "occupation", "phase", "turn"]);
  });
});

describe("operators", () => {
  const answers = {
    city: answer({ question_key: "city", value_normalized: "Pune" }),
    declined_one: answer({ question_key: "declined_one", status: "declined" }),
    unanswered_one: answer({ question_key: "unanswered_one", status: "unanswered" }),
    years: answer({ question_key: "years", value_normalized: 7 }),
    machines: answer({ question_key: "machines", value_normalized: ["vmc", "lathe"] }),
  } as AnswerMap;

  it("distinguishes answered from declined", () => {
    const c = ctx({ answers });
    expect(evaluatePredicate({ op: "answered", field: "city" }, c)).toBe(true);
    // A DECLINED question is a complete answer for completion purposes but is not `answered`:
    // a follow-up conditioned on an answer has nothing to follow up on.
    expect(evaluatePredicate({ op: "answered", field: "declined_one" }, c)).toBe(false);
    expect(evaluatePredicate({ op: "declined", field: "declined_one" }, c)).toBe(true);
    expect(evaluatePredicate({ op: "answered", field: "unanswered_one" }, c)).toBe(false);
    expect(evaluatePredicate({ op: "answered", field: "never_seen" }, c)).toBe(false);
  });

  it("compares numbers and REFUSES to compare anything else", () => {
    const c = ctx({ answers });
    expect(evaluatePredicate({ op: "gte", left: { field: "years" }, right: { const: 7 } }, c)).toBe(
      true,
    );
    expect(evaluatePredicate({ op: "lte", left: { field: "years" }, right: { const: 6 } }, c)).toBe(
      false,
    );
    // JavaScript would happily order "10" against 9. A pack silently comparing a string salary
    // against a number is a question that never gets asked, with no error anywhere.
    expect(evaluatePredicate({ op: "gte", left: { field: "city" }, right: { const: 5 } }, c)).toBe(
      false,
    );
    expect(evaluatePredicate({ op: "gte", left: { const: null }, right: { const: 0 } }, c)).toBe(
      false,
    );
    expect(
      evaluatePredicate({ op: "gte", left: { const: Number.NaN }, right: { const: 0 } }, c),
    ).toBe(false);
  });

  it("treats eq/neq structurally, order-sensitively for arrays", () => {
    const c = ctx({ answers });
    expect(
      evaluatePredicate({ op: "eq", left: { field: "city" }, right: { const: "Pune" } }, c),
    ).toBe(true);
    expect(
      evaluatePredicate({ op: "neq", left: { field: "city" }, right: { const: "Delhi" } }, c),
    ).toBe(true);
    expect(
      evaluatePredicate(
        { op: "eq", left: { field: "machines" }, right: { const: ["vmc", "lathe"] } },
        c,
      ),
    ).toBe(true);
    // multi_select answers are stored in the pack's option order, so two answers with the same
    // chips in a different order did not happen.
    expect(
      evaluatePredicate(
        { op: "eq", left: { field: "machines" }, right: { const: ["lathe", "vmc"] } },
        c,
      ),
    ).toBe(false);
  });

  it("reads `in` as membership for a scalar and OVERLAP for a multi-select", () => {
    const c = ctx({ answers });
    expect(
      evaluatePredicate(
        { op: "in", left: { field: "city" }, right: { const: ["Pune", "Mumbai"] } },
        c,
      ),
    ).toBe(true);
    // A pack author writing `in` against a chip list means "did they pick any of these?".
    expect(
      evaluatePredicate(
        { op: "in", left: { field: "machines" }, right: { const: ["hmc", "lathe"] } },
        c,
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        { op: "in", left: { field: "machines" }, right: { const: ["hmc", "grinder"] } },
        c,
      ),
    ).toBe(false);
    // A non-array right-hand side is not a set; false rather than a coercion.
    expect(
      evaluatePredicate({ op: "in", left: { field: "city" }, right: { const: "Pune" } }, c),
    ).toBe(false);
  });

  it("matches an occupation exactly, and a family by ISCO digit prefix", () => {
    const c = ctx({ occupation: pin() });
    expect(evaluatePredicate({ op: "occupation_is", job_domain_id: "jd_isco_7223" }, c)).toBe(true);
    expect(evaluatePredicate({ op: "occupation_is", job_domain_id: "jd_isco_7222" }, c)).toBe(
      false,
    );
    // "7" major → "72" sub-major → "722" minor → "7223" unit.
    for (const prefix of ["7", "72", "722", "7223"]) {
      expect(evaluatePredicate({ op: "occupation_under", isco_code: prefix }, c)).toBe(true);
    }
    expect(evaluatePredicate({ op: "occupation_under", isco_code: "8" }, c)).toBe(false);
    // A LONGER code is not "under" a shorter one by string coincidence.
    expect(evaluatePredicate({ op: "occupation_under", isco_code: "72231" }, c)).toBe(false);
    // No pin yet: every occupation condition is false, never a crash.
    expect(evaluatePredicate({ op: "occupation_is", job_domain_id: "x" }, ctx())).toBe(false);
    expect(evaluatePredicate({ op: "occupation_under", isco_code: "7" }, ctx())).toBe(false);
    // An rvm-minted row has no ISCO code at all.
    expect(
      evaluatePredicate(
        { op: "occupation_under", isco_code: "7" },
        ctx({ occupation: pin({ isco_unit_code: null }) }),
      ),
    ).toBe(false);
  });

  it("reads phase and turn", () => {
    expect(
      evaluatePredicate(
        { op: "phase_is", phase: "universal_tail" },
        ctx({ phase: "universal_tail" }),
      ),
    ).toBe(true);
    expect(evaluatePredicate({ op: "turn_gte", turn: 3 }, ctx({ turn: 3 }))).toBe(true);
    expect(evaluatePredicate({ op: "turn_gte", turn: 4 }, ctx({ turn: 3 }))).toBe(false);
  });

  it("composes with all/any/not, empty-all true and empty-any false", () => {
    const c = ctx({ answers });
    const yes: Predicate = { op: "answered", field: "city" };
    const no: Predicate = { op: "answered", field: "never" };
    expect(evaluatePredicate({ op: "all", predicates: [yes, yes] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "all", predicates: [yes, no] }, c)).toBe(false);
    expect(evaluatePredicate({ op: "any", predicates: [no, yes] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "any", predicates: [no, no] }, c)).toBe(false);
    expect(evaluatePredicate({ op: "not", predicate: no }, c)).toBe(true);
    // Vacuous truth: `all: []` is a harmless no-op condition rather than a question that can
    // never be asked.
    expect(evaluatePredicate({ op: "all", predicates: [] }, c)).toBe(true);
    expect(evaluatePredicate({ op: "any", predicates: [] }, c)).toBe(false);
  });

  it("covers every operator the contract declares", () => {
    // Without this, adding an operator to PREDICATE_OPS and forgetting the evaluator case would
    // silently return false forever — a condition that never fires and never errors.
    const exercised = new Set<string>([
      "all",
      "any",
      "not",
      "answered",
      "declined",
      "eq",
      "neq",
      "in",
      "gte",
      "lte",
      "occupation_is",
      "occupation_under",
      "phase_is",
      "turn_gte",
    ]);
    expect([...PREDICATE_OPS].sort()).toEqual([...exercised].sort());
  });
});

describe("skip_if wins over ask_if", () => {
  it("skips when both are true", () => {
    const always: Predicate = { op: "turn_gte", turn: 0 };
    // skip_if is the more specific instruction: an author writes it to carve an exception out of
    // a broader ask_if.
    expect(isQuestionEligible(always, always, ctx())).toBe(false);
    expect(isQuestionEligible(always, null, ctx())).toBe(true);
    expect(isQuestionEligible(null, null, ctx())).toBe(true);
  });
});

describe("validation is separate from evaluation, and owns the arity table", () => {
  it("accepts a well-formed predicate and rejects a mis-arity one", () => {
    expect(isValidPredicate({ op: "answered", field: "city" })).toBe(true);
    expect(isValidPredicate({ op: "eq", left: { const: 1 }, right: { const: 1 } })).toBe(true);
    // Missing the operands its op requires...
    expect(isValidPredicate({ op: "eq" })).toBe(false);
    // ...and carrying an operand its op does not take.
    expect(isValidPredicate({ op: "answered", field: "city", turn: 3 })).toBe(false);
    expect(isValidPredicate({ op: "nope" })).toBe(false);
    // An operand is exactly one of {field} or {const}.
    expect(isValidPredicate({ op: "eq", left: {}, right: { const: 1 } })).toBe(false);
    expect(
      isValidPredicate({ op: "eq", left: { field: "a", const: 1 }, right: { const: 1 } }),
    ).toBe(false);
  });

  it("delegates to the FROZEN contract schema rather than restating the rules", async () => {
    // One definition of "well-formed", so the evaluator's guard cannot drift from the pack
    // validator's. If this import ever stops being the contract's, that is the regression.
    const { PredicateSchema } = await import("@badabhai/ai-contracts");
    expect(PredicateSchema.safeParse({ op: "eq" }).success).toBe(false);
    expect(isValidPredicate({ op: "eq" })).toBe(false);
  });
});

describe("binary operators need BOTH operands, and order strictly", () => {
  it("returns false when either operand is missing, for every binary op", () => {
    for (const op of ["eq", "neq", "in", "gte", "lte"] as const) {
      expect(
        evaluatePredicate({ op, left: { const: 1 } } as Predicate, ctx()),
        `${op} left-only`,
      ).toBe(false);
      expect(
        evaluatePredicate({ op, right: { const: 1 } } as Predicate, ctx()),
        `${op} right-only`,
      ).toBe(false);
    }
  });

  it("orders in both directions, not just the equal case", () => {
    const c = ctx();
    expect(evaluatePredicate({ op: "gte", left: { const: 9 }, right: { const: 5 } }, c)).toBe(true);
    expect(evaluatePredicate({ op: "lte", left: { const: 9 }, right: { const: 5 } }, c)).toBe(
      false,
    );
    expect(evaluatePredicate({ op: "lte", left: { const: 5 }, right: { const: 9 } }, c)).toBe(true);
    expect(evaluatePredicate({ op: "gte", left: { const: 5 }, right: { const: 5 } }, c)).toBe(true);
    expect(
      evaluatePredicate({ op: "gte", left: { const: Infinity }, right: { const: 5 } }, c),
    ).toBe(false);
  });

  it("resolves an unanswered field operand to undefined rather than crashing", () => {
    expect(
      evaluatePredicate({ op: "eq", left: { field: "never_asked" }, right: { const: "x" } }, ctx()),
    ).toBe(false);
  });
});
