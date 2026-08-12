/**
 * Every authored `ask_if` / `skip_if` in the shipped corpus, run through the evaluator that
 * ACTUALLY DECIDES a live interview.
 *
 * WHY THIS FILE EXISTS (#776). The repo carried two complete predicate implementations with
 * incompatible ASTs: `packages/db`'s `{ op, args: [...] }`, which the corpus validator taught and
 * pack authors copied, and this service's `{ op, field }`, which the contract declares and the
 * engine reads. Every authored predicate was written in the first shape and evaluated to `false`
 * in the second, because `predicate.field` was `undefined`.
 *
 * A permanently-false `ask_if` means the question is NEVER ASKED. A permanently-false `skip_if`
 * means the skip NEVER FIRES. `qp_welding` shipped both: `welding_position` was never asked of any
 * welder, and `certification` was asked even when the worker declined its parent.
 *
 * NEITHER UNIT SUITE COULD SEE IT. Each exercised its own AST and passed; the corpus validator
 * only ever consulted the build-time one. The missing check was never "is this predicate valid?"
 * — both said yes about their own shape — but "does the thing that runs in production agree?"
 * That is the only question this file asks, and it is why it lives HERE, beside the runtime
 * evaluator, rather than next to the corpus it reads.
 *
 * A GOLDEN TEST over committed data, like `lookahead.corpus.test.ts`: authoring a predicate the
 * engine cannot act on fails here rather than on a worker's phone.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { AnswerRecord, Predicate } from "@badabhai/ai-contracts";

import type { AnswerMap } from "./answer-map";
import { toAnswerMap } from "./answer-map";
import { evaluatePredicate, isValidPredicate, type EvaluationContext } from "./predicate";

// Anchored to this file, not `process.cwd()` — see the note in `lookahead.corpus.test.ts`.
const PACK_DIR = join(__dirname, "../../../../packages/db/data/question-packs/packs");

interface Authored {
  readonly pack: string;
  readonly questionKey: string;
  readonly where: "ask_if" | "skip_if";
  readonly node: unknown;
}

/** Every authored condition in the committed corpus. */
function authoredPredicates(): Authored[] {
  const out: Authored[] = [];
  for (const file of readdirSync(PACK_DIR).filter((name) => name.endsWith(".json"))) {
    const raw = JSON.parse(readFileSync(join(PACK_DIR, file), "utf8")) as {
      pack_id: string;
      items?: Record<string, unknown>[];
    };
    for (const item of raw.items ?? []) {
      for (const where of ["ask_if", "skip_if"] as const) {
        const node = item[where];
        if (node != null) {
          out.push({
            pack: raw.pack_id,
            questionKey: String(item.question_key),
            where,
            node,
          });
        }
      }
    }
  }
  return out;
}

/** The `question_key`s a predicate reads, in the CONTRACT's shape. */
function fieldsOf(node: Predicate, out: Set<string> = new Set()): Set<string> {
  if (typeof node.field === "string") out.add(node.field);
  for (const operand of [node.left, node.right]) {
    const field = (operand as { field?: unknown } | undefined)?.field;
    if (typeof field === "string") out.add(field);
  }
  if (node.predicate) fieldsOf(node.predicate, out);
  for (const child of node.predicates ?? []) fieldsOf(child, out);
  return out;
}

function record(questionKey: string, status: AnswerRecord["status"], value: unknown): AnswerRecord {
  return {
    question_key: questionKey,
    target_field: questionKey,
    value_raw: null,
    value_normalized: value as never,
    status,
    evidence: null,
    turn: 1,
    history: [],
  } as AnswerRecord;
}

function ctx(answers: AnswerMap): EvaluationContext {
  return { answers, occupation: null, phase: "occupation_specific", turn: 3 };
}

/**
 * A handful of contexts one of which any USEFUL predicate should be true in.
 *
 * Not an attempt to prove the condition correct — that is the pack author's judgement. It is a
 * check for INERTNESS, which is what #776 actually was: a predicate false under every reachable
 * state gates nothing, and is indistinguishable from one nobody wrote.
 *
 * The three cover the shapes the corpus authors: nothing answered (a `not(...)` or a negated
 * gate), the referenced fields answered (`answered`, `eq`, comparisons), and the referenced
 * fields declined (`declined`).
 */
function probes(fields: readonly string[]): EvaluationContext[] {
  const answered = toAnswerMap(fields.map((f) => record(f, "answered", "yes")));
  const declined = toAnswerMap(fields.map((f) => record(f, "declined", null)));
  return [ctx({} as AnswerMap), ctx(answered), ctx(declined)];
}

describe("every authored predicate, against the RUNTIME evaluator (#776)", () => {
  const authored = authoredPredicates();

  it("finds the authored conditions at all — without this the checks below are vacuous", () => {
    // The corpus is read off disk, so a moved directory or a renamed key would yield an empty
    // list and make every `for` loop below pass by iterating nothing.
    expect(authored.length).toBeGreaterThan(0);
  });

  it("accepts EVERY authored condition as a well-formed predicate", () => {
    // This is the assertion that fails on the `{op, args}` shape: the runtime's own validity
    // check, applied to the data the corpus actually ships.
    const rejected = authored
      .filter((entry) => !isValidPredicate(entry.node))
      .map((entry) => `${entry.pack}/${entry.questionKey}.${entry.where}`);
    expect(
      rejected,
      `these authored predicates are not the shape the engine evaluates, so they are INERT — an ` +
        `ask_if that never fires means the question is never asked: ${JSON.stringify(rejected)}`,
    ).toEqual([]);
  });

  it("evaluates every authored condition to TRUE under at least one reachable state", () => {
    // The inertness check. A condition false in every probe gates nothing — which is exactly how
    // #776 presented, and is invisible to any test that only asks whether the shape parses.
    const inert: string[] = [];
    for (const entry of authored) {
      if (!isValidPredicate(entry.node)) continue; // already reported above
      const predicate = entry.node as Predicate;
      const fields = [...fieldsOf(predicate)];
      const reachable = probes(fields).some((context) => evaluatePredicate(predicate, context));
      if (!reachable) inert.push(`${entry.pack}/${entry.questionKey}.${entry.where}`);
    }
    expect(
      inert,
      `these authored predicates are FALSE under every probed state, so they gate nothing: ` +
        `${JSON.stringify(inert)}`,
    ).toEqual([]);
  });

  it("pins the two conditions #776 found inert, so a regression names them", () => {
    // Named explicitly rather than left to the sweep: these are the ones that shipped broken, and
    // a future corpus edit that reverts either should fail with the question key in the message.
    const byKey = new Map(authored.map((e) => [`${e.questionKey}.${e.where}`, e.node]));

    const askPosition = byKey.get("welding_position.ask_if");
    expect(askPosition, "qp_welding/welding_position must still gate on the parent").toBeDefined();
    expect(isValidPredicate(askPosition)).toBe(true);
    // The follow-up fires once the parent is answered — the behaviour a welder never got.
    expect(
      evaluatePredicate(
        askPosition as Predicate,
        ctx(toAnswerMap([record("welding_process", "answered", "mig")])),
      ),
    ).toBe(true);

    const skipCert = byKey.get("certification.skip_if");
    expect(skipCert, "qp_welding/certification must still skip on a declined parent").toBeDefined();
    // The skip fires when the parent was DECLINED, and not when it was answered.
    expect(
      evaluatePredicate(
        skipCert as Predicate,
        ctx(toAnswerMap([record("welding_process", "declined", null)])),
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        skipCert as Predicate,
        ctx(toAnswerMap([record("welding_process", "answered", "mig")])),
      ),
    ).toBe(false);
  });
});
