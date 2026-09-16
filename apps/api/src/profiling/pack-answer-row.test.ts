import { describe, expect, it } from "vitest";

import type { AnswerRecord } from "@badabhai/ai-contracts";

import {
  otherAnswerTextOf,
  otherAnswerValue,
  packAnswerRowFor,
  typedAnswerColumns,
} from "./pack-answer-row";

const baseRecord = (over: Partial<AnswerRecord>): AnswerRecord => ({
  question_key: "turning_machine",
  target_field: null,
  value_raw: null,
  value_normalized: null,
  status: "unanswered",
  evidence: null,
  turn: 0,
  history: [],
  ...over,
});

describe("otherAnswerValue / otherAnswerTextOf", () => {
  it("round-trips non-empty text", () => {
    expect(otherAnswerTextOf(otherAnswerValue("Batliboi lathe"))).toBe("Batliboi lathe");
  });

  it("is null for empty/whitespace text — not an answer", () => {
    expect(otherAnswerValue("   ")).toBeNull();
    expect(otherAnswerValue("")).toBeNull();
  });

  it("does not recognise a plain string as the marker (must be the tagged object)", () => {
    expect(otherAnswerTextOf("Batliboi lathe")).toBeNull();
  });

  it("does not recognise a look-alike object missing the tag", () => {
    expect(otherAnswerTextOf({ text: "Batliboi lathe" })).toBeNull();
  });
});

describe("typedAnswerColumns — the 'other' marker routes to answer_other_text alone", () => {
  it("never lands in answer_text, even though both are strings", () => {
    const columns = typedAnswerColumns(otherAnswerValue("Batliboi lathe"));
    expect(columns).toEqual({ answerOtherText: "Batliboi lathe" });
  });

  it("a plain string still routes to answer_text (unaffected)", () => {
    expect(typedAnswerColumns("Batliboi lathe")).toEqual({ answerText: "Batliboi lathe" });
  });
});

describe("packAnswerRowFor — exactly one row per answered record, 'other' shape", () => {
  it("produces ONE row, in answer_other_text, with every typed column absent", () => {
    const row = packAnswerRowFor({
      workerId: "w1",
      sessionId: "s1",
      packId: "qp_cnc_turning",
      packVersion: 1,
      record: baseRecord({
        status: "answered",
        value_normalized: otherAnswerValue("Batliboi lathe"),
      }),
      source: "chat",
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe("answered");
    expect(row?.answerOtherText).toBe("Batliboi lathe");
    expect(row?.answerText).toBeUndefined();
    expect(row?.answerNumber).toBeUndefined();
    expect(row?.answerBool).toBeUndefined();
    expect(row?.answerOptionKeys).toBeUndefined();
  });

  it("declines rather than writing an empty 'other' answer", () => {
    const row = packAnswerRowFor({
      workerId: "w1",
      sessionId: "s1",
      packId: "qp_cnc_turning",
      packVersion: 1,
      record: baseRecord({ status: "answered", value_normalized: otherAnswerValue("   ") }),
      source: "chat",
    });
    // `otherAnswerValue("   ")` is already null, so this is really the "no representable value"
    // path every other unrepresentable shape takes — declined, never dropped.
    expect(row?.status).toBe("declined");
  });
});
