import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { V2_EDIT_NONE } from "../companion-replies";
import { hasControlChars } from "./edit-catalogue";
import { profileRow, setup, WORKER_ID } from "./companion-edit.fake";

/**
 * #1943's twin on the edit path. The issue was filed against the career gate, and the grep for
 * "the same gap" found the edit card: `normaliseValue` bounds each field by length, not content,
 * so a model-proposed `"Tata Steel L\u0001td"` was carded and written on Haan, and the value lives
 * in `proposal:{workerId}` for the card's TTL. The gate is in `validateRow`, so it holds for
 * every section and every field that carries a value.
 */

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;

const TATA = {
  employment_id: "66666666-6666-4666-8666-666666666666",
  employer_name: "Tata Motors",
  employer_city: "Pune",
  employer_state: null,
  start_ym: "2019-01",
  end_ym: null,
  roles: [
    {
      role_label: "Welder",
      start_ym: "2019-01",
      end_ym: null,
      work_done: null,
      work_done_voice_note_id: null,
      description_source: null,
    },
  ],
};

const edit = (field: string, value: string) => ({
  op: "edit",
  section: "employment",
  ref: "e1",
  field,
  value,
});

describe("hasControlChars (#1943) — C0/C1 controls only, layout controls pass", () => {
  it.each([
    ["a C0 control inside 'Ltd'", "Tata Steel L\u0001td"],
    ["NEL inside 'Ltd'", "Tata Steel\u0085Ltd"],
    ["a NUL inside a value", "Sal\u0000ary"],
    ["DEL", "Tata\u007fMotors"],
    ["a C1 control", "Tata\u009bMotors"],
  ])("%s → true", (_label, value) => {
    expect(hasControlChars(value)).toBe(true);
  });

  it.each([
    ["a tab", "line one\tline two"],
    ["a newline", "line one\nline two"],
    ["a carriage return", "line one\rline two"],
    ["ordinary text", "Tata Motors Ltd"],
    ["a hyphen and a dot", "Pvt.Ltd - Pune"],
  ])("%s → false", (_label, value) => {
    expect(hasControlChars(value)).toBe(false);
  });
});

describe("propose drops a model row whose value carries a control character (#1943)", () => {
  it.each([
    ["a C0 control inside a legal suffix (the issue's shape)", "employer_name", "Tata Steel L\u0001td"],
    ["NEL inside a legal suffix", "employer_name", "Tata Steel\u0085Ltd"],
    ["a control inside a phone number", "work_done", "Call kariye 98765\u008543210 par"],
    ["DEL inside a role label", "role_label", "Senior\u007fWelder"],
  ])("%s → no card", async (_label, field, value) => {
    const h = setup({ parse: { rows: [edit(field, value)], unsupported: [] }, employmentViews: [TATA] });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("the same rows with a plain value are carded — the control is the only difference", async () => {
    const h = setup({
      parse: { rows: [edit("employer_name", "Tata Steel Ltd")], unsupported: [] },
      employmentViews: [TATA],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({ op: "edit", after: "Tata Steel Ltd" });
  });

  it("a control in a language row's value is dropped too (not only employment)", async () => {
    const h = setup({
      parse: {
        rows: [
          { op: "add", section: "languages", ref: null, field: "language", value: "hin\u0001di" },
        ],
        unsupported: [],
      },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(turn.edit_proposal).toBeUndefined();
  });

  it("a delete row carries no value, so it is untroubled by the gate", async () => {
    // The gate reads the VALUE only; a delete's anchor field is the row's target, never its text.
    const h = setup({
      parse: {
        rows: [{ op: "delete", section: "languages", ref: "l1", field: "language", value: null }],
        unsupported: [],
      },
      languageEntries: [{ language: "hindi", can_speak: true, can_read: true, can_write: false }],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "Hindi hata do", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
  });

  it("a tab or a newline in a free-text value stays cardable (layout only)", async () => {
    const h = setup({
      parse: { rows: [edit("work_done", "lathe pe kaam\troz 8 ghante")], unsupported: [] },
      employmentViews: [TATA],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
  });
});
