import { describe, expect, it } from "vitest";

import { predicateFields, validatePredicate } from "./question-pack-predicate";

/**
 * The corpus validator, against the CONTRACT's predicate shape (#776).
 *
 * WHAT THE PREVIOUS VERSION OF THIS FILE DID WRONG. It tested a second predicate implementation
 * that lived in this package — its own op set, its own arity table, its own `evaluatePredicate` —
 * built around `{ op, args: [...] }`. It passed, thoroughly, and it was testing a shape no live
 * interview has ever evaluated. Every authored predicate in the corpus was written to match it and
 * was inert at runtime.
 *
 * So the first test below is the one that matters: the shape the old suite certified must now be
 * REJECTED. A green suite that agrees only with itself is how #776 survived review.
 */

const KNOWN = new Set(["welding_process", "welding_position", "experience_years"]);

describe("validatePredicate — the contract is the only definition (#776)", () => {
  it("REJECTS the `{op, args}` shape the old validator taught", () => {
    // The exact node that shipped in qp_welding and never fired.
    const problems = validatePredicate(
      { op: "answered", args: [{ field: "welding_process" }] },
      KNOWN,
      "item.ask_if",
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("field");
  });

  it("ACCEPTS the shape the engine evaluates", () => {
    expect(validatePredicate({ op: "answered", field: "welding_process" }, KNOWN, "w")).toEqual([]);
    expect(validatePredicate({ op: "declined", field: "welding_process" }, KNOWN, "w")).toEqual([]);
    expect(
      validatePredicate(
        { op: "gte", left: { field: "experience_years" }, right: { const: 5 } },
        KNOWN,
        "w",
      ),
    ).toEqual([]);
  });

  it("catches a DANGLING field — false forever, so the question silently never appears", () => {
    const problems = validatePredicate({ op: "answered", field: "no_such_key" }, KNOWN, "item.ask_if");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no_such_key");
    expect(problems[0]).toContain("never appear");
  });

  it("checks fields nested inside all/any/not, not just the top level", () => {
    const problems = validatePredicate(
      {
        op: "all",
        predicates: [
          { op: "answered", field: "welding_process" },
          { op: "not", predicate: { op: "declined", field: "typo_key" } },
        ],
      },
      KNOWN,
      "item.ask_if",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("typo_key");
  });

  it("rejects an unknown operator and a malformed node", () => {
    expect(validatePredicate({ op: "sometimes", field: "x" }, KNOWN, "w").length).toBeGreaterThan(0);
    expect(validatePredicate({ field: "welding_process" }, KNOWN, "w").length).toBeGreaterThan(0);
    expect(validatePredicate("answered(x)", KNOWN, "w").length).toBeGreaterThan(0);
    expect(validatePredicate(null, KNOWN, "w").length).toBeGreaterThan(0);
  });

  it("rejects an operand that is both a field and a const", () => {
    // The contract's exactly-one-of rule — previously re-implemented here, now inherited.
    expect(
      validatePredicate(
        { op: "eq", left: { field: "welding_process", const: "mig" }, right: { const: "mig" } },
        KNOWN,
        "w",
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("predicateFields", () => {
  it("collects fields from `field` and from both comparison operands", () => {
    expect([...predicateFields({ op: "answered", field: "welding_process" })]).toEqual([
      "welding_process",
    ]);
    expect(
      [...predicateFields({ op: "gte", left: { field: "experience_years" }, right: { const: 5 } })],
    ).toEqual(["experience_years"]);
  });

  it("walks nested predicates", () => {
    const fields = predicateFields({
      op: "any",
      predicates: [
        { op: "answered", field: "welding_process" },
        { op: "not", predicate: { op: "declined", field: "welding_position" } },
      ],
    });
    expect([...fields].sort()).toEqual(["welding_position", "welding_process"]);
  });

  it("returns nothing for an unparseable node rather than inventing a dependency", () => {
    // Tolerant on purpose: a malformed condition is `validatePredicate`'s finding to report, and
    // reporting it here too would surface as a phantom missing dependency in ordering analysis.
    expect([...predicateFields({ op: "answered", args: [{ field: "welding_process" }] })]).toEqual(
      [],
    );
    expect([...predicateFields(null)]).toEqual([]);
  });
});
