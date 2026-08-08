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
 */
export function typedAnswerColumns(
  value: unknown,
): Pick<
  NewWorkerPackAnswer,
  "answerText" | "answerNumber" | "answerBool" | "answerOptionKeys"
> | null {
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

export interface PackAnswerRowInput {
  readonly workerId: string;
  readonly sessionId: string;
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
