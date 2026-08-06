import { describe, expect, it } from "vitest";

import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { captureAnswer, mayCommit } from "./answer-capture";
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
const RELOCATE = item({ question_key: "q_reloc", target_field: "willing_to_relocate" });
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
});
