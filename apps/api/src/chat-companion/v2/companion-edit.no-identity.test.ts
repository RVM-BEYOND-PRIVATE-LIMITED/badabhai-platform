import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { V2_EDIT_IDENTITY, V2_EDIT_NONE } from "../companion-replies";
import { profileRow, setup, WORKER_ID } from "./companion-edit.fake";

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;
const LANGUAGE_HINDI = { language: "hindi", can_speak: true, can_read: true, can_write: false };

/**
 * ADR-0046 O3 — identity and contact are OUT of the edit scope. A request for any of them must
 * never produce a row (the catalogue has no such section/field by construction), and the worker
 * is pointed at the Profile screen. The model is untrusted, so this is enforced even when the
 * classifier's `unsupported` list is empty and the model tries a row anyway.
 */
describe("CompanionEditService — identity and contact can never become a row", () => {
  it.each([
    ["a name edit", { op: "edit", section: "identity", ref: "x", field: "name", value: "Ramesh Kumar" }],
    ["a phone edit", { op: "edit", section: "contact", ref: "x", field: "phone", value: "9876543210" }],
    ["an ID-document add", { op: "add", section: "identity", ref: null, field: "aadhaar", value: "1234 5678 9012" }],
    ["a smuggled row with no unsupported hint", { op: "add", section: "identity", ref: null, field: "name", value: "Ramesh" }],
  ])("drops %s and serves the identity line", async (_what, modelRow) => {
    const h = setup({ parse: { rows: [modelRow], unsupported: [] }, languageEntries: [LANGUAGE_HINDI] });
    const turn = await h.service.propose(WORKER_ID, profileRow(), "mera naam badlo", CTX);

    // The model said "identity" (or said nothing): either way, no row exists and the worker is
    // steered to the Profile screen.
    expect(turn.reply).toBe(V2_EDIT_IDENTITY.latin);
    expect(turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("the explicit `unsupported` hint alone is enough — even with no rows at all", async () => {
    const h = setup({ parse: { rows: [], unsupported: ["identity"] } });
    const turn = await h.service.propose(WORKER_ID, profileRow(), "phone badlo", CTX);
    expect(turn.reply).toBe(V2_EDIT_IDENTITY.latin);
  });

  it("a phone number typed as a SKILL is dropped too — a chip is not a contact field", async () => {
    const h = setup({
      parse: {
        rows: [{ op: "add", section: "skills", ref: null, field: "skill", value: "9876543210" }],
        unsupported: [],
      },
    });
    const turn = await h.service.propose(WORKER_ID, profileRow(), "yeh skill jodo", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(turn.edit_proposal).toBeUndefined();
  });

  it("a request that is merely unclear still gets the clarify line, not the identity one", async () => {
    const h = setup({ parse: { rows: [], unsupported: ["other"] } });
    const turn = await h.service.propose(WORKER_ID, profileRow(), "kuch samajh nahi aaya", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
  });
});
