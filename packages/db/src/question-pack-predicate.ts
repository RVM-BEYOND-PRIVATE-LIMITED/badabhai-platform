/**
 * The `ask_if` / `skip_if` evaluator — a closed JSON AST, not an expression language.
 *
 * WHY A JSON AST AND NOT A STRING EXPRESSION. A pack is authored data that ends up in a
 * database and is evaluated on every turn of every interview. If the condition were a
 * string — `"answers.experience_years >= 5"` — something would have to parse it, and the
 * only cheap ways to do that in JavaScript are the ones that execute attacker-controlled
 * text. There is no parser here because there is nothing to parse: the condition arrives
 * as JSON, and this file walks it. An ops user with write access to a pack row can make
 * the engine ask a different question; they cannot make it run code.
 *
 * THE EVALUATOR CAN ONLY READ THE NORMALIZED ANSWER MAP. Not the raw utterance, not the
 * transcript, not the clock, not the worker record. That restriction is what keeps pack
 * conditions reviewable: a reader of `{"gte": [{"field": "experience_years"}, {"const":
 * 5}]}` knows exactly what it can depend on without reading this file. Widening the
 * operand set later is the change that would quietly make packs unreviewable, so operands
 * are `{field}` or `{const}` and nothing else.
 *
 * TOTAL, NEVER THROWING, AT EVALUATION TIME. A malformed node returns `false` rather than
 * raising, because the alternative is a live interview crashing on a bad pack row. Packs
 * are validated at BUILD time (`validatePredicate`) where a problem is a corpus error a
 * human fixes; at RUN time the engine's job is to keep talking to the worker. The two
 * functions are deliberately separate for exactly this reason.
 *
 * UNKNOWN = UNANSWERED, and that is a decision worth stating. `{"gte": [{"field":
 * "experience_years"}, {"const": 5}]}` is FALSE when the worker has not said, rather than
 * an error or a skip. A question gated on an unanswered field simply does not fire, which
 * is the behaviour that degrades safely when detection fails.
 */

/** The closed operator set. Adding one here means adding it in three places — see below. */
export const PREDICATE_OPS = [
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
] as const;

export type PredicateOp = (typeof PREDICATE_OPS)[number];

/** An operand reads a normalized answer, or is a literal. Nothing else. */
export type PredicateOperand =
  | { field: string }
  | { const: string | number | boolean | null };

export interface PredicateNode {
  op: PredicateOp;
  args?: unknown[];
}

/**
 * What the evaluator is allowed to see.
 *
 * Deliberately NOT the conversation envelope: passing the envelope would let a future
 * operator reach anything on it, and the point of this interface is that the reachable
 * surface is enumerable by reading five lines.
 */
export interface PredicateContext {
  /** question_key -> normalized value. Absent key means unanswered. */
  answers: Record<string, string | number | boolean | null | undefined>;
  /** question_keys the worker explicitly declined ("nahi pata"). */
  declined: ReadonlySet<string>;
  /** The pinned occupation, or null while still identifying. */
  jobDomainId: string | null;
  /** Ancestor codes of the pinned occupation, for `occupation_under`. */
  occupationAncestors: readonly string[];
  phase: string;
  /** Engine ASKS so far — not turns. The distinction matters; see interview_engine.py. */
  askCount: number;
}

/** Arity per operator. `null` means variadic (>= 1). */
const ARITY: Record<PredicateOp, number | null> = {
  all: null,
  any: null,
  not: 1,
  answered: 1,
  declined: 1,
  eq: 2,
  neq: 2,
  in: 2,
  gte: 2,
  lte: 2,
  occupation_is: 1,
  occupation_under: 1,
  phase_is: 1,
  turn_gte: 1,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isOperand(v: unknown): v is PredicateOperand {
  if (!isRecord(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1) return false;
  if (keys[0] === "field") return typeof v.field === "string" && v.field.length > 0;
  if (keys[0] === "const") {
    const c = v.const;
    return c === null || ["string", "number", "boolean"].includes(typeof c);
  }
  return false;
}

function isNode(v: unknown): v is PredicateNode {
  return isRecord(v) && typeof v.op === "string" && (PREDICATE_OPS as readonly string[]).includes(v.op);
}

/** Resolve an operand. Returns `undefined` for an unanswered field — see UNKNOWN above. */
function resolve(operand: PredicateOperand, ctx: PredicateContext): unknown {
  if ("const" in operand) return operand.const;
  return ctx.answers[operand.field];
}

/** The field name an operand names, for the validator's cross-reference check. */
function fieldOf(operand: unknown): string | null {
  return isOperand(operand) && "field" in operand ? operand.field : null;
}

/**
 * Evaluate. TOTAL — any malformed input yields `false`.
 *
 * Comparisons are type-strict: `gte` on a non-number is false rather than coerced,
 * because "5" >= 5 being true in one pack and false in another (depending on whether a
 * normalizer ran) is the kind of bug that only shows up for one trade.
 */
export function evaluatePredicate(node: unknown, ctx: PredicateContext): boolean {
  if (!isNode(node)) return false;
  const args = Array.isArray(node.args) ? node.args : [];
  const expected = ARITY[node.op];
  if (expected === null ? args.length < 1 : args.length !== expected) return false;

  switch (node.op) {
    case "all":
      return args.every((a) => evaluatePredicate(a, ctx));
    case "any":
      return args.some((a) => evaluatePredicate(a, ctx));
    case "not":
      return !evaluatePredicate(args[0], ctx);

    case "answered": {
      const f = fieldOf(args[0]);
      if (f === null) return false;
      // Declining is a COMPLETE answer for the engine's purposes, but `answered` means
      // "we have a value" — a question gated on it wants something to work with.
      const v = ctx.answers[f];
      return v !== undefined && v !== null;
    }
    case "declined": {
      const f = fieldOf(args[0]);
      return f !== null && ctx.declined.has(f);
    }

    case "eq":
    case "neq": {
      if (!isOperand(args[0]) || !isOperand(args[1])) return false;
      const a = resolve(args[0], ctx);
      const b = resolve(args[1], ctx);
      // An unanswered field compares false under BOTH operators — including `neq`, which
      // is the counter-intuitive half and the reason this is written out rather than
      // folded into the comparison below. "The worker's trade is not welding" must not
      // become true merely because they have not said what their trade is; a question
      // gated that way would fire at the top of every interview. Unknown is unknown, not
      // "different from everything".
      if (a === undefined || b === undefined) return false;
      return node.op === "eq" ? a === b : a !== b;
    }

    case "in": {
      if (!isOperand(args[0])) return false;
      const needle = resolve(args[0], ctx);
      if (needle === undefined) return false;
      const hay = args[1];
      if (!Array.isArray(hay)) return false;
      return hay.some((h) => isOperand(h) && resolve(h, ctx) === needle);
    }

    case "gte":
    case "lte": {
      if (!isOperand(args[0]) || !isOperand(args[1])) return false;
      const a = resolve(args[0], ctx);
      const b = resolve(args[1], ctx);
      if (typeof a !== "number" || typeof b !== "number") return false;
      return node.op === "gte" ? a >= b : a <= b;
    }

    case "occupation_is": {
      if (!isOperand(args[0])) return false;
      const want = resolve(args[0], ctx);
      return typeof want === "string" && ctx.jobDomainId === want;
    }
    case "occupation_under": {
      if (!isOperand(args[0])) return false;
      const want = resolve(args[0], ctx);
      return typeof want === "string" && ctx.occupationAncestors.includes(want);
    }
    case "phase_is": {
      if (!isOperand(args[0])) return false;
      const want = resolve(args[0], ctx);
      return typeof want === "string" && ctx.phase === want;
    }
    case "turn_gte": {
      if (!isOperand(args[0])) return false;
      const want = resolve(args[0], ctx);
      return typeof want === "number" && ctx.askCount >= want;
    }
  }
}

/**
 * BUILD-TIME validation. Returns every problem, never throws on the first.
 *
 * Separate from `evaluatePredicate` on purpose: this is where a malformed condition is an
 * error a human fixes, so it is exhaustive and loud. At run time the same input is
 * silently false, because a live interview must not crash over a config row.
 *
 * `knownFields` is the set of `question_key`s in the SAME pack. A condition naming a key
 * from another pack is the single most likely authoring mistake — it evaluates to false
 * forever, so the gated question simply never appears and nobody notices.
 */
export function validatePredicate(
  node: unknown,
  knownFields: ReadonlySet<string>,
  where: string,
  depth = 0,
): string[] {
  const problems: string[] = [];
  if (depth > 8) return [`${where}: predicate nested deeper than 8 levels`];
  if (!isRecord(node)) return [`${where}: predicate must be an object, got ${typeof node}`];
  if (typeof node.op !== "string") return [`${where}: predicate has no "op"`];
  if (!(PREDICATE_OPS as readonly string[]).includes(node.op)) {
    return [`${where}: unknown operator ${JSON.stringify(node.op)}. Allowed: ${PREDICATE_OPS.join(", ")}`];
  }
  const op = node.op as PredicateOp;
  const args = Array.isArray(node.args) ? node.args : [];
  const expected = ARITY[op];
  if (expected === null) {
    if (args.length < 1) problems.push(`${where}: "${op}" needs at least one argument`);
  } else if (args.length !== expected) {
    problems.push(`${where}: "${op}" takes exactly ${expected} argument(s), got ${args.length}`);
  }

  if (op === "all" || op === "any" || op === "not") {
    args.forEach((a, i) => problems.push(...validatePredicate(a, knownFields, `${where}.args[${i}]`, depth + 1)));
    return problems;
  }

  args.forEach((a, i) => {
    // `in`'s second argument is a LIST of operands, not an operand.
    if (op === "in" && i === 1) {
      if (!Array.isArray(a)) {
        problems.push(`${where}.args[1]: "in" needs an array of operands`);
        return;
      }
      a.forEach((el, j) => {
        if (!isOperand(el)) problems.push(`${where}.args[1][${j}]: not a {field} or {const} operand`);
      });
      return;
    }
    if (!isOperand(a)) {
      problems.push(`${where}.args[${i}]: not a {field} or {const} operand`);
      return;
    }
    const f = fieldOf(a);
    if (f !== null && !knownFields.has(f)) {
      problems.push(
        `${where}.args[${i}]: field ${JSON.stringify(f)} is not a question_key in this pack. ` +
          `A dangling field is false forever, so the gated question would silently never appear.`,
      );
    }
  });
  return problems;
}

/** Every `question_key` a predicate reads. Used by the validator's dependency checks. */
export function predicateFields(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (!isRecord(node)) return out;
  const args = Array.isArray(node.args) ? node.args : [];
  for (const a of args) {
    const f = fieldOf(a);
    if (f !== null) out.add(f);
    else if (Array.isArray(a)) a.forEach((el) => { const g = fieldOf(el); if (g !== null) out.add(g); });
    else if (isRecord(a)) predicateFields(a, out);
  }
  return out;
}
