import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { CompanionEditParseInputSchema } from "@badabhai/ai-contracts";
import { EDIT_CARD_ROWS_MAX, ConfirmEditSchema, EditProposalRowSchema } from "../chat-companion.dto";
import { EDIT_PARSE_MAX_ROWS_MAX, EDIT_PARSE_SNAPSHOT_MAX } from "./companion-edit.service";

/**
 * The API's restated edit-parse bounds agree with the CONTRACT (CON-2.2b / BUG-SNAPSHOT-CAP).
 *
 * `packages/ai-contracts` keeps its caps private, so the API restates them; this suite pins each
 * one by the schema's own behaviour. If the contract moves, this fails — not a worker's edit,
 * which would otherwise 422 on the far side and read as "samajh nahi aaya" forever.
 */
function body(snapshotRows: number, maxRows: number) {
  return {
    text: "kuch badlo",
    catalogue: [],
    snapshot: Array.from({ length: snapshotRows }, (_, i) => ({
      ref: `s${i + 1}`,
      section: "skills",
      fields: { skill: `Skill ${i + 1}` },
    })),
    max_rows: maxRows,
  };
}

describe("the edit-parse bounds the API restates", () => {
  it("EDIT_PARSE_SNAPSHOT_MAX is exactly the contract's snapshot cap", () => {
    expect(CompanionEditParseInputSchema.safeParse(body(EDIT_PARSE_SNAPSHOT_MAX, 3)).success).toBe(true);
    expect(CompanionEditParseInputSchema.safeParse(body(EDIT_PARSE_SNAPSHOT_MAX + 1, 3)).success).toBe(false);
  });

  it("EDIT_PARSE_MAX_ROWS_MAX is exactly the contract's max_rows cap", () => {
    expect(CompanionEditParseInputSchema.safeParse(body(1, EDIT_PARSE_MAX_ROWS_MAX)).success).toBe(true);
    expect(CompanionEditParseInputSchema.safeParse(body(1, EDIT_PARSE_MAX_ROWS_MAX + 1)).success).toBe(false);
  });

  it("the row's labels are ADDITIVE: a row without them still parses, an undeclared key does not", () => {
    // BUG-CARD-LABELS. The shipped app reads `before`/`after` and ignores unknown keys; the
    // outbound schema must accept the old shape and the new one, and still reject a stray key.
    const base = {
      row_id: "44444444-4444-4444-8444-444444444444",
      section_label: "Pasand",
      op: "edit",
      before: "false",
      after: "true",
    };
    expect(EditProposalRowSchema.safeParse(base).success).toBe(true);
    expect(
      EditProposalRowSchema.safeParse({
        ...base,
        field_label: "Travel kar sakte hain",
        before_display: "Nahi",
        after_display: "Haan",
      }).success,
    ).toBe(true);
    expect(
      EditProposalRowSchema.safeParse({ ...base, field_label: "Shift", before_display: null, after_display: null })
        .success,
    ).toBe(true);
    expect(EditProposalRowSchema.safeParse({ ...base, field: "willing_to_travel" }).success).toBe(false);
    expect(EditProposalRowSchema.safeParse({ ...base, field_label: "" }).success).toBe(false);
  });

  it("a card never carries more rows than one confirm may tick", () => {
    const rowIds = (n: number) =>
      Array.from({ length: n }, (_, i) => `44444444-4444-4444-8444-44444444444${i}`);
    expect(ConfirmEditSchema.safeParse({ row_ids: rowIds(EDIT_CARD_ROWS_MAX) }).success).toBe(true);
    expect(ConfirmEditSchema.safeParse({ row_ids: rowIds(EDIT_CARD_ROWS_MAX + 1) }).success).toBe(false);
    expect(EDIT_CARD_ROWS_MAX).toBeLessThanOrEqual(EDIT_PARSE_MAX_ROWS_MAX);
  });
});
