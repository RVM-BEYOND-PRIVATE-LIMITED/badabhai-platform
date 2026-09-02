/**
 * WHICH OF A PACK'S QUESTIONS A FORM ACTUALLY SHOWS.
 *
 * THE DEFECT THIS CLOSES (#1378). `schema()` served every item in the pack, `ask_if` and all — so
 * a CNC turner with eight years of employment was asked the three FRESHER questions
 * (`iti_workshop_machines`, `trade_test_status`, `iti_project_work`) that the pack gates on
 * `turning_experience <= 0`. He answered them, they were written to `worker_attributes`, and then
 * `resume-render-input.ts` dropped all three because `buildFresherRows` only runs when a worker
 * has no employments. Three questions asked, three answers stored, nothing printed, no error.
 *
 * ── WHY THIS IS NOT `isQuestionEligible`, AND THE ONE PLACE IT DELIBERATELY DISAGREES ─────────
 *
 * The chat engine evaluates the same predicates through `predicate.ts`, and that module's fail
 * direction is documented and correct FOR AN INTERVIEW: unevaluatable → `false`, so an `ask_if`
 * skips its question. An interview has an ask budget and asks one question at a time, so skipping
 * a question whose gate has not been answered yet costs a worker nothing — the gate is asked
 * first, by construction, and the engine comes back round.
 *
 * A FORM HAS NEITHER PROPERTY. It is served in ONE round trip, so at the moment the list is built
 * the worker has answered nothing at all; and it has no ask budget, so an extra question costs
 * only a tap. Reusing the interview's fail direction would therefore serve a first-time worker a
 * form containing ONLY the ungated questions — hiding the tiered depth from exactly the senior
 * workers the role pack was written for, which is a worse defect than the one being fixed.
 *
 * So: an unresolved gate SHOWS its question. A gate that is answered and false HIDES it. The form
 * is never shorter than the truth, and it gets shorter — correctly — the moment the truth is
 * known, which is on the worker's next fetch.
 */
import type { Predicate, QuestionPackItem } from "@badabhai/ai-contracts";
import type { WorkerPackAnswer } from "@badabhai/db";

import { isQuestionEligible, type EvaluationContext } from "../predicate";
import type { AnswerMap } from "../answer-map";

/**
 * Every `question_key` a predicate reads.
 *
 * WHY THE FIELDS AND NOT JUST THE VERDICT. "This gate is false" and "this gate cannot be
 * evaluated yet" are the same `false` out of `evaluatePredicate`, and they call for opposite
 * behaviour here. Nothing else can tell them apart, so the fields are extracted and checked
 * against what the worker has actually settled.
 *
 * TOTAL, like the evaluator it partners. A malformed predicate yields no fields, which resolves to
 * "unresolved" and therefore to a question that is SHOWN — the same recoverable direction the rest
 * of this module fails in, and never a 500 in the middle of a worker's form.
 */
export function predicateFields(predicate: Predicate | null | undefined): string[] {
  if (!predicate || typeof predicate !== "object") return [];
  const found: string[] = [];
  if (typeof predicate.field === "string") found.push(predicate.field);
  if (typeof predicate.left?.field === "string") found.push(predicate.left.field);
  if (typeof predicate.right?.field === "string") found.push(predicate.right.field);
  for (const nested of predicate.predicates ?? []) found.push(...predicateFields(nested));
  found.push(...predicateFields(predicate.predicate));
  return [...new Set(found)];
}

/**
 * Rebuild the interview's `AnswerMap` from the rows a form has already stored.
 *
 * THE SAME COLUMN CHOICE `typedAnswerColumns` MADE ON THE WAY IN, read back in the same order, so
 * a predicate sees the value the interview would have seen for the same tap. `turning_experience`
 * is the case that matters and the case that is easiest to get wrong: its options carry
 * `value_number` and nothing else, so it lands in `answer_number` and must come back as a NUMBER —
 * `compare()` refuses to order a string against a number and returns null, which would make every
 * `gte` gate in the pack false forever. That is the #776 shape, and the pack's own `_depth` note
 * warns about it.
 *
 * A DECLINED ANSWER IS NOT A VALUE. "Pata nahi" settles the question but tells us nothing about
 * the tier, so it is carried with its status and a null value rather than being dropped — a
 * dropped row would read as unresolved and re-show questions the worker has already dealt with.
 */
export function answerMapFromRows(rows: readonly WorkerPackAnswer[]): AnswerMap {
  const map: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.status === "unanswered") continue;
    const value =
      row.status === "declined"
        ? null
        : (row.answerNumber ?? row.answerText ?? row.answerBool ?? row.answerOptionKeys ?? null);
    map[row.questionKey] = {
      question_key: row.questionKey,
      target_field: row.questionKey,
      status: row.status,
      value_raw: null,
      value_normalized: value,
      evidence: null,
      turn: 0,
      history: [],
    };
  }
  return map as AnswerMap;
}

/** A settled answer — anything a predicate may legitimately read a value out of. */
function isSettled(answers: AnswerMap, field: string): boolean {
  const record = answers[field];
  return record !== undefined && record.status !== "unanswered";
}

/** The ordering operators — the ones that need two values of the same type to mean anything. */
const ORDERING_OPS = new Set(["gte", "lte", "gt", "lt"]);

/**
 * Can this predicate's ordering comparisons actually be ordered?
 *
 * THE #776 SHAPE, CAUGHT INSTEAD OF SUFFERED. A tier gate's options must carry `value_number` and
 * nothing else; `pack-registry.service.ts` resolves an option as `valueText ?? valueNumber ??
 * valueBool`, so adding a `value_text` next to the number makes the stored answer the STRING
 * "10". `compare()` then refuses to order a string against a number and returns null, every `gte`
 * in the pack is false forever, and every tiered question is silently never asked — which is
 * exactly what happened in `qp_welding` for the life of that pack.
 *
 * The corpus validator and `cnc-turning-depth.proof.test.ts` are the primary defence and stay so.
 * This is the second one, and it is cheap: a comparison whose two sides are not even the same TYPE
 * is not a false condition, it is an unanswerable one — so the form treats it as UNRESOLVED and
 * shows the question. A mis-authored gate then costs a worker one extra screen instead of costing
 * them the entire depth the role pack was written to capture.
 */
function orderingIsResolvable(
  predicate: Predicate | null | undefined,
  answers: AnswerMap,
): boolean {
  if (!predicate || typeof predicate !== "object") return true;
  for (const nested of predicate.predicates ?? []) {
    if (!orderingIsResolvable(nested, answers)) return false;
  }
  if (!orderingIsResolvable(predicate.predicate, answers)) return false;
  if (!ORDERING_OPS.has(predicate.op)) return true;

  const side = (operand: typeof predicate.left): unknown =>
    operand?.field !== undefined
      ? answers[operand.field]?.value_normalized
      : operand?.const;
  const left = side(predicate.left);
  const right = side(predicate.right);
  if (left === undefined || right === undefined || left === null || right === null) return true;
  return typeof left === typeof right;
}

/**
 * Does this question appear on the form, given what the worker has already settled?
 *
 * ALREADY-ANSWERED ALWAYS APPEARS. A worker who answered a question before their tier was known
 * must be able to see and change that answer; hiding it would leave a value in
 * `worker_attributes` that the worker can no longer reach, which is worse than an extra screen.
 */
export function isFormQuestionVisible(item: QuestionPackItem, answers: AnswerMap): boolean {
  if (isSettled(answers, item.question_key)) return true;

  const gates = [...predicateFields(item.ask_if), ...predicateFields(item.skip_if)];
  if (gates.length === 0) return true;
  // UNRESOLVED SHOWS. See the module note: a form is one round trip, so on a first fetch nothing
  // is settled and every gate is unresolved — hiding here would serve an empty-ish form.
  if (gates.some((field) => !isSettled(answers, field))) return true;
  // A comparison whose sides are not the same type is unanswerable, not false. See
  // `orderingIsResolvable` — this is the #776 trap, downgraded from "the depth is silently never
  // asked" to "one extra screen".
  if (!orderingIsResolvable(item.ask_if, answers) || !orderingIsResolvable(item.skip_if, answers)) {
    return true;
  }

  const ctx: EvaluationContext = { answers, occupation: null, phase: "occupation_specific", turn: 0 };
  return isQuestionEligible(item.ask_if, item.skip_if, ctx);
}

/**
 * The question keys that OTHER questions in this pack are gated on.
 *
 * WHAT IT IS FOR. The form is served once, so answering a gate changes a screen list the client is
 * already holding. Rather than have the client guess, `POST /profiling/form/answer` reports that
 * the schema it fetched is now stale, and a client that cares re-fetches. A client that ignores
 * the flag behaves exactly as it does today, which is what makes this shippable ahead of the app.
 */
export function gateKeysOf(items: readonly QuestionPackItem[]): ReadonlySet<string> {
  const gates = new Set<string>();
  for (const item of items) {
    for (const field of predicateFields(item.ask_if)) gates.add(field);
    for (const field of predicateFields(item.skip_if)) gates.add(field);
  }
  return gates;
}
