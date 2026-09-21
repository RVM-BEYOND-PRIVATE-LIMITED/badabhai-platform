import type { AnswerRecord } from "@badabhai/ai-contracts";
import type { NewWorkerPackAnswer, PackAnswerSource } from "@badabhai/db";

/**
 * An `AnswerRecord` → the `worker_pack_answer` row it becomes.
 *
 * ONE DEFINITION, TWO WRITERS. The transcript flush writes every answer of a finished interview;
 * the correction path (#700) rewrites a single settled one. They must agree exactly about which
 * column a value lands in, because the two rows share a unique key and the second overwrites the
 * first — so a disagreement is not a merge conflict, it is a corrected answer landing in a
 * different column from the one it is replacing and satisfying `wpa_answer_shape_chk` while
 * meaning something else.
 *
 * Import-free of Nest on purpose: both callers are services and one importing the other would
 * close a require-time cycle, which is a failure mode this codebase has already paid for once.
 */

/**
 * Which typed column holds this value, decided by its SHAPE.
 *
 * `wpa_answer_shape_chk` is a biconditional — `answered` implies exactly one value column and
 * exactly one value column implies `answered` — so returning null here is not a soft failure, it
 * is the caller's instruction to record a declination instead of an answer.
 *
 * THE SHAPE IS THE TYPE BY THIS POINT, which is only true because normalization happened at
 * capture. A `true` that arrived as the string "true" would land in `answer_text` and be lost to
 * every boolean reader — see `typed-option-value.test.ts` for the two interviews that cost.
 *
 * `OtherAnswerValue` is checked FIRST and routes to `answer_other_text` instead of `answer_text`,
 * deliberately never falling through: a marked "other" answer is unreviewed free text against a
 * closed-option question, and landing it in `answer_text` would make it indistinguishable from a
 * settled text answer to every deterministic reader of this table (tier gates, predicate sources,
 * the `worker_attributes` projection) — exactly the "other" answer is not allowed to be.
 */
export function typedAnswerColumns(
  value: unknown,
): Pick<
  NewWorkerPackAnswer,
  "answerText" | "answerNumber" | "answerBool" | "answerOptionKeys" | "answerOtherText"
> | null {
  const other = otherAnswerTextOf(value);
  if (other !== null) return { answerOtherText: other };
  if (typeof value === "string" && value.length > 0) return { answerText: value };
  if (typeof value === "number" && Number.isFinite(value)) return { answerNumber: value };
  if (typeof value === "boolean") return { answerBool: value };
  if (Array.isArray(value)) {
    const keys = value.filter((v): v is string => typeof v === "string" && v.length > 0);
    // An array that survives the filter EMPTY is not an empty answer, it is an unrepresentable
    // one — `text[]` of length zero is non-null and would satisfy the CHECK while meaning
    // nothing. Rejected so the caller records a declination instead.
    return keys.length > 0 ? { answerOptionKeys: keys } : null;
  }
  return null;
}

/**
 * A marker `value_normalized` shape: "this is a worker's own typed words against a CLOSED-OPTION
 * question, and they have not been reviewed against that question's vocabulary."
 *
 * AN OPAQUE OBJECT, ON PURPOSE. `answer-map-projector.ts`'s `assign`/`classifyAttributeValue`
 * only ever recognise `boolean | number | string | string[]` — anything else is dropped rather
 * than stringified (its own documented rule: "coercing an object into '[object Object]' would put
 * a row no reader can interpret"). That single fact is what keeps an "other" answer out of
 * `worker_attributes` — and therefore out of every trade-sheet / payer-disclosure read of it — by
 * CONSTRUCTION, with no second exclusion rule to keep in sync. Do not widen this shape to
 * something `classifyAttributeValue` would recognise.
 */
export interface OtherAnswerValue {
  readonly kind: "other_answer";
  readonly text: string;
}

/** Build the marker `value_normalized` for a typed "other" answer. Empty text is not an answer. */
export function otherAnswerValue(text: string): OtherAnswerValue | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? { kind: "other_answer", text: trimmed } : null;
}

/** The typed text out of a marker value, or null when `value` is not one. */
export function otherAnswerTextOf(value: unknown): string | null {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "other_answer" &&
    typeof (value as { text?: unknown }).text === "string" &&
    (value as { text: string }).text.trim().length > 0
  ) {
    return (value as { text: string }).text.trim();
  }
  return null;
}

export interface PackAnswerRowInput {
  readonly workerId: string;
  readonly sessionId: string | null;
  readonly packId: string;
  readonly packVersion: number;
  readonly record: AnswerRecord;
  readonly source: PackAnswerSource;
}

/**
 * One row, or null when the record has no place in the table.
 *
 * Null for a record that is neither `answered` nor `declined` — `unanswered` and "not yet reached"
 * are the absence of an answer, and a row asserting them would make a later interview skip a
 * question nobody ever answered.
 */
export function packAnswerRowFor(input: PackAnswerRowInput): NewWorkerPackAnswer | null {
  const { record } = input;
  if (record.status !== "answered" && record.status !== "declined") return null;
  // Question keys are `^[a-z_]+$` by pack-validator construction. Re-checked because this INSERT
  // runs inside a transaction that also carries the worker's interview: a malformed key thrown
  // here would cost them the whole thing.
  if (!/^[a-z_]{1,40}$/.test(record.question_key)) return null;

  const typed = typedAnswerColumns(record.status === "answered" ? record.value_normalized : null);
  // An `answered` record whose normalized value is null or an unrepresentable shape would violate
  // `wpa_answer_shape_chk`. Downgraded to `declined` — the honest reading, since what we hold is
  // "the question is settled and there is no value" — rather than dropped, so the question is not
  // re-asked on a later interview.
  const settled = record.status === "answered" && typed !== null;

  return {
    workerId: input.workerId,
    chatSessionId: input.sessionId,
    packId: input.packId,
    packVersion: input.packVersion,
    questionKey: record.question_key,
    ...(settled ? typed : {}),
    status: settled ? "answered" : "declined",
    source: input.source,
  };
}
