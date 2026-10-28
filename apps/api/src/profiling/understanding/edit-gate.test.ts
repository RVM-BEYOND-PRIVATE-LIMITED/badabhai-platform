import { describe, expect, it } from "vitest";
import type { LlmInterviewDraft, QuestionPackItem } from "@badabhai/ai-contracts";

import { recordAnswer, type AnswerMap } from "../answer-map";
import {
  applyEditProposal,
  buildEditProposal,
  EDIT_CONFIRM_OPTIONS,
  EDIT_DELETE_WARNING,
  editConfirmReply,
  editGateTurn,
  editProposalWire,
  editResolvedLead,
  jobsTotalYears,
  mergedJob,
  narrowEditGate,
  readEditConfirmReply,
  rowForAnswer,
  type EditRow,
  type ProposalInput,
} from "./edit-gate";
import { buildProfilingSchema, EXPERIENCE_KEY, ROLE_KEY, SKILLS_KEY } from "./profiling-schema";

/**
 * ADR-0057 §3.4 (#2312) — the Haan/Nahi gate on a filled field: what may be put to the worker,
 * what Haan writes, and the words on screen. The model proposes; these rules decide.
 */

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

const YEARS = item({
  question_key: "experience_years",
  target_field: "experience_years",
  prompt_text: "Kitne saal ka tajurba hai?",
});
const CITY = item({ question_key: "current_city", target_field: "current_city" });
const TOOLS = item({
  question_key: "tools_owned",
  target_field: "tools_owned",
  answer_type: "boolean",
  prompt_text: "Kya aapke paas apne tools hain?",
});
const TRAINING = item({
  question_key: "training_name",
  target_field: "training_name",
  prompt_text: "Koi training ki hai?",
});
const ITEMS = [YEARS, CITY, TOOLS, TRAINING];

const DRAFT: LlmInterviewDraft = {
  domain_label: null,
  role_label: "Fitter",
  skills: ["Welding", "Grinding"],
  experiences: [
    { role_label: "Fitter", duration_text: "3 saal", duration_months: 36, work_done: "assembly" },
    { role_label: "Helper", duration_text: "2 saal", duration_months: 24, work_done: "loading" },
  ],
};

const answered = (map: AnswerMap, key: string, value: unknown, raw: string): AnswerMap =>
  recordAnswer(
    map,
    { questionKey: key, targetField: key, valueRaw: raw, valueNormalized: value, evidence: null },
    1,
  );

const ANSWERS = answered(
  answered(answered({}, "experience_years", 5, "5 saal"), "tools_owned", true, "haan"),
  "training_name",
  "CNC Basics",
  "CNC Basics",
);

function input(over: Partial<ProposalInput> = {}): ProposalInput {
  return {
    view: buildProfilingSchema(ITEMS, ANSWERS, DRAFT),
    answers: ANSWERS,
    draft: DRAFT,
    edits: [],
    conflicts: [],
    correction: null,
    phaseALeads: false,
    ...over,
  };
}

describe("building a proposal — every row checked against the session's catalogue", () => {
  it("puts a pack field's change through its own parser, worded for the worker", () => {
    const out = buildEditProposal(
      input({ edits: [{ op: "edit", key: "experience_years", ref: null, value: "2" }] }),
    );
    expect(out.rows).toEqual([
      {
        key: "experience_years",
        op: "edit",
        index: null,
        label: "Experience",
        before: "5 saal",
        after: "2 saal",
        value: "2",
      },
    ]);
  });

  it("drops a change that changes nothing, and an unknown key", () => {
    const out = buildEditProposal(
      input({
        edits: [
          { op: "edit", key: "tools_owned", ref: null, value: "true" },
          { op: "edit", key: "salary", ref: null, value: "20000" },
          { op: "delete", key: "current_city", ref: null, value: null }, // nothing to remove
        ],
      }),
    );
    expect(out.rows).toEqual([]);
    expect(out.awaiting).toBeNull();
  });

  // #2467 — "notice period 3 mahine kar do" on a field with no 3-month chip was dropped, and the
  // message fell through to be filed as the answer to whatever question was on screen.
  it("asks for a filled field whose new value its parser cannot read, instead of dropping it", () => {
    const out = buildEditProposal(
      input({ edits: [{ op: "edit", key: "experience_years", ref: null, value: "bahut saara" }] }),
    );
    expect(out.rows).toEqual([]);
    expect(out.awaiting).toEqual({ key: "experience_years", index: null, label: "Experience", before: "5 saal" });
  });

  it("an unreadable value never asks for an EMPTY field, and a readable row still wins", () => {
    const empty = buildEditProposal(
      input({ edits: [{ op: "edit", key: "current_city", ref: null, value: "???" }] }),
    );
    expect(empty).toEqual({ rows: [], awaiting: null, rolePointer: null });
    const both = buildEditProposal(
      input({
        edits: [
          { op: "edit", key: "experience_years", ref: null, value: "bahut saara" },
          { op: "delete", key: "training_name", ref: null, value: null },
        ],
      }),
    );
    expect(both.rows).toHaveLength(1);
    expect(both.awaiting).toBeNull();
  });

  it("names a yes/no as Haan / Nahi, and a field by its own question when it has no short name", () => {
    const out = buildEditProposal(
      input({ edits: [{ op: "edit", key: "tools_owned", ref: null, value: "false" }] }),
    );
    expect(out.rows[0]).toMatchObject({ label: "Kya aapke paas apne tools hain", before: "Haan", after: "Nahi" });
  });

  it("a removal carries no new value", () => {
    const out = buildEditProposal(
      input({ edits: [{ op: "delete", key: "training_name", ref: null, value: null }] }),
    );
    expect(out.rows).toEqual([
      expect.objectContaining({ key: "training_name", op: "delete", before: "CNC Basics", after: null }),
    ]);
  });

  it("a change with no new value asks for the field instead — only when nothing else is put", () => {
    const asked = buildEditProposal(
      input({ edits: [{ op: "edit", key: "experience_years", ref: null, value: null }] }),
    );
    expect(asked.rows).toEqual([]);
    expect(asked.awaiting).toEqual({ key: "experience_years", index: null, label: "Experience", before: "5 saal" });
    const both = buildEditProposal(
      input({
        edits: [
          { op: "edit", key: "experience_years", ref: null, value: null },
          { op: "delete", key: "training_name", ref: null, value: null },
        ],
      }),
    );
    expect(both.rows).toHaveLength(1);
    expect(both.awaiting).toBeNull();
  });

  it("the trade is answered with the pointer, never proposed (owner ruling 2026-10-16)", () => {
    const view = buildProfilingSchema(ITEMS, ANSWERS, DRAFT);
    expect(view.rows.find((row) => row.key === ROLE_KEY)).toMatchObject({ value: "Fitter", status: "answered" });
    const out = buildEditProposal(
      input({ view, edits: [{ op: "edit", key: ROLE_KEY, ref: null, value: "Welder" }] }),
    );
    expect(out.rows).toEqual([]);
    expect(out.rolePointer).toEqual({ op: "edit" });
  });

  it("a fill that named a filled field, and the held-back correction, are changes too — once each", () => {
    const correction = [
      { questionKey: "experience_years", targetField: "experience_years", valueRaw: "2 saal", valueNormalized: 2, evidence: null },
    ];
    const out = buildEditProposal(
      input({
        conflicts: [{ key: "experience_years", value: "3" }],
        correction,
      }),
    );
    // The correction is read first; the fill for the same field is a duplicate and dropped.
    expect(out.rows).toEqual([expect.objectContaining({ key: "experience_years", after: "2 saal" })]);
  });

  it("skills and jobs by ref — a certified rename, a removal, and a job's changed part", () => {
    const out = buildEditProposal(
      input({
        edits: [
          { op: "edit", key: SKILLS_KEY, ref: "s2", value: "TIG welding" },
          { op: "delete", key: SKILLS_KEY, ref: "s1", value: null },
          { op: "edit", key: EXPERIENCE_KEY, ref: "x1", value: "2 saal" },
          { op: "edit", key: SKILLS_KEY, ref: "s9", value: "Cutting" }, // no such entry
          { op: "edit", key: SKILLS_KEY, ref: "s1", value: "grinding" }, // already held
        ],
      }),
    );
    expect(out.rows).toEqual([
      expect.objectContaining({ key: SKILLS_KEY, index: 1, op: "edit", before: "Grinding", after: "TIG welding" }),
      expect.objectContaining({ key: SKILLS_KEY, index: 0, op: "delete", before: "Welding" }),
      expect.objectContaining({
        key: EXPERIENCE_KEY,
        index: 0,
        before: "Fitter; 3 saal; assembly",
        after: "Fitter; 2 saal; assembly",
      }),
    ]);
  });

  it("leaves the lists to Phase A while the model leads", () => {
    const out = buildEditProposal(
      input({ phaseALeads: true, edits: [{ op: "delete", key: SKILLS_KEY, ref: "s1", value: null }] }),
    );
    expect(out.rows).toEqual([]);
  });
});

describe("a job's changed part", () => {
  const JOB = DRAFT.experiences[0] as LlmInterviewDraft["experiences"][number];

  it("keeps every part the worker left alone", () => {
    expect(mergedJob(JOB, "; ; welding ka kaam")).toMatchObject({
      role_label: "Fitter",
      duration_text: "3 saal",
      duration_months: 36,
      work_done: "welding ka kaam",
    });
  });

  it("reads one bare part as a duration when it is one, else as the role", () => {
    expect(mergedJob(JOB, "2 saal")).toMatchObject({ role_label: "Fitter", duration_months: 24 });
    expect(mergedJob(JOB, "Welder")).toMatchObject({ role_label: "Welder", duration_months: 36 });
  });
});

describe("applying a confirmed proposal (Haan)", () => {
  const rows = (...edits: Parameters<typeof buildEditProposal>[0]["edits"]): readonly EditRow[] =>
    buildEditProposal(input({ edits })).rows;

  it("writes a change with the old value kept as superseded history", () => {
    const out = applyEditProposal({
      rows: rows({ op: "edit", key: "experience_years", ref: null, value: "2" }),
      items: ITEMS,
      answers: ANSWERS,
      draft: DRAFT,
      askCounts: {},
      turn: 4,
    });
    expect(out.answers.experience_years?.value_normalized).toBe(2);
    expect(out.answers.experience_years?.history[0]).toMatchObject({ value_normalized: 5, status: "superseded" });
    expect(out.applied).toHaveLength(1);
  });

  it("a removed field is gone and askable again: its ask budget goes with it", () => {
    const out = applyEditProposal({
      rows: rows({ op: "delete", key: "training_name", ref: null, value: null }),
      items: ITEMS,
      answers: ANSWERS,
      draft: DRAFT,
      askCounts: { training_name: 2, current_city: 1 },
      turn: 4,
    });
    expect(out.answers.training_name).toBeUndefined();
    expect(out.askCounts).toEqual({ current_city: 1 });
  });

  it("a job changed re-sums the total experience from the jobs", () => {
    const out = applyEditProposal({
      rows: rows({ op: "edit", key: EXPERIENCE_KEY, ref: "x1", value: "1 saal" }),
      items: ITEMS,
      answers: ANSWERS,
      draft: DRAFT,
      askCounts: {},
      turn: 4,
    });
    expect(out.draft.experiences[0]).toMatchObject({ duration_text: "1 saal", duration_months: 12 });
    expect(out.answers.experience_years?.value_normalized).toBe(3); // 12 + 24 months
  });

  it("removes list entries from the highest index down, so every row lands on its own entry", () => {
    const out = applyEditProposal({
      rows: rows(
        { op: "delete", key: SKILLS_KEY, ref: "s1", value: null },
        { op: "delete", key: SKILLS_KEY, ref: "s2", value: null },
        { op: "delete", key: EXPERIENCE_KEY, ref: "x1", value: null },
      ),
      items: ITEMS,
      answers: ANSWERS,
      draft: DRAFT,
      askCounts: {},
      turn: 4,
    });
    expect(out.draft.skills).toEqual([]);
    expect(out.draft.experiences).toEqual([DRAFT.experiences[1]]);
    expect(out.answers.experience_years?.value_normalized).toBe(2);
  });

  it("FAILS CLOSED on a field that moved beneath the card: stale, not written", () => {
    const proposal = rows({ op: "edit", key: "experience_years", ref: null, value: "2" });
    const moved = answered(ANSWERS, "experience_years", 9, "9 saal");
    const out = applyEditProposal({
      rows: proposal,
      items: ITEMS,
      answers: moved,
      draft: DRAFT,
      askCounts: {},
      turn: 4,
    });
    expect(out.answers.experience_years?.value_normalized).toBe(9);
    expect(out.stale).toHaveLength(1);
    expect(out.applied).toEqual([]);
  });
});

describe("the answer to 'sahi <field> bataiye'", () => {
  it("is read through the field's own parser, and a skill through the certifier", () => {
    const view = buildProfilingSchema(ITEMS, ANSWERS, DRAFT);
    expect(
      rowForAnswer({ key: "experience_years", index: null, label: "Experience", before: "5 saal" }, "2 saal", view, ANSWERS, DRAFT),
    ).toMatchObject({ before: "5 saal", after: "2 saal" });
    expect(
      rowForAnswer({ key: SKILLS_KEY, index: 1, label: "Skill", before: "Grinding" }, "Cutting", view, ANSWERS, DRAFT),
    ).toMatchObject({ before: "Grinding", after: "Cutting" });
    expect(
      rowForAnswer({ key: "experience_years", index: null, label: "Experience", before: "5 saal" }, "pata nahi", view, ANSWERS, DRAFT),
    ).toBeNull();
  });
});

describe("the words on screen (owner copy 2026-10-16)", () => {
  const edit: EditRow = {
    key: "experience_years",
    op: "edit",
    index: null,
    label: "Experience",
    before: "5 saal",
    after: "2 saal",
    value: "2",
  };
  const removal: EditRow = {
    key: "training_name",
    op: "delete",
    index: null,
    label: "Training",
    before: "CNC Basics?",
    after: null,
    value: null,
  };

  it("one change, one removal, and several", () => {
    expect(editConfirmReply([edit])).toBe("Experience: 5 saal se 2 saal kar doon?");
    expect(editConfirmReply([removal])).toBe(`Training: CNC Basics hata doon? ${EDIT_DELETE_WARNING}`);
    expect(editConfirmReply([edit, removal])).toBe(
      "Ye badlaav kar doon?\n• Experience: 5 saal se 2 saal\n• Training: CNC Basics hatana (wapas nahi aayega)",
    );
  });

  it("the tile: before → after for a change, a warning for a removal, nothing internal", () => {
    const wire = editProposalWire({ id: "66666666-6666-4666-8666-666666666666", rows: [edit, removal] });
    expect(wire).toEqual({
      proposal_id: "66666666-6666-4666-8666-666666666666",
      rows: [
        { field_label: "Experience", op: "edit", before: "5 saal", after: "2 saal" },
        { field_label: "Training", op: "delete", before: "CNC Basics?", after: null, warning: EDIT_DELETE_WARNING },
      ],
    });
  });

  it("the line after: changed, removed, or kept", () => {
    expect(editResolvedLead([edit, removal], true)).toBe("Theek hai, badal diya.");
    expect(editResolvedLead([removal], true)).toBe("Theek hai, hata diya.");
    expect(editResolvedLead([], true)).toBe("Theek hai, kuch nahi badla.");
    expect(editResolvedLead([edit], false)).toBe("Theek hai, kuch nahi badla.");
  });

  it("the gate's turn: Haan / Nahi locked for a proposal, the field's own question for an ask", () => {
    const proposal = editGateTurn(
      { proposal: { id: "66666666-6666-4666-8666-666666666666", rows: [edit] }, awaiting: null, resumeKey: "current_city" },
      ITEMS,
    );
    expect(proposal).toMatchObject({ inputMode: "options_only", options: [...EDIT_CONFIRM_OPTIONS] });
    expect(proposal?.editProposal?.rows).toHaveLength(1);
    expect(
      editGateTurn(
        { proposal: null, awaiting: { key: "experience_years", index: null, label: "Experience", before: "5 saal" }, resumeKey: "current_city" },
        ITEMS,
      ),
    ).toMatchObject({ reply: "Theek hai, sahi Experience bataiye. Kitne saal ka tajurba hai?", inputMode: "text" });
  });

  it("a re-asked none-chip select locks like the interview's own ask", () => {
    const AVAIL = item({
      question_key: "availability",
      target_field: "availability",
      answer_type: "single_select",
      options: [
        { option_key: "immediate", label_text: "Abhi turant", value: "immediate", implies_skill_id: null, is_none_of_above: false },
        { option_key: "not_sure", label_text: "Abhi pata nahi", value: "unknown", implies_skill_id: null, is_none_of_above: true },
      ],
    });
    expect(
      editGateTurn(
        { proposal: null, awaiting: { key: "availability", index: null, label: "Availability", before: "Abhi turant" }, resumeKey: "current_city" },
        [...ITEMS, AVAIL],
      ),
    ).toMatchObject({ inputMode: "options_only" });
  });
});

describe("reading the reply to a proposal", () => {
  it.each([
    ["Haan", "yes"],
    ["edit_confirm_no", "no"],
    ["haan ji", "yes"],
    ["nahi", "no"],
    ["nahi, 3 saal", "other"],
    ["Pune", "other"],
  ] as const)("%s → %s", (text, read) => {
    expect(readEditConfirmReply(text)).toBe(read);
  });
});

describe("the state, read back from Redis", () => {
  it("an unreadable or empty gate is no gate", () => {
    expect(narrowEditGate(null)).toBeNull();
    expect(narrowEditGate({ proposal: null, awaiting: null, resumeKey: "x" })).toBeNull();
    expect(narrowEditGate({ proposal: { id: "not-a-uuid", rows: [] }, awaiting: null, resumeKey: null })).toBeNull();
  });
});

describe("the total from the jobs", () => {
  it("is whole years, and null when any job has no duration", () => {
    expect(jobsTotalYears(DRAFT.experiences)).toBe(5);
    expect(
      jobsTotalYears([...DRAFT.experiences, { role_label: "X", duration_text: "", duration_months: null, work_done: "" }]),
    ).toBeNull();
    expect(jobsTotalYears([])).toBeNull();
  });
});
