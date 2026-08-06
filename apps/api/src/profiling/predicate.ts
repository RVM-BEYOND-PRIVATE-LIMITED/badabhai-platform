/**
 * The `ask_if` / `skip_if` evaluator — a pure function over a closed JSON AST.
 *
 * WHY AN AST AND NOT AN EXPRESSION STRING. A string condition needs a parser, and a parser in
 * front of reviewed-but-not-trusted content is an injection surface. `PredicateSchema` closes the
 * operator set at fourteen and the operand set at two, so there is nothing to parse and nothing to
 * escape.
 *
 * WHAT IT CAN READ, AND ONLY THIS: the normalized answer map, the occupation pin, the phase, and
 * the turn number. **Never raw text, never the transcript, never the clock.** That is the property
 * that makes pack conditions reviewable — a reviewer reading `ask_if` knows exactly which four
 * things can influence it, and `EvaluationContext` is the whole list.
 *
 * IT IS TOTAL: it never throws, for any input, including a structurally invalid predicate. A pack
 * is reviewed content that reaches this at runtime, and a malformed condition must degrade to a
 * question asked-or-skipped, never to a 500 that ends a worker's interview. Structural validation
 * is `PredicateSchema`'s job and happens at pack load; see {@link isValidPredicate}.
 *
 * THE FAIL DIRECTION IS DELIBERATE. Unevaluatable → `false`, which means an `ask_if` skips its
 * question and a `skip_if` asks it. Both are recoverable and neither fabricates an answer.
 */

import {
  PredicateSchema,
  type OccupationPin,
  type Predicate,
  type PredicateOperand,
  type ProfilingPhase,
} from "@badabhai/ai-contracts";

import type { AnswerMap } from "./answer-map";

/** Everything a predicate is allowed to see. If it is not here, a condition cannot read it. */
export interface EvaluationContext {
  readonly answers: AnswerMap;
  readonly occupation: OccupationPin | null;
  readonly phase: ProfilingPhase;
  readonly turn: number;
}

/**
 * Resolve one operand to a value.
 *
 * A `field` operand reads `value_normalized` — the value the orchestrator wrote at CAPTURE time
 * using the lexicon's normalizers. It deliberately cannot reach `value_raw`: a condition that
 * branched on the worker's exact wording would be untestable and unreviewable.
 */
function resolve(operand: PredicateOperand, ctx: EvaluationContext): unknown {
  // Takes a DEFINED operand: every caller is behind `hasBothOperands`, so a missing-operand
  // branch here would be unreachable code pretending to be a safety net.
  if (operand.field !== undefined) return ctx.answers[operand.field]?.value_normalized ?? undefined;
  return operand.const;
}

/** Both binary operands present. The contract requires them; a runtime pack may not carry them. */
function hasBothOperands(predicate: Predicate): boolean {
  return predicate.left !== undefined && predicate.right !== undefined;
}

/**
 * Numeric comparison that refuses to guess.
 *
 * Returns `null` unless BOTH sides are finite numbers. JavaScript would happily order `"10"` and
 * `9`, or `null` and `0`, and a pack condition silently comparing a string salary against a number
 * is the kind of bug that only shows up as a question that never gets asked.
 */
function compare(left: unknown, right: unknown): number | null {
  if (typeof left !== "number" || typeof right !== "number") return null;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Structural equality for `eq` / `neq` / `in`.
 *
 * Arrays compare element-wise and order-sensitively, because `multi_select` answers are stored in
 * the pack's option order — two answers with the same chips in a different order did not happen.
 * Objects are never operands (`value_normalized` is a scalar or a string array), so reference
 * equality is the honest answer for anything else.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  return Object.is(a, b);
}

/**
 * Is `code` at or below `prefix` in the ISCO hierarchy?
 *
 * ISCO codes are hierarchical by digit prefix — "7" major, "72" sub-major, "721" minor, "7212"
 * unit — so `occupation_under("72")` covers every metal-trades unit group. Matched on the DIGIT
 * PREFIX rather than `startsWith` alone so a longer code can never be "under" a shorter unrelated
 * one by string coincidence.
 */
function iscoUnder(code: string | null, prefix: string): boolean {
  if (!code || !prefix) return false;
  if (code.length < prefix.length) return false;
  return code.slice(0, prefix.length) === prefix;
}

/**
 * Evaluate a predicate against the context. Total: never throws, always returns a boolean.
 *
 * `depth` guards a pathologically nested condition from exhausting the stack. The pack validator
 * bounds nesting long before this, so hitting it means a pack reached runtime unvalidated — which
 * fails to `false`, the same direction as every other unevaluatable case.
 */
export function evaluatePredicate(
  predicate: Predicate | null | undefined,
  ctx: EvaluationContext,
  depth = 0,
): boolean {
  if (!predicate || typeof predicate !== "object" || depth > MAX_PREDICATE_DEPTH) return false;

  switch (predicate.op) {
    // An EXPLICITLY EMPTY `all` is true (vacuous truth) and an empty `any` is false — the
    // standard reading, and the one that makes `all: []` a harmless no-op condition rather than a
    // question that can never be asked.
    //
    // A MISSING or non-array `predicates` is a different thing entirely: it is malformed, and
    // must fail toward `false` like every other unevaluatable case. Coercing it to `[]` would
    // make `{op:"all"}` — a predicate the contract rejects — silently mean "always true", which
    // is the one direction that can serve a question no reviewer approved.
    case "all":
      return (
        Array.isArray(predicate.predicates) &&
        predicate.predicates.every((child) => evaluatePredicate(child, ctx, depth + 1))
      );
    case "any":
      return (
        Array.isArray(predicate.predicates) &&
        predicate.predicates.some((child) => evaluatePredicate(child, ctx, depth + 1))
      );
    case "not":
      // The child must EXIST. `{op:"not"}` alone would negate the unevaluatable `false` into a
      // `true` — a malformed predicate turning into an unconditional "yes", which is the exact
      // failure direction this evaluator exists to avoid.
      return (
        predicate.predicate !== undefined && !evaluatePredicate(predicate.predicate, ctx, depth + 1)
      );

    case "answered":
      // "answered" means a USABLE value was captured. A declined question is a complete answer
      // for completion purposes but is NOT `answered` here, because a follow-up conditioned on
      // an answer has nothing to follow up on.
      return predicate.field !== undefined && ctx.answers[predicate.field]?.status === "answered";
    case "declined":
      return predicate.field !== undefined && ctx.answers[predicate.field]?.status === "declined";

    // BOTH OPERANDS MUST BE PRESENT. Without this guard `{op:"eq"}` — a predicate the contract
    // rejects — compares `undefined` to `undefined` and returns TRUE, which is the one failure
    // direction that matters: a malformed `ask_if` would serve a question no reviewer approved.
    case "eq":
      return (
        hasBothOperands(predicate) &&
        sameValue(
          resolve(predicate.left as PredicateOperand, ctx),
          resolve(predicate.right as PredicateOperand, ctx),
        )
      );
    case "neq":
      return (
        hasBothOperands(predicate) &&
        !sameValue(
          resolve(predicate.left as PredicateOperand, ctx),
          resolve(predicate.right as PredicateOperand, ctx),
        )
      );

    case "in": {
      if (!hasBothOperands(predicate)) return false;
      const haystack = resolve(predicate.right as PredicateOperand, ctx);
      if (!Array.isArray(haystack)) return false;
      const needle = resolve(predicate.left as PredicateOperand, ctx);
      // A multi-select answer on the LEFT means "do these overlap?", which is what a pack author
      // writing `in` against a chip list intends. A scalar left is plain membership.
      if (Array.isArray(needle)) {
        return needle.some((item) => haystack.some((candidate) => sameValue(item, candidate)));
      }
      return haystack.some((candidate) => sameValue(needle, candidate));
    }

    case "gte": {
      if (!hasBothOperands(predicate)) return false;
      const order = compare(
        resolve(predicate.left as PredicateOperand, ctx),
        resolve(predicate.right as PredicateOperand, ctx),
      );
      return order !== null && order >= 0;
    }
    case "lte": {
      if (!hasBothOperands(predicate)) return false;
      const order = compare(
        resolve(predicate.left as PredicateOperand, ctx),
        resolve(predicate.right as PredicateOperand, ctx),
      );
      return order !== null && order <= 0;
    }

    case "occupation_is":
      return (
        predicate.job_domain_id !== undefined &&
        ctx.occupation?.job_domain_id === predicate.job_domain_id
      );
    case "occupation_under":
      return (
        predicate.isco_code !== undefined &&
        iscoUnder(ctx.occupation?.isco_unit_code ?? null, predicate.isco_code)
      );

    case "phase_is":
      return predicate.phase !== undefined && ctx.phase === predicate.phase;
    case "turn_gte":
      return predicate.turn !== undefined && ctx.turn >= predicate.turn;

    default:
      // An operator outside the closed set. Unreachable for a validated pack; `false` here keeps
      // the evaluator total rather than letting a bad pack end a live interview.
      return false;
  }
}

/**
 * Deep enough for any reviewable condition, shallow enough that a malicious or corrupt pack
 * cannot exhaust the stack. Packs in the corpus nest two or three levels.
 */
export const MAX_PREDICATE_DEPTH = 32;

/**
 * Is this predicate structurally valid? Run at PACK LOAD, not per turn.
 *
 * Delegates to the frozen `PredicateSchema`, which owns the per-operator arity table — so there is
 * exactly one definition of "a well-formed predicate" and this cannot drift from it. Separating
 * validation from evaluation is what lets the evaluator be total: the loud failure happens once,
 * at boot, where an operator can see it.
 */
export function isValidPredicate(candidate: unknown): candidate is Predicate {
  return PredicateSchema.safeParse(candidate).success;
}

/**
 * Should a question be served, given both of its conditions?
 *
 * ORDER IS DEFINED: `skip_if` wins. A question with both conditions true is skipped, because
 * `skip_if` is the more specific instruction — a pack author writes it to carve an exception out
 * of a broader `ask_if`.
 *
 * A null `ask_if` means "no condition", i.e. ask. A null `skip_if` means "never skip".
 */
export function isQuestionEligible(
  askIf: Predicate | null | undefined,
  skipIf: Predicate | null | undefined,
  ctx: EvaluationContext,
): boolean {
  if (skipIf && evaluatePredicate(skipIf, ctx)) return false;
  if (!askIf) return true;
  return evaluatePredicate(askIf, ctx);
}
