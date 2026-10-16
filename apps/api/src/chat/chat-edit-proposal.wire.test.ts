/**
 * ADR-0057 R10 (#2312) — the profiling chat's `edit_proposal` on the wire.
 *
 * ABSENT, never null, unless a change is being put to the worker — so every flag-off response is
 * byte-identical — and in EXACTLY the shape the app parses (#2314, shipped in #2322):
 * `{proposal_id, rows: [{field_label, op, before, after, warning?}]}`. The app draws no tile for a
 * row it cannot draw honestly (an edit with no `after`, a removal with no `before`); this file pins
 * the server side of that contract.
 */
import { describe, expect, it } from "vitest";

import { PostMessageResponseSchema } from "./chat.dto";

function legacyBody(over: Record<string, unknown> = {}) {
  return {
    session_id: "11111111-1111-4111-8111-111111111111",
    reply: "Experience: 5 saal se 2 saal kar doon?",
    blocked: false,
    is_mock: false,
    ...over,
  };
}

const PROPOSAL = {
  proposal_id: "66666666-6666-4666-8666-666666666666",
  rows: [
    { field_label: "Experience", op: "edit", before: "5 saal", after: "2 saal" },
    {
      field_label: "Koi training ki hai",
      op: "delete",
      before: "CNC Basics",
      after: null,
      warning: "Ye wapas nahi aayega.",
    },
  ],
};

describe("chat wire — edit_proposal", () => {
  it("is ABSENT on a body that does not set it, and null is refused", () => {
    const parsed = PostMessageResponseSchema.parse(legacyBody());
    expect(Object.prototype.hasOwnProperty.call(parsed, "edit_proposal")).toBe(false);
    expect(() => PostMessageResponseSchema.parse(legacyBody({ edit_proposal: null }))).toThrow();
  });

  it("carries the app's shape: a change, and a removal with its warning", () => {
    expect(PostMessageResponseSchema.parse(legacyBody({ edit_proposal: PROPOSAL })).edit_proposal).toEqual(
      PROPOSAL,
    );
  });

  it("refuses an op the app does not draw, an empty card, and a proposal with no id", () => {
    const bad = (proposal: unknown) =>
      PostMessageResponseSchema.safeParse(legacyBody({ edit_proposal: proposal })).success;
    expect(bad({ ...PROPOSAL, rows: [{ ...PROPOSAL.rows[0], op: "add" }] })).toBe(false);
    expect(bad({ ...PROPOSAL, rows: [] })).toBe(false);
    expect(bad({ rows: PROPOSAL.rows })).toBe(false);
  });
});
