import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { describe, expect, it } from "vitest";

import type { AnswerMap } from "./answer-map";
import {
  confirmableFacts,
  confirmedValues,
  confirmPrompt,
  readConfirmReply,
  RESUME_CONFIRM_OPTIONS,
} from "./resume-confirm";
import type { ResumeSuggestion } from "./resume-import/resume-suggestions";

/**
 * RI-5's batch-confirm turn. The two properties that carry this file:
 *
 *   1. NOTHING IS AN ANSWER UNTIL HE SAYS SO (ruling D2). Every path that produces values is
 *      reached only through an explicit accept, and an unreadable reply is NOT an accept.
 *   2. THE DOCUMENT'S WORDS DO NOT ENTER THE INTERVIEW RECORD (ruling D4).
 */

const option = (optionKey: string, value: unknown, label: string) =>
  ({
    option_key: optionKey,
    label_text: label,
    value,
    implies_skill_id: null,
    is_none_of_above: false,
  }) as QuestionPackItem["options"][number];

const item = (
  questionKey: string,
  targetField: string,
  answerType: QuestionPackItem["answer_type"],
  displayOrder: number,
  options: QuestionPackItem["options"] = [],
): QuestionPackItem => ({
  question_key: questionKey,
  prompt_text: questionKey,
  display_order: displayOrder,
  target_kind: "attribute",
  target_field: targetField,
  target_skill_id: null,
  answer_type: answerType,
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
  options,
});

const PACK: QuestionPackItem[] = [
  item("primary_trade", "trade", "text", 1),
  item("experience_years", "experience_years", "number", 2),
  item("current_city", "current_city", "text", 3),
  item("education", "education_level", "single_select", 4, [
    option("iti_diploma", "iti_diploma", "ITI / Diploma"),
    option("graduate", "graduate", "Graduate"),
  ]),
  item("turning_machine", "turning_machine", "multi_select", 5, [
    option("cnc_lathe", "cnc_lathe", "CNC Lathe"),
    option("vtl", "vtl", "VTL"),
  ]),
];

const suggest = (values: Partial<ResumeSuggestion["values"]>): ResumeSuggestion => ({
  values: { option_keys: [], text: null, number: null, bool: null, ...values },
  source: "resume",
  confidence: 0.9,
});

const answered = (questionKey: string): AnswerMap => ({
  [questionKey]: {
    question_key: questionKey,
    target_field: null,
    value_raw: "Mumbai",
    value_normalized: "Mumbai",
    status: "answered",
    evidence: null,
    turn: 3,
    history: [],
  },
});

describe("which facts are worth one ask", () => {
  it("offers every suggestion that has no stored answer", () => {
    const facts = confirmableFacts(
      new Map([
        ["primary_trade", suggest({ text: "CNC Turner" })],
        ["current_city", suggest({ text: "Pune" })],
      ]),
      PACK,
      {},
    );
    expect(facts.map((fact) => fact.questionKey)).toEqual(["primary_trade", "current_city"]);
  });

  it("NEVER offers a question the worker has already answered (ruling D7)", () => {
    // His answer stands. Spending the ask to re-litigate something settled is the opposite of
    // what this turn is for — and unlike the form, there is no way to show it beside his answer
    // without spending that ask.
    const facts = confirmableFacts(
      new Map([
        ["primary_trade", suggest({ text: "CNC Turner" })],
        ["current_city", suggest({ text: "Pune" })],
      ]),
      PACK,
      answered("current_city"),
    );
    expect(facts.map((fact) => fact.questionKey)).toEqual(["primary_trade"]);
  });

  it("an `unanswered` record is not an answer — it is a question the engine gave up on", () => {
    const givenUp: AnswerMap = {
      current_city: { ...answered("current_city").current_city!, status: "unanswered" },
    };
    const facts = confirmableFacts(
      new Map([["current_city", suggest({ text: "Pune" })]]),
      PACK,
      givenUp,
    );
    expect(facts).toHaveLength(1);
  });

  it("orders by the PACK, not by the model's output order", () => {
    // Two runs of the same résumé must produce the same bubble, or the copy is untestable.
    const backwards = new Map([
      ["current_city", suggest({ text: "Pune" })],
      ["primary_trade", suggest({ text: "CNC Turner" })],
    ]);
    expect(confirmableFacts(backwards, PACK, {}).map((f) => f.questionKey)).toEqual([
      "primary_trade",
      "current_city",
    ]);
  });

  it("a suggestion for a question this pack does not contain is silently absent, not a crash", () => {
    const facts = confirmableFacts(new Map([["not_a_question", suggest({ text: "x" })]]), PACK, {});
    expect(facts).toEqual([]);
  });
});

describe("what is STORED and what is SHOWN are different things", () => {
  it("a closed-set fact stores the option's value and shows its label", () => {
    // VACUITY CHECK: the two must actually differ in this fixture, or the assertion below
    // passes for a pack where they happen to be spelled the same.
    const educationOption = PACK[3]!.options[0]!;
    expect(educationOption.value).not.toBe(educationOption.label_text);

    const [fact] = confirmableFacts(
      new Map([["education", suggest({ option_keys: ["iti_diploma"] })]]),
      PACK,
      {},
    );
    expect(fact!.valueNormalized).toBe("iti_diploma");
    expect(fact!.display).toBe("ITI / Diploma");
  });

  it("a multi-select stores an ARRAY even when only one chip matched", () => {
    // Reading the pack's `answer_type` rather than counting matches is what keeps this from
    // being stored as a scalar the projector then cannot read.
    const [fact] = confirmableFacts(
      new Map([["turning_machine", suggest({ option_keys: ["cnc_lathe"] })]]),
      PACK,
      {},
    );
    expect(fact!.valueNormalized).toEqual(["cnc_lathe"]);
  });

  it("a single-select stores the bare value, not a one-element array", () => {
    const [fact] = confirmableFacts(
      new Map([["education", suggest({ option_keys: ["graduate"] })]]),
      PACK,
      {},
    );
    expect(fact!.valueNormalized).toBe("graduate");
  });

  it("numbers stay numbers", () => {
    const [fact] = confirmableFacts(
      new Map([["experience_years", suggest({ number: 7 })]]),
      PACK,
      {},
    );
    expect(fact!.valueNormalized).toBe(7);
    expect(fact!.display).toBe("7");
  });

  it("an option key the pack does not have produces no fact rather than a guess", () => {
    const facts = confirmableFacts(
      new Map([["education", suggest({ option_keys: ["doctorate"] })]]),
      PACK,
      {},
    );
    expect(facts).toEqual([]);
  });
});

describe("the bubble", () => {
  it("reads as one sentence with one question mark", () => {
    const facts = confirmableFacts(
      new Map([
        ["primary_trade", suggest({ text: "CNC Turner" })],
        ["experience_years", suggest({ number: 5 })],
        ["current_city", suggest({ text: "Pune" })],
        ["education", suggest({ option_keys: ["iti_diploma"] })],
      ]),
      PACK,
      {},
    );
    const prompt = confirmPrompt(facts);

    expect(prompt).toBe("Resume se ye mila: CNC Turner · 5 · Pune · ITI / Diploma. Sahi hai?");
    expect(prompt.match(/\?/g)).toHaveLength(1);
    expect(prompt).not.toContain("!");
  });
});

describe("reading the reply — and what must NEVER count as a yes", () => {
  // MEASURED AGAINST THE SHIPPED LEXICON, not invented. The first draft of this table asserted
  // "ha" and "galat hai" and both were wrong — `parseAffirmation` returns null for each. Probing
  // it was what turned an assumption into the table below.
  it.each([
    ["haan", "accept"],
    ["haan ji", "accept"],
    ["bilkul", "accept"],
    ["sahi hai", "accept"],
    ["theek hai", "accept"],
    ["ok", "accept"],
    ["nahi", "decline"],
    ["nahin", "decline"],
    ["na", "decline"],
    ["no", "decline"],
    // "pata nahi" reads as a DECLINE rather than unclear, and that is the right outcome here:
    // a worker who does not know whether his résumé is right is a worker who should be asked
    // the questions properly.
    ["pata nahi", "decline"],
  ])("%s → %s", (text, expected) => {
    expect(readConfirmReply(text)).toBe(expected);
  });

  it.each([["ha"], ["galat"], ["galat hai"], ["kuch aur"]])(
    "%s is UNCLEAR — a real gap, and one that costs the worker nothing",
    (text) => {
      // "galat hai" means "it is wrong" and the shared yes/no lexicon does not carry it. Widening
      // that lexicon is not this phase's to do — it is the same parser all 236 boolean pack items
      // use, so a word added here changes what every one of them accepts. It is safe to leave
      // because the caller treats `unclear` as a decline: he is simply asked the questions one at
      // a time, which is exactly what would have happened without a résumé.
      expect(readConfirmReply(text)).toBe("unclear");
    },
  );

  it("a chip tap is read from its option key", () => {
    expect(readConfirmReply("resume_confirm_yes")).toBe("accept");
    expect(readConfirmReply("resume_confirm_no")).toBe("decline");
  });

  it("an UNREADABLE reply is not an accept", () => {
    // The worst failure available to this turn is writing six answers off a sentence nobody
    // understood. `unclear` is a distinct outcome so the caller can fall back to asking
    // properly rather than guessing.
    for (const reply of ["pata nahi kya likha hai usme", "कुछ और", "matlab", "???"]) {
      expect(readConfirmReply(reply)).not.toBe("accept");
    }
  });

  it("a denied yes is a NO, because the shared lexicon resolves negation itself", () => {
    expect(readConfirmReply("haan nahi")).toBe("decline");
  });

  it("the two chips are exactly one yes and one no", () => {
    expect(RESUME_CONFIRM_OPTIONS.map((o) => o.value)).toEqual([true, false]);
  });
});

describe("the confirmed answer's provenance is the WORKER, not the document (ruling D4)", () => {
  it("carries no résumé text and no document evidence", () => {
    const facts = confirmableFacts(
      new Map([
        ["primary_trade", suggest({ text: "CNC Turner" })],
        ["current_city", suggest({ text: "Pune" })],
      ]),
      PACK,
      {},
    );
    const values = confirmedValues(facts);

    expect(values).toHaveLength(2); // vacuity: there ARE values to inspect
    for (const value of values) {
      // The worker's words were "haan". The document's sentence is not his and must not enter
      // the transcript projection, which is the route by which it could reach the sheet.
      expect(value.valueRaw).toBeNull();
      expect(value.evidence).toBeNull();
    }
    // The VALUE still travels — this is a prefill, not a no-op.
    expect(values.map((v) => v.valueNormalized)).toEqual(["CNC Turner", "Pune"]);
    expect(values.map((v) => v.questionKey)).toEqual(["primary_trade", "current_city"]);
  });

  it("carries the pack's target field, so the projector lands it in the right column", () => {
    const facts = confirmableFacts(
      new Map([["experience_years", suggest({ number: 7 })]]),
      PACK,
      {},
    );
    expect(confirmedValues(facts)[0]!.targetField).toBe("experience_years");
  });
});
