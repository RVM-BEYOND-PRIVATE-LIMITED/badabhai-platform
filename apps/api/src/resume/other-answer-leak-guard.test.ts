import { describe, expect, it } from "vitest";

import { containsOtherAnswerMarker } from "./other-answer-leak-guard";

/**
 * `containsOtherAnswerMarker` is the LAST-LINE guard wired into
 * `ResumeDisclosureService.renderAndDisclose` right before the payer-facing render — see that
 * file's "LAST-LINE GUARD" comment. This is the "most important test in this whole task": an
 * unreviewed `worker_pack_answer.answer_other_text` must never cross to a payer.
 */
describe("containsOtherAnswerMarker", () => {
  it("is false for an ordinary trade-sheet-shaped payload", () => {
    const tradeSheet = {
      packId: "qp_cnc_turning",
      attributes: { turning_experience: "3-7 years", forklift: true },
      employments: [{ employer: "Acme Tooling", city: "Pune", roles: [{ workDone: "Turning" }] }],
      currentCity: "Pune",
      currentState: "Maharashtra",
    };
    expect(containsOtherAnswerMarker(tradeSheet)).toBe(false);
  });

  it("is false for null, undefined and primitive leaves", () => {
    expect(containsOtherAnswerMarker(null)).toBe(false);
    expect(containsOtherAnswerMarker(undefined)).toBe(false);
    expect(containsOtherAnswerMarker("Kuch aur, Ramesh sir ke under kaam kiya")).toBe(false);
    expect(containsOtherAnswerMarker(42)).toBe(false);
  });

  it("catches the marker at the top level", () => {
    expect(containsOtherAnswerMarker({ kind: "other_answer", text: "raw worker words" })).toBe(
      true,
    );
  });

  // ═══ THE MUTATION PROOF ═══
  // A defect that routes an unreviewed "other" answer onto the trade sheet looks exactly like
  // this: someone adds a field carrying the raw marker (or its polished derivative reached
  // through the same shape by a careless caller) somewhere inside the object tree the renderer
  // reads. The guard must catch it no matter how deep it is nested or which sibling fields exist
  // alongside it — proving it is not merely checking the top level.
  it("catches the marker nested inside attributes, arrays, and mixed siblings (the leak shape)", () => {
    const leaked = {
      packId: "qp_cnc_turning",
      attributes: {
        turning_experience: "3-7 years",
        // THE MUTATION: an other-answer marker landed in the attributes bag exactly as it
        // would if a future `collectAttribute`/`loadTradeSheet` change stopped refusing it.
        machine_note: { kind: "other_answer", text: "ek purana Batliboi lathe" },
      },
      employments: [
        { employer: "Acme Tooling", roles: [{ workDone: "Turning" }] },
        { employer: "Beta Forge", roles: [{ workDone: { kind: "other_answer", text: "leak" } }] },
      ],
    };
    expect(containsOtherAnswerMarker(leaked)).toBe(true);
  });

  it("does not false-positive on a string that merely CONTAINS the word 'other_answer'", () => {
    expect(containsOtherAnswerMarker({ note: "his kind of other_answer machine work" })).toBe(
      false,
    );
  });

  it("ADR-0045: a general-road context never trips it — the brief row and the marker are not the shape", () => {
    // The disclosure merges the road marker in BEFORE this guard runs, over the pack-less rows the
    // general form wrote. Neither `{status, text}` nor `{ownBriefUsable}` is `{kind, text}`, so an
    // answered brief, a decline and the marker all pass — while the real shape still fails closed.
    for (const profile_brief of [
      { status: "answered", text: "Ghar aur dukaan ki wiring karta hoon." },
      { status: "declined" },
    ]) {
      const road = {
        packId: null,
        attributes: { profile_brief, has_work_history: true, work_types: ["contract"] },
        generalRoad: { ownBriefUsable: true },
      };
      expect(containsOtherAnswerMarker(road)).toBe(false);
    }
    expect(
      containsOtherAnswerMarker({
        packId: null,
        attributes: { profile_brief: { kind: "other_answer", text: "leak" } },
        generalRoad: { ownBriefUsable: true },
      }),
    ).toBe(true);
  });
});
