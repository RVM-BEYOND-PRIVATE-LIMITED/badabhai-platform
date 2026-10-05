import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { CompanionEditRow } from "@badabhai/ai-contracts";
import { V2_EDIT_NONE } from "../companion-replies";
import { profileRow, setup, WORKER_ID } from "./companion-edit.fake";
import { expandListEdits } from "./edit-normalise";
import type { SnapshotRow } from "./edit-snapshot";

/**
 * WP4 (2026-10-05): the three list preferences take members, not replacements. The 2026-10-01
 * eval caught the model answering list changes with `op: "edit"` (out-of-catalogue, so the worker
 * got no card). The prompt states the rule; `expandListEdits` is the deterministic second layer.
 */

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;

const PC1: SnapshotRow = {
  ref: "pc1",
  section: "preferences",
  fields: { preferred_cities: "Pune" },
  target: { member: "Pune" },
};
const WT1: SnapshotRow = {
  ref: "wt1",
  section: "preferences",
  fields: { work_types: "permanent" },
  target: { member: "permanent" },
};
const PREF: SnapshotRow = {
  ref: "pref",
  section: "preferences",
  fields: { shift: "day" },
  target: null,
};
const BY_REF = new Map([PC1, WT1, PREF].map((r) => [r.ref, r]));

const row = (over: Partial<CompanionEditRow> = {}): CompanionEditRow => ({
  op: "edit",
  section: "preferences",
  ref: "pc1",
  field: "preferred_cities",
  value: "Nashik",
  ...over,
});

describe("expandListEdits — an edit on a list member becomes delete old + add new", () => {
  it("preferred_cities: edit pc1 → delete Pune, then add the new member", () => {
    expect(expandListEdits([row()], BY_REF)).toEqual([
      { op: "delete", section: "preferences", ref: "pc1", field: "preferred_cities", value: null },
      { op: "add", section: "preferences", ref: null, field: "preferred_cities", value: "Nashik" },
    ]);
  });

  it("work_types and documents_ready take the same shape", () => {
    const wt = expandListEdits(
      [row({ ref: "wt1", field: "work_types", value: "daily_wage" })],
      BY_REF,
    );
    expect(wt.map((r) => r.op)).toEqual(["delete", "add"]);
    expect(wt[1]).toMatchObject({ op: "add", ref: null, field: "work_types", value: "daily_wage" });
  });

  it("a scalar field with a legal edit passes through untouched", () => {
    const scalar = row({ ref: "pref", field: "shift", value: "night" });
    expect(expandListEdits([scalar], BY_REF)).toEqual([scalar]);
  });

  it("a row the catalogue does not know passes through — validateRow owns that verdict", () => {
    const unknown = row({ field: "salary_period", value: "monthly" });
    expect(expandListEdits([unknown], BY_REF)).toEqual([unknown]);
  });

  it("a non-edit list row passes through", () => {
    const del = row({ op: "delete", value: null });
    expect(expandListEdits([del], BY_REF)).toEqual([del]);
  });
});

describe("expandListEdits — every ambiguity drops the row (fail closed)", () => {
  it.each([
    ["no ref", row({ ref: null })],
    ["an unknown ref", row({ ref: "pc9" })],
    ["no value", row({ value: null })],
    ["a field the ref's entry lacks", row({ ref: "pref", field: "preferred_cities" })],
    ["another section's ref", row({ ref: "e1" })],
    ["a value the dictionary refuses", row({ value: "atlantis" })],
    ["the same member it would delete", row({ value: "Pune" })],
  ])("%s", (_label, modelRow) => {
    expect(expandListEdits([modelRow], BY_REF)).toEqual([]);
  });

  it("a row whose field is null passes through (validateRow drops it unseen)", () => {
    const noField = row({ field: null });
    expect(expandListEdits([noField], BY_REF)).toEqual([noField]);
  });
});

describe("propose cards the expanded pair (integration)", () => {
  it("'city list me Pune ki jagah Nashik' — edit on pc1 cards two rows: remove Pune, add Nashik", async () => {
    const h = setup({
      parse: {
        rows: [row({ op: "edit", ref: "pc1", field: "preferred_cities", value: "Nashik" })],
        unsupported: [],
      },
      preferenceValues: { preferred_cities: ["Pune"] },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);

    expect(turn.edit_proposal?.rows.map(({ row_id: _id, ...rest }) => rest)).toEqual([
      {
        section_label: "Pasand",
        field_label: "Kahan kaam karna chahte hain",
        op: "delete",
        before: "Pune",
        after: null,
        before_display: null,
        after_display: null,
      },
      {
        section_label: "Pasand",
        field_label: "Kahan kaam karna chahte hain",
        op: "add",
        before: null,
        after: "Nashik",
        before_display: null,
        after_display: null,
      },
    ]);
  });

  it("an ambiguous list edit cards nothing and is not counted as a placeholder", async () => {
    const h = setup({
      parse: {
        rows: [row({ op: "edit", ref: "pc9", field: "preferred_cities", value: "Nashik" })],
        unsupported: [],
      },
      preferenceValues: { preferred_cities: ["Pune"] },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(h.proposals.save).not.toHaveBeenCalled();
  });
});
