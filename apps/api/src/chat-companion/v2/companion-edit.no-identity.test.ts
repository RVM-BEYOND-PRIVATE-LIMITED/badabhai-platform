import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { V2_EDIT_IDENTITY, V2_EDIT_NONE, V2_EDIT_PLACEHOLDER } from "../companion-replies";
import { profileRow, setup, WORKER_ID } from "./companion-edit.fake";

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;
const LANGUAGE_HINDI = { language: "hindi", can_speak: true, can_read: true, can_write: false };

/**
 * ADR-0046 O3 — identity and contact are OUT of the edit scope. A request for any of them must
 * never produce a row (the catalogue has no such section/field by construction), and the worker
 * is pointed at the Profile screen. The model is untrusted, so this is enforced even when the
 * model's `unsupported` list is empty.
 *
 * On real traffic the AI service already drops a row aimed outside the six sections, so the
 * smuggled-row cases below are belt and braces; what serves the identity line when the model
 * forgets its hint is the deterministic reading of the message (BUG-IDENTITY-UNSUPPORTED) — see
 * "the worker's own words" below, which feeds exactly what the AI service returns: no rows.
 */
describe("CompanionEditService — identity and contact can never become a row", () => {
  it.each([
    ["a name edit", { op: "edit", section: "identity", ref: "x", field: "name", value: "Ramesh Kumar" }],
    ["a phone edit", { op: "edit", section: "contact", ref: "x", field: "phone", value: "9876543210" }],
    ["an ID-document add", { op: "add", section: "identity", ref: null, field: "aadhaar", value: "1234 5678 9012" }],
    ["a smuggled row with no unsupported hint", { op: "add", section: "identity", ref: null, field: "name", value: "Ramesh" }],
  ])("drops %s and serves the identity line", async (_what, modelRow) => {
    const h = setup({ parse: { rows: [modelRow], unsupported: [] }, languageEntries: [LANGUAGE_HINDI] });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "mera naam badlo", CTX);

    // The model said "identity" (or said nothing): either way, no row exists and the worker is
    // steered to the Profile screen.
    expect(turn.reply).toBe(V2_EDIT_IDENTITY.latin);
    expect(turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("the explicit `unsupported` hint alone is enough — even with no rows at all", async () => {
    const h = setup({ parse: { rows: [], unsupported: ["identity"] } });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "phone badlo", CTX);
    expect(turn.reply).toBe(V2_EDIT_IDENTITY.latin);
  });

  it("a phone number typed as a SKILL is dropped too — a chip is not a contact field", async () => {
    const h = setup({
      parse: {
        rows: [{ op: "add", section: "skills", ref: null, field: "skill", value: "9876543210" }],
        unsupported: [],
      },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "yeh skill jodo", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(turn.edit_proposal).toBeUndefined();
  });

  it("an out-of-scope (`other`) ask gets the Profile-screen line, not the identity one", async () => {
    // `other` is "asked, but not editable here" (contracts §2.2), so since 2026-10-01 it is told
    // so (V2_EDIT_PLACEHOLDER) rather than asked to rephrase. A message with NO hint at all still
    // gets the clarify line — "the worker's own words" below.
    const h = setup({ parse: { rows: [], unsupported: ["other"] } });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch samajh nahi aaya", CTX);
    expect(turn.reply).toBe(V2_EDIT_PLACEHOLDER.latin);
    expect(turn.reply).not.toBe(V2_EDIT_IDENTITY.latin);
  });
});

describe("the worker's own words serve the identity line when the model forgets the hint", () => {
  it.each([
    "Mera naam badlo",
    "mera naam [PERSON_1] karo",
    "phone number update karna hai",
    "aadhaar number badal do",
    "मेरा नाम बदलो",
  ])("%j with no rows and no hint → V2_EDIT_IDENTITY, no card", async (text) => {
    // Exactly what the AI service returns for these today: `{"rows": [], "unsupported": []}`.
    const h = setup({ parse: { rows: [], unsupported: [] } });
    const result = await h.service.propose(WORKER_ID, profileRow(), text, CTX);
    expect(result.turn.reply).toBe(V2_EDIT_IDENTITY.latin);
    expect(result.outcome).toBe("served");
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("works with the AI service down too — the check needs no model", async () => {
    const h = setup({ parse: null });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "mera phone number badlo", CTX);
    expect(turn.reply).toBe(V2_EDIT_IDENTITY.latin);
  });

  it.each(["company ka naam badlo", "certificate ka naam galat hai", "aadhaar card ready hai"])(
    "%j is not the worker's identity: the clarify line",
    async (text) => {
      const h = setup({ parse: { rows: [], unsupported: [] } });
      const { turn } = await h.service.propose(WORKER_ID, profileRow(), text, CTX);
      expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    },
  );

  it("a card is always the better answer — the check is never consulted when a row survives", async () => {
    const h = setup({
      parse: {
        rows: [{ op: "add", section: "skills", ref: null, field: "skill", value: "TIG welding" }],
        unsupported: [],
      },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "mera naam badlo aur TIG welding jodo", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
  });
});
