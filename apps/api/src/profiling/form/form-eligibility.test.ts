import { describe, expect, it } from "vitest";

import type { QuestionPackItem } from "@badabhai/ai-contracts";
import type { WorkerPackAnswer } from "@badabhai/db";

import { answerMapFromRows, isFormQuestionVisible } from "./form-eligibility";

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "none",
    target_field: null,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: 2,
    min_turn: null,
    max_turn: null,
    ask_if: null,
    skip_if: null,
    parent_item_key: null,
    retry_text: null,
    why_text: null,
    options: [],
    ...partial,
  };
}

const row = (over: Partial<WorkerPackAnswer>): WorkerPackAnswer =>
  ({
    id: "id",
    workerId: "worker",
    chatSessionId: null,
    packId: "qp_cnc_turning",
    packVersion: 1,
    questionKey: "turning_machine",
    answerText: null,
    answerNumber: null,
    answerBool: null,
    answerOptionKeys: null,
    answerOtherText: null,
    answerOtherTextPolished: null,
    answerOtherTextPolishedDeclined: false,
    status: "answered",
    source: "form",
    answeredAt: new Date(),
    ...over,
  }) as WorkerPackAnswer;

describe("answerMapFromRows — an 'other'-only row", () => {
  // ═══ ROUND-TRIP: an other-only answer reads back as ANSWERED, never unanswered ═══
  it("reads back as answered, not unanswered, from answer_other_text alone", () => {
    const map = answerMapFromRows([
      row({ questionKey: "turning_machine", status: "answered", answerOtherText: "Batliboi lathe" }),
    ]);
    expect(map.turning_machine?.status).toBe("answered");
    expect(map.turning_machine?.value_normalized).toEqual({
      kind: "other_answer",
      text: "Batliboi lathe",
    });
  });

  it("is visible on a resumed form (already-answered always shows) without needing any typed column", () => {
    const item1 = item({ question_key: "turning_machine", answer_type: "multi_select" });
    const map = answerMapFromRows([
      row({ questionKey: "turning_machine", status: "answered", answerOtherText: "Batliboi lathe" }),
    ]);
    expect(isFormQuestionVisible(item1, map)).toBe(true);
  });

  // ═══ THE PREDICATE-EXCLUSION PARITY TEST, WITH A NON-VACUOUS FIXTURE ═══
  //
  // `turning_experience` here is named in `turning_test_advanced`'s `ask_if` — the fixture that
  // makes this test able to fail. Without a real downstream predicate reader, "excluded from
  // gates" would be an assertion about nothing.
  it("an 'other' answer settles the question but CANNOT satisfy a downstream ordering gate", () => {
    const gated = item({
      question_key: "turning_test_advanced",
      ask_if: { op: "gte", left: { field: "turning_experience" }, right: { const: 5 } },
    });
    const map = answerMapFromRows([
      row({
        questionKey: "turning_experience",
        status: "answered",
        answerOtherText: "kaafi saal ho gaye, gin ke nahi bataya",
      }),
    ]);
    // The gate's field IS settled (an other answer counts as settled), so the item is not shown
    // merely because the gate looks unanswered...
    // ...but the gate itself can never evaluate `true` off an other-answer's value — a
    // type-mismatched comparison is UNRESOLVED, and `isFormQuestionVisible` SHOWS an unresolved
    // gate rather than silently treating it as passed. That is the exclusion this test pins: an
    // other-answer can never DECIDE a gate, only ever leave it unresolved (shown), which is the
    // safe direction — never wrongly hidden, never wrongly unlocked by unreviewed text.
    expect(isFormQuestionVisible(gated, map)).toBe(true);
  });

  it("a normal numeric answer to the SAME gate DOES decide it (the fixture is real, not vacuous)", () => {
    const gated = item({
      question_key: "turning_test_advanced",
      ask_if: { op: "gte", left: { field: "turning_experience" }, right: { const: 5 } },
    });
    const belowFloor = answerMapFromRows([
      row({ questionKey: "turning_experience", status: "answered", answerNumber: 2 }),
    ]);
    expect(isFormQuestionVisible(gated, belowFloor)).toBe(false);

    const aboveFloor = answerMapFromRows([
      row({ questionKey: "turning_experience", status: "answered", answerNumber: 7 }),
    ]);
    expect(isFormQuestionVisible(gated, aboveFloor)).toBe(true);
  });
});
