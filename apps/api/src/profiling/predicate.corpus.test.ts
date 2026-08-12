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

import {
  OccupationPinSchema,
  PROFILING_PHASES,
  type AnswerRecord,
  type OccupationPin,
  type Predicate,
  type ProfilingPhase,
} from "@badabhai/ai-contracts";

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

/**
 * Everything a predicate constrains, gathered so a probe can be built that SATISFIES it.
 *
 * `EvaluationContext` has four members and a predicate can constrain all four — answers (`answered`
 * / `declined` / the comparison operands), the occupation pin (`occupation_is`, `occupation_under`),
 * the phase (`phase_is`) and the turn (`turn_gte`). A probe set that varies only the answers would
 * report every occupation- or phase-gated condition as inert, which is a FALSE ALARM in exactly the
 * voice this file uses for a real one — the first author to write `occupation_under` would be told
 * their working predicate gates nothing.
 */
interface Demands {
  readonly fields: Set<string>;
  readonly domains: Set<string>;
  readonly iscos: Set<string>;
  turn: number;
}

function demandsOf(node: Predicate, into: Demands): Demands {
  if (typeof node.field === "string") into.fields.add(node.field);
  for (const operand of [node.left, node.right]) {
    const field = (operand as { field?: unknown } | undefined)?.field;
    if (typeof field === "string") into.fields.add(field);
  }
  if (typeof node.job_domain_id === "string") into.domains.add(node.job_domain_id);
  if (typeof node.isco_code === "string") into.iscos.add(node.isco_code);
  if (typeof node.turn === "number") into.turn = Math.max(into.turn, node.turn);
  if (node.predicate) demandsOf(node.predicate, into);
  for (const child of node.predicates ?? []) demandsOf(child, into);
  return into;
}

/** A pin the schema accepts, carrying the identity a condition asked for. */
function pin(domain: string, isco: string | null): OccupationPin {
  return OccupationPinSchema.parse({ job_domain_id: domain, label: "probe", isco_unit_code: isco });
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
 * Contexts one of which any USEFUL predicate should be true in.
 *
 * Not an attempt to prove the condition CORRECT — that is the pack author's judgement, and this is
 * deliberately not a SAT solver. It is a check for INERTNESS, which is what #776 actually was: a
 * predicate false under every reachable state gates nothing, and is indistinguishable from one
 * nobody wrote.
 *
 * Each of the four context members is varied along the axis a predicate can constrain it on:
 *   answers    — nothing answered (a `not(...)` or negated gate), the referenced fields answered
 *                (`answered`, `eq`, comparisons), and the referenced fields declined (`declined`);
 *   occupation — null, plus a pin carrying each `job_domain_id` / `isco_code` the condition names;
 *   phase      — all five, since there are only five and collecting them buys nothing;
 *   turn       — at or past the highest `turn_gte` the condition asks for (there is no `turn_lte`,
 *                so a late turn is never less satisfying than an early one).
 *
 * BIASED TOWARDS SILENCE, on purpose. A condition this cannot satisfy is reported; one it satisfies
 * only by an unreachable combination is not. Missing an inert predicate costs what #776 cost;
 * crying wolf at a working one costs this test its credibility, and a guard nobody believes is
 * worth less than no guard at all.
 */
function probes(node: Predicate): EvaluationContext[] {
  const demands = demandsOf(node, {
    fields: new Set(),
    domains: new Set(),
    iscos: new Set(),
    turn: 0,
  });

  const fields = [...demands.fields];
  const answerMaps: AnswerMap[] = [
    {} as AnswerMap,
    toAnswerMap(fields.map((f) => record(f, "answered", "yes"))),
    toAnswerMap(fields.map((f) => record(f, "declined", null))),
  ];

  const domains = [...demands.domains];
  const iscos = [...demands.iscos];
  const occupations: (OccupationPin | null)[] = [null];
  // One pin per alternative the condition names, each also carrying the other axis' first value so
  // an `all` of `occupation_is` AND `occupation_under` is satisfiable by a single pin.
  for (let i = 0; i < Math.max(domains.length, iscos.length); i++) {
    occupations.push(pin(domains[i] ?? domains[0] ?? "jd_probe", iscos[i] ?? iscos[0] ?? null));
  }

  const turn = Math.max(3, demands.turn);
  const out: EvaluationContext[] = [];
  for (const answers of answerMaps) {
    for (const occupation of occupations) {
      for (const phase of PROFILING_PHASES as readonly ProfilingPhase[]) {
        out.push({ answers, occupation, phase, turn });
      }
    }
  }
  return out;
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
      const reachable = probes(predicate).some((context) => evaluatePredicate(predicate, context));
      if (!reachable) inert.push(`${entry.pack}/${entry.questionKey}.${entry.where}`);
    }
    expect(
      inert,
      `these authored predicates are FALSE under every probed state, so they gate nothing: ` +
        `${JSON.stringify(inert)}`,
    ).toEqual([]);
  });

  it("does not call a working occupation / phase / turn gate inert", () => {
    // THE PROBE SET'S OWN GUARD. `EvaluationContext` has four members and the sweep above is only
    // as good as its coverage of them: an earlier revision varied the answers alone, so every one
    // of these — all perfectly serviceable gates — would have been reported as gating nothing.
    // The corpus authors none of them TODAY, which is exactly why this has to be asserted directly
    // rather than left to the sweep: the sweep would stay green while the trap sat armed for
    // whoever wrote the first `occupation_under`.
    const workable: readonly Predicate[] = [
      { op: "occupation_is", job_domain_id: "jd_isco_7223" },
      { op: "occupation_under", isco_code: "72" },
      { op: "phase_is", phase: "universal_tail" },
      { op: "turn_gte", turn: 40 },
      {
        op: "all",
        predicates: [
          { op: "occupation_under", isco_code: "72" },
          { op: "answered", field: "welding_process" },
          { op: "turn_gte", turn: 12 },
        ],
      },
    ];
    for (const predicate of workable) {
      const reachable = probes(predicate).some((context) => evaluatePredicate(predicate, context));
      expect(reachable, `probe set cannot satisfy ${JSON.stringify(predicate)}`).toBe(true);
    }
  });

  it("still reports a genuinely unsatisfiable condition", () => {
    // The other side of the previous test: widening the probe set must not have widened it into
    // uselessness. A contradiction has no satisfying context and must still come back inert.
    const contradiction: Predicate = {
      op: "all",
      predicates: [
        { op: "answered", field: "welding_process" },
        { op: "declined", field: "welding_process" },
      ],
    };
    const reachable = probes(contradiction).some((c) => evaluatePredicate(contradiction, c));
    expect(reachable).toBe(false);
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
