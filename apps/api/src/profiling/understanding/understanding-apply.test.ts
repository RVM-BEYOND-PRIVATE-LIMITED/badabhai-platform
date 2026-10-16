import { describe, expect, it } from "vitest";
import type { LlmInterviewDraft, QuestionPackItem } from "@badabhai/ai-contracts";

import { recordAnswer, type AnswerMap } from "../answer-map";
import {
  buildProfilingSchema,
  EXPERIENCE_KEY,
  jobLine,
  PAGE_OWNED_FACTS,
  SKILLS_KEY,
} from "./profiling-schema";
import { applyFills, newlyAnswered } from "./understanding-apply";

/** ADR-0057 (#2311) — the schema the model reads and the rules that decide what is written. */

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

const YEARS = item({ question_key: "experience_years", target_field: "experience_years" });
const CITY = item({ question_key: "current_city", target_field: "current_city" });
const TRAVEL = item({
  question_key: "willing_to_travel",
  target_field: "willing_to_travel",
  answer_type: "boolean",
});
const LANGS = item({
  question_key: "languages",
  target_field: "languages",
  answer_type: "multi_select",
  options: [
    { option_key: "hindi", label_text: "Hindi", implies_skill_id: null, is_none_of_above: false },
    { option_key: "marathi", label_text: "Marathi", implies_skill_id: null, is_none_of_above: false },
  ],
});
const ITEMS = [YEARS, CITY, TRAVEL, LANGS];
const EMPTY_DRAFT: LlmInterviewDraft = {
  domain_label: null,
  role_label: null,
  skills: [],
  experiences: [],
};
const DRAFT: LlmInterviewDraft = {
  ...EMPTY_DRAFT,
  skills: ["Welding", "Grinding"],
  experiences: [
    { role_label: "Fitter", duration_text: "3 saal", duration_months: 36, work_done: "assembly" },
  ],
};

const answered = (map: AnswerMap, key: string, value: unknown, raw: string): AnswerMap =>
  recordAnswer(
    map,
    { questionKey: key, targetField: key, valueRaw: raw, valueNormalized: value, evidence: null },
    1,
  );

describe("the profiling schema", () => {
  const view = buildProfilingSchema(ITEMS, answered({}, "experience_years", 5, "5 saal"), DRAFT);

  it("shows every chat-servable item with its status and value, and the two draft lists", () => {
    const keys = view.rows.map((row) => row.key);
    // The trade is shown only once known (#2312): DRAFT names none.
    expect(keys).toEqual([...ITEMS.map((i) => i.question_key), SKILLS_KEY, EXPERIENCE_KEY]);
    const years = view.rows.find((row) => row.key === "experience_years");
    expect(years).toMatchObject({ kind: "duration", status: "answered", value: "5 saal" });
    expect(view.rows.find((row) => row.key === "current_city")).toMatchObject({
      kind: "city",
      status: "missing",
      value: null,
    });
    expect(view.rows.find((row) => row.key === "languages")?.options).toEqual(["Hindi", "Marathi"]);
  });

  it("lists skills and jobs with per-request refs, never ids", () => {
    const skills = view.rows.find((row) => row.key === SKILLS_KEY);
    expect(skills?.entries).toEqual([
      { ref: "s1", value: "Welding" },
      { ref: "s2", value: "Grinding" },
    ]);
    expect(view.rows.find((row) => row.key === EXPERIENCE_KEY)?.entries).toEqual([
      { ref: "x1", value: "Fitter; 3 saal; assembly" },
    ]);
    expect(view.skillRefs.get("s2")).toBe(1);
    expect(view.experienceRefs.get("x1")).toBe(0);
  });

  it("names the Profile-page facts and nothing personal", () => {
    expect(PAGE_OWNED_FACTS).toContain("expected_salary");
    expect(view.rows.some((row) => /name|phone/i.test(row.key))).toBe(false);
  });

  it("writes a job the way a new one is filled", () => {
    expect(jobLine({ role_label: "Welder", duration_text: "", duration_months: null, work_done: "" }))
      .toBe("Welder");
  });
});

describe("applying the fills (R4: empty fields only)", () => {
  const base = { onScreenKey: null, phaseALeads: false, turn: 2 } as const;

  it("fills an empty field through its own parser, and notes it", () => {
    const view = buildProfilingSchema(ITEMS, {}, EMPTY_DRAFT);
    const out = applyFills({
      ...base,
      view,
      fills: [
        { key: "current_city", value: "Pune" },
        { key: "willing_to_travel", value: "true" },
        { key: "experience_years", value: "7" },
      ],
      answers: {},
      draft: EMPTY_DRAFT,
    });
    expect(out.answers.current_city?.value_normalized).toBe("Pune");
    expect(out.answers.willing_to_travel?.value_normalized).toBe(true);
    expect(out.answers.experience_years?.value_normalized).toBe(7);
    expect(out.appliedKeys).toEqual(["current_city", "willing_to_travel", "experience_years"]);
    expect(out.noted).toHaveLength(3);
  });

  it("never overwrites a filled field — a different value is counted as a change", () => {
    const answers = answered({}, "experience_years", 5, "5 saal");
    const view = buildProfilingSchema(ITEMS, answers, EMPTY_DRAFT);
    const out = applyFills({
      ...base,
      view,
      fills: [{ key: "experience_years", value: "7" }],
      answers,
      draft: EMPTY_DRAFT,
    });
    expect(out.answers.experience_years?.value_normalized).toBe(5);
    expect(out.conflicts).toEqual([{ key: "experience_years", value: "7" }]);
    expect(out.appliedKeys).toEqual([]);
  });

  it("leaves the question on screen to the deterministic capture", () => {
    const view = buildProfilingSchema(ITEMS, {}, EMPTY_DRAFT);
    const out = applyFills({
      ...base,
      onScreenKey: "current_city",
      view,
      fills: [{ key: "current_city", value: "Pune" }],
      answers: {},
      draft: EMPTY_DRAFT,
    });
    expect(out.answers.current_city).toBeUndefined();
  });

  it("drops a value its field's parser cannot read", () => {
    const view = buildProfilingSchema(ITEMS, {}, EMPTY_DRAFT);
    const out = applyFills({
      ...base,
      view,
      fills: [{ key: "experience_years", value: "bahut saara" }],
      answers: {},
      draft: EMPTY_DRAFT,
    });
    expect(out.appliedKeys).toEqual([]);
  });

  it("adds a certified skill and a parsed job — once Phase A has handed over", () => {
    const view = buildProfilingSchema(ITEMS, {}, DRAFT);
    const fills = [
      { key: SKILLS_KEY, value: "TIG welding" },
      { key: SKILLS_KEY, value: "welding" }, // already held, case-insensitive
      { key: EXPERIENCE_KEY, value: "Welder; 2 saal; structure ka kaam" },
    ];
    const out = applyFills({ ...base, view, fills, answers: {}, draft: DRAFT });
    expect(out.draft.skills).toEqual(["Welding", "Grinding", "TIG welding"]);
    expect(out.draft.experiences.at(-1)).toMatchObject({
      role_label: "Welder",
      duration_text: "2 saal",
      duration_months: 24,
      work_done: "structure ka kaam",
    });
    const led = applyFills({ ...base, phaseALeads: true, view, fills, answers: {}, draft: DRAFT });
    expect(led.draft).toBe(DRAFT);
  });

  it("refuses a job with no role", () => {
    const view = buildProfilingSchema(ITEMS, {}, EMPTY_DRAFT);
    const out = applyFills({
      ...base,
      view,
      fills: [{ key: EXPERIENCE_KEY, value: "; 2 saal; kaam" }],
      answers: {},
      draft: EMPTY_DRAFT,
    });
    expect(out.draft.experiences).toEqual([]);
  });
});

describe("what a bridge line acknowledges", () => {
  it("names every field newly answered, except the excluded keys", () => {
    const view = buildProfilingSchema(ITEMS, {}, EMPTY_DRAFT);
    const after = answered(answered({}, "current_city", "Pune", "Pune"), "experience_years", 7, "7 saal");
    expect(newlyAnswered({}, after, view, ["experience_years"])).toEqual(["current_city?: Pune"]);
  });
});
