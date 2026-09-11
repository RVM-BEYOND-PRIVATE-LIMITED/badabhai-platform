import type { ParsedField, QuestionPackItem } from "@badabhai/ai-contracts";
import { describe, expect, it } from "vitest";

import { RESUME_PARSE_TARGET_FIELDS } from "./resume-parse-fields";
import { buildSuggestions, RESUME_SUGGESTION_TARGETS } from "./resume-suggestions";

/**
 * RI-4's mapping layer. The failure this file exists to catch is SILENT: a parsed field that
 * maps nowhere produces no suggestion, and no suggestion is indistinguishable from a résumé that
 * never mentioned the thing. Every assertion below therefore checks WHERE a value landed, not
 * merely that something happened.
 */

const option = (
  optionKey: string,
  value: string,
  label = optionKey,
): QuestionPackItem["options"][number] => ({
  option_key: optionKey,
  label_text: label,
  value,
  implies_skill_id: null,
  is_none_of_above: false,
});

const item = (
  questionKey: string,
  targetField: string | null,
  answerType: QuestionPackItem["answer_type"],
  options: QuestionPackItem["options"] = [],
): QuestionPackItem => ({
  question_key: questionKey,
  prompt_text: questionKey,
  display_order: 0,
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

/** The real shape of `qp_universal@2`, option values included. */
const UNIVERSAL: QuestionPackItem[] = [
  item("primary_trade", "trade", "text"),
  // ALIASED TYPES, NOT CORPUS ONES. The packs spell these `duration`, `city` and `salary`;
  // `PackRegistryService` maps all three through `ANSWER_TYPE_ALIASES` before a consumer sees
  // them, so a fixture in the corpus vocabulary would pin a shape this code is never handed.
  item("experience_years", "experience_years", "number"),
  item("current_city", "current_city", "text"),
  item("salary_expected", "salary_expected", "number"),
  item("availability", "availability", "single_select", [
    option("immediate", "immediate"),
    option("fifteen_days", "15_days"),
    option("one_month", "1_month"),
    option("not_sure", "unknown"),
  ]),
  item("education", "education_level", "single_select", [
    option("below_tenth", "below_10"),
    option("tenth", "10"),
    option("twelfth", "12"),
    option("iti_diploma", "iti_diploma"),
    option("graduate", "graduate"),
  ]),
];

const parsed = (value: unknown, confidence = 0.9): ParsedField => ({
  value,
  evidence: { message_index: 3, quote: "quoted from the document" },
  source: "transcript",
  normalization: "verbatim",
  confidence,
});

describe("the résumé → question mapping is exhaustive over what the parse can return", () => {
  it("names every field the parse may fill, so a ninth field cannot be added silently", () => {
    // THE POINT OF THE WHOLE FILE. `RESUME_PARSE_TARGET_FIELDS` is gate 5 — it defines what the
    // model is allowed to say. A field added there and forgotten here would be extracted,
    // gated, persisted and then shown to nobody.
    const parseFields = RESUME_PARSE_TARGET_FIELDS.map((field) => field.field_id).sort();
    expect(Object.keys(RESUME_SUGGESTION_TARGETS).sort()).toEqual(parseFields);
  });

  it("the two nulls are the two the ADR names, and nothing else is null by accident", () => {
    const unmapped = Object.entries(RESUME_SUGGESTION_TARGETS)
      .filter(([, target]) => target === null)
      .map(([fieldId]) => fieldId)
      .sort();
    expect(unmapped).toEqual(["domain_label", "machines"]);
  });
});

describe("what lands on the form", () => {
  it("a role label prefills the trade question — the one the interview otherwise opens with", () => {
    const built = buildSuggestions({ role_label: parsed("CNC Turner") }, UNIVERSAL);
    expect(built.byQuestionKey.get("primary_trade")?.values.text).toBe("CNC Turner");
  });

  it("carries the model's own confidence through unaltered", () => {
    const built = buildSuggestions({ role_label: parsed("Welder", 0.42) }, UNIVERSAL);
    // NOT filtered on. A low-confidence suggestion is still shown, because the worker is the
    // one who decides — a confidence floor here would silently drop things he would have
    // confirmed.
    expect(built.byQuestionKey.get("primary_trade")?.confidence).toBe(0.42);
  });

  it("numbers land as numbers, not as their string spelling", () => {
    const built = buildSuggestions(
      { experience_years: parsed(7), salary_expected: parsed(25000) },
      UNIVERSAL,
    );
    expect(built.byQuestionKey.get("experience_years")?.values).toMatchObject({
      number: 7,
      text: null,
    });
    expect(built.byQuestionKey.get("salary_expected")?.values.number).toBe(25000);
  });

  it("a closed-set value lands as an option KEY, matched on the option's stored VALUE", () => {
    // `immediate` is spelled the same in both; `unknown` is NOT (`not_sure` is the key). If this
    // matched on keys it would pass for the first and fail for the second.
    const immediate = buildSuggestions({ availability: parsed("immediate") }, UNIVERSAL);
    expect(immediate.byQuestionKey.get("availability")?.values.option_keys).toEqual(["immediate"]);

    const unsure = buildSuggestions({ availability: parsed("unknown") }, UNIVERSAL);
    expect(unsure.byQuestionKey.get("availability")?.values.option_keys).toEqual(["not_sure"]);
  });

  it("nothing it produces is an answer — the values carry no `status`", () => {
    // Ruling D2 in one assertion. A suggestion that arrived shaped like a SavedAnswer would be
    // one client bug away from being rendered as settled.
    const built = buildSuggestions({ role_label: parsed("Fitter") }, UNIVERSAL);
    const suggestion = built.byQuestionKey.get("primary_trade");
    expect(suggestion).toBeDefined();
    expect(Object.keys(suggestion!.values).sort()).toEqual(["bool", "number", "option_keys", "text"]);
    expect(suggestion!.source).toBe("resume");
  });
});

describe("what deliberately does NOT land, and is counted instead of vanishing", () => {
  it("an ambiguous notice period picks NEITHER option rather than inventing one", () => {
    // The pack offers fifteen days and one month; the résumé said "notice period". Choosing
    // between them would invent the answer to a question about the worker's own life.
    const built = buildSuggestions({ availability: parsed("notice_period") }, UNIVERSAL);
    expect(built.byQuestionKey.has("availability")).toBe(false);
    expect(built.misses.get("availability")).toBe("no_matching_option");
  });

  it("`not_looking` has no option on this form and is recorded as such", () => {
    const built = buildSuggestions({ availability: parsed("not_looking") }, UNIVERSAL);
    expect(built.byQuestionKey.has("availability")).toBe(false);
    expect(built.misses.get("availability")).toBe("no_matching_option");
  });

  it("machines are counted as unmapped, not dropped on the floor", () => {
    const built = buildSuggestions({ machines: parsed(["Fanuc Oi-MF", "HMT LB20"]) }, UNIVERSAL);
    expect(built.byQuestionKey.size).toBe(0);
    expect(built.misses.get("machines")).toBe("no_target_question");
  });

  it("the domain label is router input and never reaches a question", () => {
    const built = buildSuggestions({ domain_label: parsed("CNC Machining") }, UNIVERSAL);
    expect(built.byQuestionKey.size).toBe(0);
    expect(built.misses.get("domain_label")).toBe("no_target_question");
  });

  it("a field whose question this worker is not asked is a miss, not an error", () => {
    const built = buildSuggestions({ availability: parsed("immediate") }, [
      item("primary_trade", "trade", "text"),
    ]);
    expect(built.misses.get("availability")).toBe("question_not_in_pack");
  });

  it("an empty string is not a suggestion", () => {
    const built = buildSuggestions({ current_city: parsed("   ") }, UNIVERSAL);
    expect(built.byQuestionKey.has("current_city")).toBe(false);
  });
});

describe("the education bridge — free text on the document, a closed set on the form", () => {
  // VACUITY CHECK FIRST. If the fixture below did not actually reach the education question,
  // every assertion in this block would pass for the wrong reason.
  it("the fixture reaches the education question at all", () => {
    const built = buildSuggestions({ education_level: parsed("ITI") }, UNIVERSAL);
    expect(built.byQuestionKey.get("education")?.values.option_keys).toEqual(["iti_diploma"]);
  });

  it("'Diploma in Mechanical Engineering' is a DIPLOMA, not a degree", () => {
    // THE TRAP. Every graduate cue is tempted to match the word "engineering", and this is the
    // commonest qualification line on an Indian trade résumé. Getting it wrong would tell an
    // employer the worker holds a degree he does not have.
    const built = buildSuggestions(
      { education_level: parsed("Diploma in Mechanical Engineering") },
      UNIVERSAL,
    );
    expect(built.byQuestionKey.get("education")?.values.option_keys).toEqual(["iti_diploma"]);
  });

  it.each([
    ["B.Tech Mechanical", "graduate"],
    ["Bachelor of Science", "graduate"],
    ["M.Tech Production", "graduate"],
    ["ITI Fitter (NCVT) 2019", "iti_diploma"],
    ["Polytechnic, Pune", "iti_diploma"],
    ["12th Pass", "twelfth"],
    ["Higher Secondary", "twelfth"],
    ["10th Standard", "tenth"],
    ["SSLC", "tenth"],
    ["8th pass", "below_tenth"],
  ])("%s → %s", (printed, expectedKey) => {
    const built = buildSuggestions({ education_level: parsed(printed) }, UNIVERSAL);
    expect(built.byQuestionKey.get("education")?.values.option_keys).toEqual([expectedKey]);
  });

  it("holds the HIGHEST qualification when a résumé prints two", () => {
    const built = buildSuggestions(
      { education_level: parsed("Diploma 2015, B.Tech 2019") },
      UNIVERSAL,
    );
    expect(built.byQuestionKey.get("education")?.values.option_keys).toEqual(["graduate"]);
  });

  it("an axis letter on a machining résumé is not a class-ten marksheet", () => {
    // `X` is a Roman ten AND the first axis of every machine on this platform. A bare-letter cue
    // would read "X and Z axis programming" as a school qualification.
    const built = buildSuggestions({ education_level: parsed("X and Z axis programming") }, UNIVERSAL);
    expect(built.byQuestionKey.has("education")).toBe(false);
  });

  it("an unrecognised qualification produces NO suggestion rather than a guess", () => {
    const built = buildSuggestions({ education_level: parsed("Apprenticeship, Tata Motors") }, UNIVERSAL);
    expect(built.byQuestionKey.has("education")).toBe(false);
    expect(built.misses.get("education_level")).toBe("no_matching_option");
  });
});
