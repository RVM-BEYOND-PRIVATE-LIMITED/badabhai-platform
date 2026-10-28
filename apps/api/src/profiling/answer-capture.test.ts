import { describe, expect, it, vi } from "vitest";

import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { RFS_FIELD_IDS } from "@badabhai/db";

import {
  NORMALIZED_FIELDS,
  captureAnswer,
  hasFieldNormalizer,
  isParserlessNumber,
  matchOptions,
  mayCommit,
  typedAnswerResidue,
} from "./answer-capture";
import { recordAnswer, type CapturedValue } from "./answer-map";

let order = 0;

function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "rfs",
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

const CITY = item({ question_key: "q_city", target_field: "current_city" });
const YEARS = item({ question_key: "q_years", target_field: "experience_years" });
const SALARY = item({ question_key: "q_salary", target_field: "salary_expected" });
const AVAIL = item({ question_key: "q_avail", target_field: "availability" });
const RELOCATE = item({ question_key: "q_reloc", target_field: "relocation_willingness" });
const FREE_TEXT = item({ question_key: "q_notes" });

function only(capture: { values: readonly CapturedValue[] }): CapturedValue {
  expect(capture.values).toHaveLength(1);
  return capture.values[0] as CapturedValue;
}

describe("the hard cases, each one deterministic", () => {
  it("'nahi pata' is a COMPLETE answer, not a gap", () => {
    const capture = captureAnswer("nahi pata", CITY);
    expect(capture.turnClass).toBe("dont_know");
    expect(capture.declined).toBe(true);
    expect(capture.values).toHaveLength(0);
  });

  it("an abusive turn is buffered for the audit but flagged away from the model", () => {
    const capture = captureAnswer("chutiya", CITY);
    expect(capture.turnClass).toBe("abusive");
    // The audit stays honest; the model stays clean.
    expect(capture.excludeFromParse).toBe(true);
    expect(capture.values).toHaveLength(0);
  });

  it("a worker asking back is not an answer and costs nothing", () => {
    const capture = captureAnswer("sir job milegi kya?", CITY);
    expect(capture.turnClass).toBe("question_back");
    expect(capture.values).toHaveLength(0);
    expect(capture.excludeFromParse).toBe(false);
  });

  it("#2308: a progress question is never captured — not even by a free-text question", () => {
    // A free-text item's normalizer is the identity, so before #2308 "aur kitna bacha hai" was
    // stored verbatim as the answer to whatever free-text question was on screen.
    const freeText = { ...CITY, question_key: "q_training", target_field: "training_name" };
    const capture = captureAnswer("aur kitna bacha hai", freeText);
    expect(capture.turnClass).toBe("progress_question");
    expect(capture.values).toHaveLength(0);
    expect(capture.declined).toBe(false);
  });

  it("hardship is acknowledged, never captured as a profile field", () => {
    const capture = captureAnswer("ghar chalana mushkil hai", CITY);
    expect(capture.turnClass).toBe("hardship");
    expect(capture.values).toHaveLength(0);
  });

  it("silence produces nothing and is not an abuse or a refusal", () => {
    for (const text of ["", " ", "."]) {
      const capture = captureAnswer(text, CITY);
      expect(capture.turnClass).toBe("empty");
      expect(capture.values).toHaveLength(0);
      expect(capture.declined).toBe(false);
    }
  });

  it("a correction is flagged so it can override the commit rule", () => {
    const capture = captureAnswer("nahi nahi, 7 saal", YEARS);
    expect(capture.correcting).toBe(true);
    expect(only(capture).valueNormalized).toBe(7);
  });
});

describe("normalization runs at CAPTURE time, per target field", () => {
  it("types a city, years, salary, availability and relocation", () => {
    expect(only(captureAnswer("main pune me rehta hu", CITY)).valueNormalized).toBe("Pune");
    expect(only(captureAnswer("7 saal ka experience", YEARS)).valueNormalized).toBe(7);
    expect(only(captureAnswer("35000 chahiye", SALARY)).valueNormalized).toBe(35000);
    expect(only(captureAnswer("abhi join kar sakta hun", AVAIL)).valueNormalized).toBe("immediate");
    expect(only(captureAnswer("kahin bhi jaa sakta hu", RELOCATE)).valueNormalized).toBe(true);
  });

  it("keeps the worker's words for a free-text question, trimmed and never rewritten", () => {
    const capture = captureAnswer("  fixture setup karta hu  ", FREE_TEXT);
    expect(only(capture).valueNormalized).toBe("fixture setup karta hu");
    expect(only(capture).valueRaw).toBe("fixture setup karta hu");
  });

  it("takes a chip label as the answer of record VERBATIM", () => {
    // Chips are reviewed static data, so there is nothing to normalize and nothing to
    // second-guess.
    const chips = item({
      question_key: "q_shift",
      options: [
        {
          option_key: "day",
          label_text: "Din ki shift",
          value: "day",
          implies_skill_id: null,
          is_none_of_above: false,
        },
        {
          option_key: "night",
          label_text: "Raat ki shift",
          value: null,
          implies_skill_id: null,
          is_none_of_above: false,
        },
      ],
    });
    expect(only(captureAnswer("Din ki shift", chips)).valueNormalized).toBe("day");
    // A chip with no explicit value falls back to its own label.
    expect(only(captureAnswer("raat ki shift", chips)).valueNormalized).toBe("Raat ki shift");
  });

  it("captures NOTHING rather than a wrong value when the field will not parse", () => {
    // Distinct from a captured null: "we could not read an answer here" leaves the question
    // askable again, which is the recoverable direction.
    expect(captureAnswer("bahut accha", YEARS).values).toHaveLength(0);
    expect(captureAnswer("pata nahi konsa", SALARY).values).toHaveLength(0);
  });
});

describe("#2384: the total-experience question, answered the way its keypad answers it", () => {
  // As the registry serves it: the pack's `duration` reaches capture as `number`.
  const TENURE = item({
    question_key: "experience_years",
    target_field: "experience_years",
    answer_type: "number",
  });

  it("'0' is a fresher's answer, captured — not silence re-served three times", () => {
    const capture = captureAnswer("0", TENURE);
    expect(capture.turnClass).toBe("off_topic");
    expect(only(capture).valueNormalized).toBe(0);
  });

  it("a bare number is years, one digit or two", () => {
    expect(only(captureAnswer("5", TENURE)).valueNormalized).toBe(5);
    expect(only(captureAnswer("10", TENURE)).valueNormalized).toBe(10);
    expect(only(captureAnswer("०", TENURE)).valueNormalized).toBe(0);
  });

  it("the fresher words are 0; a value with its unit still wins over them", () => {
    expect(only(captureAnswer("fresher hoon", TENURE)).valueNormalized).toBe(0);
    expect(only(captureAnswer("koi experience nahi", TENURE)).valueNormalized).toBe(0);
    expect(
      only(captureAnswer("welding ka experience nahi, fitting ka 3 saal", TENURE)).valueNormalized,
    ).toBe(3);
  });

  it("the 0–60 bound still refuses an impossible figure, and re-asks", () => {
    const capture = captureAnswer("80", TENURE);
    expect(capture.values).toHaveLength(0);
    expect(capture.outOfRange).toBe(true);
  });

  it("ON SCREEN ONLY: a bare number read in passing is never someone's experience", () => {
    expect(captureAnswer("5", TENURE, { crossQuestion: true }).values).toHaveLength(0);
    expect(captureAnswer("fresher", TENURE, { crossQuestion: true }).values).toHaveLength(0);
  });

  it("one digit to a FREE-TEXT question is still silence, never stored as a trade", () => {
    const capture = captureAnswer("5", FREE_TEXT);
    expect(capture.turnClass).toBe("empty");
    expect(capture.values).toHaveLength(0);
  });

  it("one digit to a parserless number question is its answer too", () => {
    const hours = item({ question_key: "hours_per_day", answer_type: "number" });
    expect(only(captureAnswer("8", hours)).valueNormalized).toBe("8");
  });

  it("a bare figure leaves no unread words behind (the free chat's bare-answer check)", () => {
    expect(typedAnswerResidue(TENURE, "12")).toEqual([]);
  });
});

describe("the availability answer carries its notice days (qp_universal@8)", () => {
  // The removed `notice_period_days` number duplicated these chips one question later, so the
  // availability turn now writes the notice value beside its own — same questionKey/targetField
  // the removed question wrote, so the projector and the registry aliases keep working.
  const AVAIL_CHIPS = item({
    question_key: "q_avail",
    target_field: "availability",
    answer_type: "single_select",
    options: [
      {
        option_key: "immediate",
        label_text: "Abhi turant",
        value: "immediate",
        implies_skill_id: null,
        is_none_of_above: false,
      },
      {
        option_key: "fifteen_days",
        label_text: "Pandrah din mein",
        value: "15_days",
        implies_skill_id: null,
        is_none_of_above: false,
      },
      {
        option_key: "one_month",
        label_text: "Ek mahine mein",
        value: "1_month",
        implies_skill_id: null,
        is_none_of_above: false,
      },
      {
        option_key: "not_sure",
        label_text: "Abhi pata nahi",
        value: "unknown",
        implies_skill_id: null,
        is_none_of_above: true,
      },
    ],
  });

  it("writes a notice value beside a duration chip", () => {
    const capture = captureAnswer("Pandrah din mein", AVAIL_CHIPS);
    expect(capture.values).toHaveLength(2);
    expect(capture.values[0]).toMatchObject({
      questionKey: "q_avail",
      targetField: "availability",
      valueNormalized: "15_days",
    });
    expect(capture.values[1]).toMatchObject({
      questionKey: "notice_period_days",
      targetField: "notice_period_days",
      valueNormalized: 15,
    });
  });

  it("writes 30 days beside the month chip and none beside immediate", () => {
    const month = captureAnswer("Ek mahine mein", AVAIL_CHIPS);
    expect(month.values).toHaveLength(2);
    expect(month.values[1]).toMatchObject({
      questionKey: "notice_period_days",
      valueNormalized: 30,
    });
    expect(captureAnswer("Abhi turant", AVAIL_CHIPS).values).toHaveLength(1);
  });

  it("reads typed durations through the same availability parse as the status", () => {
    const capture = captureAnswer("15 din ka notice hai", AVAIL);
    expect(capture.values).toHaveLength(2);
    expect(capture.values[0]).toMatchObject({ valueNormalized: "notice_period" });
    expect(capture.values[1]).toMatchObject({
      questionKey: "notice_period_days",
      targetField: "notice_period_days",
      valueNormalized: 15,
    });
  });

  it("writes no second value when the answer carries no duration", () => {
    expect(captureAnswer("abhi join kar sakta hun", AVAIL).values).toHaveLength(1);
  });

  it("a negated duration writes nothing at all — the veto covers both values", () => {
    expect(captureAnswer("15 din nahi lagenge", AVAIL_CHIPS).values).toHaveLength(0);
  });

  // #2467 — the 3-month notice the chips could not express, typed under the "Kuch aur" chip.
  it("reads a BARE duration typed as the availability answer as a notice period", () => {
    for (const [text, days] of [
      ["3 mahine", 90],
      ["3 months", 90],
      ["do mahine lagenge", 60],
      ["teen mahine", 90],
    ] as const) {
      const capture = captureAnswer(text, AVAIL_CHIPS);
      expect(capture.values.map((v) => v.valueNormalized), text).toEqual(["notice_period", days]);
    }
  });

  it("never reads a bare duration in passing, in a long message, or past six months", () => {
    expect(captureAnswer("3 mahine", AVAIL_CHIPS, { crossQuestion: true }).values).toHaveLength(0);
    expect(
      captureAnswer("experience 5 nahi 6 saal hai, aur roz 15 km tak aa sakta hoon", AVAIL_CHIPS).values,
    ).toHaveLength(0);
    expect(captureAnswer("6 saal", AVAIL_CHIPS).values).toHaveLength(0);
    expect(captureAnswer("10 din pehle", AVAIL_CHIPS).values).toHaveLength(0);
  });
});

describe("the negation veto — a value found and then refused is NOT an answer", () => {
  it("refuses a negated city, availability and relocation", () => {
    // "abhi kaam nahi mil raha" must never become availability: immediate, and "pune nahi
    // jaunga" must not record Pune as where the worker lives.
    expect(captureAnswer("pune nahi jaunga", CITY).values).toHaveLength(0);
    expect(captureAnswer("relocate nahi kar paunga", RELOCATE).values).toHaveLength(0);
  });

  it("does not veto a free-text answer that merely contains a negation", () => {
    // The whole message IS the answer here; vetoing it wholesale would delete answers
    // containing an unrelated denial.
    const capture = captureAnswer("welding nahi karta, sirf VMC chalata hu", FREE_TEXT);
    expect(only(capture).valueNormalized).toBe("welding nahi karta, sirf VMC chalata hu");
  });
});

describe("THE OVERWRITE RULE", () => {
  const answers = recordAnswer(
    {},
    {
      questionKey: "q_city",
      targetField: "current_city",
      valueRaw: "pune",
      valueNormalized: "Pune",
      evidence: null,
    },
    1,
  );

  it("lets the question on screen always commit, including on the re-ask", () => {
    expect(mayCommit(answers, "q_city", "q_city", false)).toBe(true);
  });

  it("lets an explicit correction commit whatever is on screen", () => {
    expect(mayCommit(answers, "q_city", "q_salary", true)).toBe(true);
  });

  it("otherwise: FIRST WRITE WINS", () => {
    // A cross-question signal picked up in passing may FILL an empty slot but may never
    // overwrite one the worker already established — otherwise mentioning a city while
    // answering the salary question rewrites an established location.
    expect(mayCommit(answers, "q_city", "q_salary", false)).toBe(false);
    expect(mayCommit(answers, "q_years", "q_salary", false)).toBe(true);
  });
});

describe("with no question on screen", () => {
  it("classifies the turn but captures nothing", () => {
    const capture = captureAnswer("main pune me rehta hu", null);
    expect(capture.values).toHaveLength(0);
    expect(capture.turnClass).toBeTruthy();
  });
});

describe("the commit rule is enforced INSIDE capture, not only advertised", () => {
  it("captures nothing when the rule refuses the write", () => {
    // The question on screen normally always commits. Here the map already holds a value for it
    // AND the turn is not a correction, which is only reachable when the caller passes a
    // different asked-key — the same guard `mayCommit` exposes, asserted through the real path
    // rather than only in isolation.
    const answers = recordAnswer(
      {},
      {
        questionKey: "q_city",
        targetField: "current_city",
        valueRaw: "pune",
        valueNormalized: "Pune",
        evidence: null,
      },
      1,
    );
    expect(mayCommit(answers, "q_city", null, false)).toBe(false);
    // ...and a fresh question still commits against the same map.
    expect(mayCommit(answers, "q_years", null, false)).toBe(true);
  });

  it("reads the CURRENT salary slot for a current-salary question", () => {
    const current = item({ question_key: "q_now", target_field: "salary_current" });
    expect(only(captureAnswer("abhi 25000 milta hai", current)).valueNormalized).toBe(25000);
    // ...and the veto still applies on that slot's own span.
    expect(captureAnswer("25000 nahi milta", current).values).toHaveLength(0);
  });
});

describe("the remaining typed fields", () => {
  it("types a notice period in DAYS off the same availability parse", () => {
    // Read through the same spans and the same vetoes as the availability status it accompanies,
    // so the number can never disagree with the status — a fabricated "15 days" on a worker's
    // resume is worse than a blank, and this field is payer-visible.
    const notice = item({ question_key: "q_notice", target_field: "notice_period_days" });
    expect(only(captureAnswer("15 din lagenge", notice)).valueNormalized).toBe(15);
    expect(captureAnswer("15 din nahi lagenge", notice).values).toHaveLength(0);
    expect(captureAnswer("10 din pehle join kiya tha", notice).values).toHaveLength(0);
  });

  it("types a training year only from 1950 to the current year (#2233)", () => {
    const training = item({
      question_key: "training_year",
      target_kind: "attribute",
      target_field: "training_year",
      answer_type: "number",
    });
    const thisYear = new Date().getFullYear();
    expect(only(captureAnswer("2019 mein ki thi", training)).valueNormalized).toBe(2019);
    expect(only(captureAnswer(String(thisYear), training)).valueNormalized).toBe(thisYear);
    // A future year is a typo. The parser READS it and the bound refuses it, so it is never stored
    // and is reported as `outOfRange`: the turn re-asks the question.
    for (const text of ["2050", String(thisYear + 1), "2099 mein"]) {
      const capture = captureAnswer(text, training);
      expect(capture.values, text).toHaveLength(0);
      expect(capture.outOfRange, text).toBe(true);
    }
    // Outside the parser's own 1950..2100 it is a plain miss, as before: nothing read, nothing to
    // re-ask, and the ask-once question moves on.
    for (const text of ["1949", "2150", "kabhi nahi"]) {
      const capture = captureAnswer(text, training);
      expect(capture.values, text).toHaveLength(0);
      expect(capture.outOfRange, text).toBe(false);
    }
    // A year the worker refuses is the negation veto's, not the bound's.
    expect(captureAnswer("2050 nahi", training).outOfRange).toBe(false);
  });

  it("cross-question fill never settles a future training year (#2233)", () => {
    const training = item({
      question_key: "training_year",
      target_kind: "attribute",
      target_field: "training_year",
      answer_type: "number",
    });
    const passing = captureAnswer("welding ka ITI, 2050 mein", training, { crossQuestion: true });
    expect(passing.values).toHaveLength(0);
    expect(
      only(captureAnswer("welding ka ITI, 2019 mein", training, { crossQuestion: true }))
        .valueNormalized,
    ).toBe(2019);
  });

  it("moves the training-year ceiling with the clock, read on every capture (#2233)", () => {
    const training = item({
      question_key: "training_year",
      target_kind: "attribute",
      target_field: "training_year",
      answer_type: "number",
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2031-06-15T00:00:00Z"));
      expect(only(captureAnswer("2031", training)).valueNormalized).toBe(2031);
      expect(captureAnswer("2032", training).values).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("types experience only from 0 to 60 years, refusing more for a re-ask (#2253)", () => {
    expect(only(captureAnswer("5 saal", YEARS)).valueNormalized).toBe(5);
    expect(only(captureAnswer("60 saal", YEARS)).valueNormalized).toBe(60);
    // The parser READS "80 saal" as 80; the 0–60 bound refuses it, and the turn re-asks.
    for (const text of ["61 saal", "80 saal ka tajurba", "99 saal"]) {
      const capture = captureAnswer(text, YEARS);
      expect(capture.values, text).toHaveLength(0);
      expect(capture.outOfRange, text).toBe(true);
    }
    // A cross-question mention settles nothing above the bound either.
    expect(
      captureAnswer("welder hoon, 80 saal", YEARS, { crossQuestion: true }).values,
    ).toHaveLength(0);
  });

  it("keeps a target_kind:none question as free text", () => {
    const none = item({ question_key: "q_any", target_kind: "none", target_field: null });
    expect(only(captureAnswer("kuch bhi", none)).targetField).toBeNull();
  });
});

describe("every typed field falls back to NO capture rather than a guess", () => {
  it("returns nothing when its normalizer finds nothing, for each field", () => {
    // The null path of each adapter. Without these the "prefer no value over a wrong value" rule
    // is only asserted for two of the seven fields.
    const unreadable = "hmm theek hai bhai";
    const notice = item({ question_key: "q_notice", target_field: "notice_period_days" });
    const current = item({ question_key: "q_now", target_field: "salary_current" });
    for (const q of [CITY, YEARS, SALARY, AVAIL, RELOCATE, notice, current]) {
      expect(captureAnswer(unreadable, q).values, q.question_key).toHaveLength(0);
    }
  });

  it("a typed field that abstains still gets its own reviewed chips tried", () => {
    // THE REGRESSION, and it was live on every interview. `availability` and `relocation` are the
    // only two items in the corpus carrying BOTH a typed target field and options, and both sit in
    // `qp_universal`. A typed normalizer returning null used to return straight out of
    // `normalizeFor`, so their chips were never matched -- and `parseRelocationWillingness`
    // returns null for all three of relocation's own labels.
    // Booleans, because that is what the shipped corpus carries: `relocation`'s yes/no chips are
    // `value_bool` rows, and `pack-registry` now hands them over as booleans instead of "true".
    const reloc = item({
      question_key: "q_reloc2",
      target_field: "relocation_willingness",
      answer_type: "single_select",
      options: [
        { option_key: "yes", label_text: "Haan, jaa sakta hoon", value: true },
        { option_key: "no", label_text: "Nahi, yahi rehna hai", value: false },
      ] as never,
    });
    expect(only(captureAnswer("Nahi, yahi rehna hai", reloc)).valueNormalized).toBe(false);
  });

  it("refuses an option whose value contradicts the field's declared type", () => {
    // SYNTHETIC ON PURPOSE, and it stays that way. `qp_universal|relocation|maybe` used to be a
    // real instance of this shape -- a `boolean` field carrying the text "conditional" -- which put
    // a string into `z.boolean()` and failed the whole extraction job, the profile and not the
    // field. #731 fixed that chip in the corpus and `db:verify:packs` now rejects any new one, so
    // there is deliberately no live example left to point at. The rule still needs coverage:
    // it is what stands between the next mistyped chip and a lost profile.
    const reloc = item({
      question_key: "q_reloc3",
      target_field: "relocation_willingness",
      answer_type: "single_select",
      options: [
        {
          option_key: "maybe",
          label_text: "Sahi kaam mile to soch sakta hoon",
          value: "conditional",
        },
      ] as never,
    });
    expect(captureAnswer("Sahi kaam mile to soch sakta hoon", reloc).values).toHaveLength(0);
  });

  it("but a typed field NEVER falls through to verbatim", () => {
    // The boundary that makes the fall-through above safe. `salary_expected` is filtered on by
    // RANGE and `current_city` by EQUALITY, so a sentence in either is not a poorer value, it is
    // an unmatchable one. No option matched must still mean unread -- never the raw message.
    const salary = item({
      question_key: "q_sal2",
      target_field: "salary_expected",
      answer_type: "single_select",
      options: [{ option_key: "a", label_text: "Das hazaar", value: 10000 }] as never,
    });
    expect(captureAnswer("jo bhi mile theek hai", salary).values).toHaveLength(0);
  });
});

describe("the normalizer map is keyed on REAL vocabulary ids", () => {
  it("every rfs-facing key is in the Resume Field Set", () => {
    // THE REGRESSION. `relocation_willingness` is the WorkerProfileDraft column; the RFS id is
    // `relocation_willingness`. A key spelled the first way matches no pack question ever, so the
    // field falls through to the verbatim path and stores a whole sentence where a boolean
    // belongs — silently, because "no normalizer" is a legal state for free-text questions.
    //
    // The `attribute`-target exceptions, named here rather than pattern-matched away: each is
    // reachable only as an `attribute` target, never an `rfs` one. `notice_period_days` is
    // Layer A (c); `commute_max_km` and `training_year` joined in the Layer A elicitation
    // (qp_universal@4) and store into the same `worker_attributes` keys the pages write.
    const ATTRIBUTE_ONLY = new Set(["notice_period_days", "commute_max_km", "training_year"]);
    const offenders = NORMALIZED_FIELDS.filter(
      (field) => !ATTRIBUTE_ONLY.has(field) && !RFS_FIELD_IDS.has(field),
    );
    expect(offenders).toEqual([]);
  });

  it("types the fields the FAIL-CLOSED profile depends on", () => {
    // If any of these loses its normalizer, "the deterministic answer map alone is a usable
    // profile" stops being true and nothing else in the suite notices.
    for (const field of [
      "current_city",
      "experience_years",
      "salary_expected",
      "availability",
      "relocation_willingness",
    ]) {
      expect(hasFieldNormalizer(field), field).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The answer-type layer — 281 of the 466 corpus items depend on it
// ---------------------------------------------------------------------------

const BOOL_ATTR = item({
  question_key: "q_forklift",
  target_kind: "attribute",
  target_field: "forklift",
  answer_type: "boolean",
  // ZERO options, exactly like all 236 boolean items in the shipped corpus. There has never been
  // a chip to tap here, which is why the type layer had to exist at all.
  options: [],
});

const opt = (key: string, label: string) => ({
  option_key: key,
  label_text: label,
  value: key,
  implies_skill_id: null,
  is_none_of_above: false,
});

const MULTI_ATTR = item({
  question_key: "q_pipe_material",
  target_kind: "attribute",
  target_field: "pipe_material",
  answer_type: "multi_select",
  options: [opt("pvc", "PVC"), opt("gi", "GI"), opt("cpvc", "CPVC")],
});

const SINGLE_ATTR = item({
  question_key: "q_workplace_type",
  target_kind: "attribute",
  target_field: "workplace_type",
  answer_type: "single_select",
  options: [opt("factory", "Factory"), opt("workshop", "Workshop"), opt("site", "Site")],
});

// 41 of the 45 multi_select items are this: an RFS `skills` question, whose destination is a
// free-form list the canonicalization path owns.
const MULTI_RFS = item({
  question_key: "q_appliance_type",
  target_kind: "rfs",
  target_field: "skills",
  answer_type: "multi_select",
  options: [opt("split_ac", "Split AC"), opt("fridge", "Fridge")],
});

describe("boolean capture — the 236 items that carry no chips", () => {
  it("reads a spoken yes as TRUE, not as the sentence the worker said", () => {
    // The defect this closes: before the type layer, this stored "haan bilkul karta hoon" as the
    // value of a field whose entire vocabulary is true/false.
    expect(only(captureAnswer("haan bilkul karta hoon", BOOL_ATTR)).valueNormalized).toBe(true);
  });

  it("reads a spoken no as FALSE", () => {
    expect(only(captureAnswer("nahi, kabhi nahi chalaya", BOOL_ATTR)).valueNormalized).toBe(false);
  });

  it("a negated yes is FALSE, not TRUE", () => {
    // The direction that matters. A keyword scan sees "haan" and stores the opposite of the
    // worker's answer into a column the matcher filters on.
    expect(only(captureAnswer("haan nahi, main nahi chalata", BOOL_ATTR)).valueNormalized).toBe(
      false,
    );
  });

  it("captures NOTHING rather than guessing when the answer is a hedge", () => {
    // "sometimes" is not a boolean. Recording a false the worker did not say is worse than
    // leaving the question askable for its one bounded re-ask.
    expect(captureAnswer("kabhi kabhi", BOOL_ATTR).values).toHaveLength(0);
  });

  it("does not let the negation veto discard a legitimate FALSE", () => {
    // The trap `spanFor` is documented against: `parseAffirmation` already resolved the negation,
    // so handing its span to the veto would drop the answer entirely and record every worker who
    // said "nahi" as having said nothing.
    const capture = captureAnswer("nahi", BOOL_ATTR);
    expect(capture.values).toHaveLength(1);
    expect(capture.values[0]!.valueNormalized).toBe(false);
  });
});

describe("select capture — the destination decides what an unmatched answer means", () => {
  it("captures EVERY option the worker named, in the order they said them", () => {
    const value = only(captureAnswer("PVC aur GI dono", MULTI_ATTR)).valueNormalized;
    expect(value).toEqual(["pvc", "gi"]);
  });

  it("drops an option the worker REFUSED", () => {
    // Reusing the negation engine rather than scanning the raw string is the whole point: a
    // refused option must not be recorded as a claimed one.
    expect(only(captureAnswer("PVC hai, GI nahi", MULTI_ATTR)).valueNormalized).toEqual(["pvc"]);
  });

  it("does not let a contained label double-count its own characters", () => {
    // "CPVC" contains "PVC". Longest-first with consumption is why this reports one option.
    expect(only(captureAnswer("sirf CPVC", MULTI_ATTR)).valueNormalized).toEqual(["cpvc"]);
  });

  it("takes a single_select answer when exactly one option was named", () => {
    expect(only(captureAnswer("main workshop mein hoon", SINGLE_ATTR)).valueNormalized).toBe(
      "workshop",
    );
  });

  it("captures NOTHING when a single_select answer names two options", () => {
    // A worker who names two has not answered a single-choice question, and picking the first
    // would be picking at random.
    expect(captureAnswer("factory aur workshop dono", SINGLE_ATTR).values).toHaveLength(0);
  });

  it("captures NOTHING when an ATTRIBUTE select matches no option", () => {
    // `worker_attributes.value_text` is filtered by equality. A sentence there is not a worse
    // value, it is an unmatchable one.
    expect(captureAnswer("bahar khule mein kaam karta hoon", SINGLE_ATTR).values).toHaveLength(0);
  });

  it("KEEPS the worker's words when an RFS select matches no option", () => {
    // The asymmetry is deliberate. `skills` is a free-form list the canonicalization path owns,
    // so the worker's own words are strictly more information than nothing.
    expect(
      only(captureAnswer("main deep freezer ka kaam karta hoon", MULTI_RFS)).valueNormalized,
    ).toBe("main deep freezer ka kaam karta hoon");
  });

  it("still prefers an EXACT chip match over the scan", () => {
    // A tapped chip is the answer of record verbatim; the scan must not get to reinterpret it.
    expect(only(captureAnswer("Split AC", MULTI_RFS)).valueNormalized).toEqual(["split_ac"]);
  });
});

describe("chip labels are worker-facing COPY, not tokens", () => {
  // Verbatim from qp_welding: the mild-steel chip reads "Loha ya mild steel" — *iron or mild
  // steel* — because a chip has to be readable. A live session against the seeded corpus is
  // what surfaced this: the worker said "mild steel aur stainless steel" and only ONE material
  // was captured, because the whole label is a substring of nothing anyone says.
  const MATERIAL = item({
    question_key: "q_material_worked",
    target_kind: "attribute",
    target_field: "material_worked",
    answer_type: "multi_select",
    options: [
      { ...opt("mild_steel", "Loha ya mild steel"), value: "mild_steel" },
      { ...opt("stainless", "Stainless steel"), value: "stainless" },
      { ...opt("aluminium", "Aluminium"), value: "aluminium" },
    ],
  });

  it("captures BOTH materials when the worker names one alternative from a compound label", () => {
    expect(only(captureAnswer("mild steel aur stainless steel", MATERIAL)).valueNormalized).toEqual(
      ["mild_steel", "stainless"],
    );
  });

  it("still captures the whole label when the worker says it in full", () => {
    expect(only(captureAnswer("loha ya mild steel", MATERIAL)).valueNormalized).toEqual([
      "mild_steel",
    ]);
  });

  it("matches the OTHER alternative too — 'loha' alone is the same chip", () => {
    expect(only(captureAnswer("sirf loha", MATERIAL)).valueNormalized).toEqual(["mild_steel"]);
  });

  it("counts an option ONCE even when two of its needles are present", () => {
    // "loha" and "mild steel" are both alternatives of the same chip. Two hits would put a
    // duplicate in a column the matcher reads as a set.
    expect(only(captureAnswer("loha aur mild steel", MATERIAL)).valueNormalized).toEqual([
      "mild_steel",
    ]);
  });

  it("still drops an alternative the worker REFUSED", () => {
    expect(only(captureAnswer("stainless steel, loha nahi", MATERIAL)).valueNormalized).toEqual([
      "stainless",
    ]);
  });
});

// ---------------------------------------------------------------------------
// A yes/no on a select whose options ARE a yes and a no (#713)
// ---------------------------------------------------------------------------

/**
 * The `relocation` item, VERBATIM FROM THE SHIPPED CORPUS rather than hand-built.
 *
 * It is in `qp_universal`, so every worker is asked it, and the whole defect was a disagreement
 * between the authored options and what the field normalizer could read. A fixture that restated
 * either half would be testing my reading of the corpus instead of the corpus.
 */
const RELOCATION = item({
  question_key: "relocation",
  target_kind: "rfs",
  target_field: "relocation_willingness",
  answer_type: "single_select",
  max_asks: 1,
  options: [
    { option_key: "yes", label_text: "Haan, jaa sakta hoon", value: true } as never,
    { option_key: "no", label_text: "Nahi, yahi rehna hai", value: false } as never,
    { option_key: "maybe", label_text: "Sahi kaam mile to soch sakta hoon", value: true } as never,
  ],
});

/** `qp_welding`'s `welding_position` — the other of the two, and an ATTRIBUTE rather than rfs. */
const WELD_POSITION = item({
  question_key: "welding_position",
  target_kind: "attribute",
  target_field: "welding_position",
  answer_type: "single_select",
  options: [
    { option_key: "yes", label_text: "Haan, kar leta hoon", value: true } as never,
    { option_key: "no", label_text: "Nahi, sirf flat", value: false } as never,
  ],
});

describe("relocation was answerable by tapping and not by typing (#713)", () => {
  // MEASURED BEFORE THE FIX, against this exact item: every one of the yes-forms below except the
  // two carrying an explicit relocate cue captured NOTHING, and no typed sentence could EVER
  // record `false` — while the `no` chip recorded one cleanly. The same question, in the same
  // pack, was "yes or unknown" typed and "yes / no / conditional" tapped.
  it.each([
    "haan",
    "haan ji",
    "haan jaa sakta hoon",
    "haan doosre sheher jaa sakta hoon",
    "kahin bhi jaa sakta hoon",
  ])("captures TRUE for %j", (text) => {
    expect(only(captureAnswer(text, RELOCATION)).valueNormalized).toBe(true);
  });

  it.each(["nahi", "nahi yahi rehna hai"])("captures FALSE for %j", (text) => {
    // The asymmetry that mattered most. `parseRelocationWillingness` only ever returns `true` —
    // rightly, since "did not say" is not "said no" — but that left an EXPLICIT refusal, including
    // the no-chip's own words, indistinguishable from silence.
    expect(only(captureAnswer(text, RELOCATION)).valueNormalized).toBe(false);
  });

  it("still captures NOTHING for 'shayad' — the rule reads cues, it does not guess", () => {
    // The one-directional rule this fix must not weaken: no polarity cue means no answer. The
    // `conditional` option stays reachable by its label only, which is what it was before.
    expect(captureAnswer("shayad", RELOCATION).values).toHaveLength(0);
  });

  it("leaves the two BOOLEAN chip labels exactly as they were", () => {
    expect(only(captureAnswer("Haan, jaa sakta hoon", RELOCATION)).valueNormalized).toBe(true);
    expect(only(captureAnswer("Nahi, yahi rehna hai", RELOCATION)).valueNormalized).toBe(false);
  });

  it("the `maybe` chip now captures TRUE — #731, ruled in the corpus not the type check", () => {
    // WAS A MEASURED GAP UNTIL #731. The chip shipped `value_text: "conditional"` against a
    // `boolean` field, so `keepIfWellTyped` (#722) refused it and — with `max_asks: 1`, no second
    // ask — the worker answered and the profile recorded silence.
    //
    // The refusal was never the bug and is untouched here: a string in `z.boolean()` throws in the
    // extraction job and costs the whole profile, which is the defect #710 fixed. The bug was a
    // chip in the corpus that no code path could store. The fix is therefore in the CORPUS, not in
    // the type check — `value_bool: true`, ruled by the owner on 2026-08-10, because what a
    // conditional willingness should store decides which jobs that worker is shown (§2) and is not
    // a typing call. `yes` and `maybe` now both store `true`; the labels stay distinct, so the
    // answer of record still says which one the worker tapped.
    const capture = captureAnswer("sahi kaam mile to soch sakta hoon", RELOCATION);
    expect(only(capture).valueNormalized).toBe(true);
  });

  it("stores a BOOLEAN, the same value the chip stores — not the string 'true'", () => {
    // `relocation_willingness` is `z.boolean()` on the draft, so a string here throws in the
    // extraction job (#710 fixed the chip half of exactly this).
    expect(typeof only(captureAnswer("haan", RELOCATION)).valueNormalized).toBe("boolean");
  });

  it("reaches the ATTRIBUTE select too, where an unmatched answer was simply lost", () => {
    // `welding_position`'s labels are "Haan, kar leta hoon" / "Nahi, sirf flat", so a worker who
    // says "haan" matches no whole label — and being an attribute it does not even fall through
    // to verbatim.
    expect(only(captureAnswer("haan", WELD_POSITION)).valueNormalized).toBe(true);
    expect(only(captureAnswer("nahi", WELD_POSITION)).valueNormalized).toBe(false);
  });
});

describe("the yes/no fallback cannot reach past the question on screen", () => {
  it("does NOT fire on the cross-question path", () => {
    // `fillCrossQuestion` runs capture over every OTHER item with a field normalizer, and
    // `relocation` has one — so without the guard a worker answering "haan, 8 saal" to the
    // EXPERIENCE question would be recorded as willing to relocate. A bare yes/no carries no
    // subject; it means whatever was just asked.
    expect(captureAnswer("haan", RELOCATION, { crossQuestion: true }).values).toHaveLength(0);
    expect(captureAnswer("haan 8 saal", RELOCATION, { crossQuestion: true }).values).toHaveLength(
      0,
    );
    expect(captureAnswer("nahi", RELOCATION, { crossQuestion: true }).values).toHaveLength(0);
  });

  it("but does NOT disable the typed parser there — that is the whole point of that path", () => {
    // An explicit relocate cue is information a worker volunteered, and `parseRelocationWillingness`
    // is exactly the "typed parser" the cross-question gate exists to admit.
    const capture = captureAnswer("haan doosre sheher jaa sakta hoon", RELOCATION, {
      crossQuestion: true,
    });
    expect(only(capture).valueNormalized).toBe(true);
  });

  it("leaves text-valued selects untouched — they never reach the yes/no lexicon", () => {
    // The 638 text-valued options in the corpus: the boolean filter runs first, so a yes cue in
    // an answer to one of them changes nothing.
    expect(captureAnswer("haan", SINGLE_ATTR).values).toHaveLength(0);
    expect(only(captureAnswer("haan main workshop mein hoon", SINGLE_ATTR)).valueNormalized).toBe(
      "workshop",
    );
  });

  it("ACCEPTS two options claiming the same polarity — they agree on the value it stores", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and #731 is why it flipped. The rule was "exactly one
    // option may claim the polarity", on the reasoning that two `true` options mean the item is not
    // a yes/no question and picking either would be picking at random. Ruling #731 gave
    // `qp_universal`'s `relocation` a second `true` chip deliberately, so that reasoning stopped
    // holding on the one pack every worker walks — and "exactly one" quietly turned the typed path
    // back off for all of them, reintroducing the #713 defect.
    //
    // There is no random pick to protect against here: the path stores the POLARITY, not the
    // option. Both chips agree on `true` by construction, and `true` is what either would have
    // stored. Ambiguity between LABELS is a different thing and is still refused — `matchOptions`
    // requires exactly one whole label to land, and this lexicon only runs on a clean miss of it.
    const TWO_TRUE = item({
      question_key: "q_two_true",
      target_kind: "attribute",
      answer_type: "single_select",
      options: [
        { option_key: "a", label_text: "Haan bilkul", value: true } as never,
        { option_key: "b", label_text: "Haan thoda", value: true } as never,
        { option_key: "c", label_text: "Nahi, bilkul nahi", value: false } as never,
      ],
    });
    expect(only(captureAnswer("haan", TWO_TRUE)).valueNormalized).toBe(true);
    // The opposite polarity still resolves to its own single chip, unaffected. NO LABEL HERE IS THE
    // WHOLE WORD "nahi" — otherwise the chip-exact branch would answer this before the yes/no
    // lexicon ever ran, and the assertion would pass without touching the code it names.
    expect(only(captureAnswer("nahi", TWO_TRUE)).valueNormalized).toBe(false);
  });

  it("refuses a polarity NO option claims — the guard that survived #731", () => {
    // The half of the old rule that is still load-bearing, and the reason the check became
    // `=== 0` rather than being deleted. An item offering only a `false` chip has no `true` to
    // mean, so reading "haan" as `true` would invent an answer the item cannot express.
    const ONLY_FALSE = item({
      question_key: "q_only_false",
      target_kind: "attribute",
      answer_type: "single_select",
      options: [
        { option_key: "no", label_text: "Nahi bilkul", value: false } as never,
        { option_key: "never", label_text: "Kabhi nahi", value: false } as never,
      ],
    });
    expect(captureAnswer("haan", ONLY_FALSE).values).toHaveLength(0);
  });
});

/**
 * #2250 — the words a typed answer's capture did NOT read. The free chat's résumé mode lets a bare
 * typed answer skip its classifier, and reads this to tell "5 saal" from "5 saal, ab marna hai".
 */
describe("typedAnswerResidue — what a typed capture did not read", () => {
  const OUTPUT = item({
    question_key: "target_output",
    target_kind: "attribute",
    target_field: "target_output",
    answer_type: "number",
  });
  const MATERIAL = item({
    question_key: "q_material_worked",
    target_kind: "attribute",
    target_field: "material_worked",
    answer_type: "multi_select",
    options: [
      { ...opt("mild_steel", "Loha ya mild steel"), value: "mild_steel" },
      { ...opt("stainless", "Stainless steel"), value: "stainless" },
    ],
  });

  it.each<[QuestionPackItem, string, readonly string[]]>([
    [YEARS, "5 saal", []],
    [YEARS, "5 saal, ab marna hai", ["ab", "marna", "hai"]],
    [CITY, "main Pune se hoon", ["main", "se", "hoon"]],
    [OUTPUT, "50", []],
    [OUTPUT, "५० piece", ["piece"]],
    [OUTPUT, "50 piece, marna hai", ["piece", "marna", "hai"]],
    [MATERIAL, "mild steel aur stainless steel", ["aur"]],
    [MATERIAL, "Loha ya mild steel, jeena nahi", ["jeena", "nahi"]],
  ])("%#: %j", (question, text, residue) => {
    expect(typedAnswerResidue(question, text)).toEqual(residue);
  });

  it("blanks a needle only as a whole word, so an option label never eats a distress word", () => {
    const MAR = item({
      question_key: "q_mar",
      target_kind: "attribute",
      target_field: "mar_field",
      answer_type: "multi_select",
      options: [{ ...opt("mar", "Mar"), value: "mar" }],
    });
    // The option is matched (substring), and the word it sits in is still read whole.
    expect(only(captureAnswer("marna", MAR)).valueNormalized).toEqual(["mar"]);
    expect(typedAnswerResidue(MAR, "marna")).toEqual(["marna"]);
    expect(typedAnswerResidue(MAR, "mar")).toEqual([]);
  });

  it("blanks digits only on a number question with no parser", () => {
    expect(isParserlessNumber(OUTPUT)).toBe(true);
    expect(
      isParserlessNumber(
        item({ question_key: "q", target_field: "training_year", answer_type: "number" }),
      ),
    ).toBe(false);
    expect(typedAnswerResidue(YEARS, "5 saal, 2 baar")).toEqual(["2", "baar"]);
  });

  it("matches options exactly as before the refactor", () => {
    expect(matchOptions(MATERIAL, "mild steel aur stainless steel")).toEqual([
      "mild_steel",
      "stainless",
    ]);
    expect(matchOptions(MATERIAL, "stainless nahi, loha")).toEqual(["mild_steel"]);
  });
});
