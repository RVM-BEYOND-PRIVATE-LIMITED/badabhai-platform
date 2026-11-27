import type { AnswerRecord } from "@badabhai/ai-contracts";
import type { WorkerPackAnswer } from "@badabhai/db";

import { projectProfile } from "../profiling/answer-map-projector";

import type { WorkerAttributeValues } from "./trade-resume-map";

/**
 * One trade section's answers, in the shape `worker_pack_answer` stores them.
 *
 * `target_field` is deliberately NOT on this row — the table never carried it — so the
 * caller resolves it from the pack's items (see below).
 */
export type StoredSectionAnswer = Pick<
  WorkerPackAnswer,
  | "questionKey"
  | "status"
  | "answerText"
  | "answerNumber"
  | "answerBool"
  | "answerOptionKeys"
  | "answerOtherText"
>;

/**
 * A trade section's attribute bag, scoped to the pack that section renders (#3086, option B).
 *
 * THE BUG THIS CLOSES. `worker_attributes` is keyed `(worker, attributeKey)` (`wa_worker_key_uq`),
 * so a worker profiled in `qp_plc_automation` and then `qp_robotics` keeps only the robotics
 * values for the keys both forms ask (`troubleshooting`, `sector_worked`, …). A PLC section
 * built from that single shared bag then prints the robotics `backup_restore` chip under its
 * own label and drops its `Industry` row. The per-form answers are NOT lost — `worker_pack_answer`
 * is keyed `(worker, pack, question)` — the section was just reading the wrong store.
 *
 * THE SHAPE: `{...shared, ...own}`, own wins per key. The shared bag stays the base so every
 * key this form never asked — universal keys, keys answered under another surface — reads
 * byte-identically to today. Only keys THIS pack answered change, and only to the values the
 * pack's own rows hold. Storage, the matcher, prefill and tier gates are untouched: they keep
 * reading the shared bag, last-write-wins, exactly as today.
 *
 * THE VALUES ARE THE WRITE PATH'S, NOT A SECOND COPY. Each row is rebuilt into the
 * `AnswerRecord` the write path projected (`recordFor`/`packAnswerRowFor`) and run through the
 * SAME `projectProfile` — same trim, same field bounds (#2233), same crosswalk drops — so a
 * section value can never disagree with what the same answer wrote to `worker_attributes`.
 *
 * FAIL-CLOSED, THREE WAYS. An unknown or retired question (`targetFieldOf` returns null)
 * contributes nothing — the shared value stands, which is today's behavior, never a dropped
 * row. An unreviewed "other" answer contributes nothing either: by write-path construction it
 * never became an attribute, and it must never reach a payer render unreviewed (see the
 * disclosure's last-line guard). A pack whose rows project to nothing returns the shared bag
 * untouched.
 *
 * WHAT THIS DOES NOT DO. A key this pack never answered still shows the shared (latest)
 * value under this pack's labels — the partial-interview residual. Hiding it would need the
 * pack's question set and a product call about whether an unanswered-but-known claim prints;
 * neither belongs in this fix. Documented here so the next reader does not re-discover it.
 */
export function scopeSectionAttributesToPack(
  shared: WorkerAttributeValues,
  answers: readonly StoredSectionAnswer[],
  targetFieldOf: (questionKey: string) => string | null,
): WorkerAttributeValues {
  const records: AnswerRecord[] = [];
  for (const row of answers) {
    // A declination settles the question but carries no value — the write path projects
    // nothing for it (`liveValues` skips non-answered records), so the shared value stands.
    if (row.status !== "answered") continue;
    const targetField = targetFieldOf(row.questionKey);
    if (targetField === null) continue;
    const value = settledValueOf(row);
    if (value === null) continue;
    records.push({
      question_key: row.questionKey,
      target_field: targetField,
      value_raw: null,
      value_normalized: value,
      evidence: null,
      // A FORM HAS NO TURNS. Zero is the honest value — the same zero `recordFor` writes.
      turn: 0,
      history: [],
      status: "answered",
    });
  }
  if (records.length === 0) return shared;
  const { attributes } = projectProfile(records);
  if (attributes.length === 0) return shared;
  const own: Record<string, unknown> = {};
  for (const attribute of attributes) own[attribute.attributeKey] = attribute.value;
  return { ...shared, ...own };
}

/**
 * The row's settled value, or null when it holds none.
 *
 * THE INVERSE OF `typedAnswerColumns`, with the same rejections. Exactly one typed column is
 * non-null on an `answered` row (`wpa_answer_shape_chk`); `answer_other_text` is the one
 * column that is never a settled value — a worker's unreviewed words against a closed
 * vocabulary, which the write path keeps out of `worker_attributes` by construction. An
 * empty option list is likewise not an answer (the write path records a declination).
 */
function settledValueOf(
  row: StoredSectionAnswer,
): string | number | boolean | readonly string[] | null {
  if (row.answerOtherText !== null && row.answerOtherText !== undefined) return null;
  if (row.answerOptionKeys !== null && row.answerOptionKeys !== undefined) {
    const keys = row.answerOptionKeys.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    return keys.length > 0 ? keys : null;
  }
  if (typeof row.answerText === "string") return row.answerText.length > 0 ? row.answerText : null;
  if (typeof row.answerNumber === "number" && Number.isFinite(row.answerNumber)) {
    return row.answerNumber;
  }
  if (typeof row.answerBool === "boolean") return row.answerBool;
  return null;
}
