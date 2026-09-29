import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { V2_EDIT_CARD_INTRO, V2_EDIT_IDENTITY, V2_EDIT_NONE, V2_EDIT_UNAVAILABLE } from "../companion-replies";
import { profileRow, setup, WORKER_ID } from "./companion-edit.fake";

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;

/** A model row, as `companionEditParse` would return it. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { op: "delete", section: "languages", ref: "l1", field: "language", value: null, ...over };
}

function parse(rows: Record<string, unknown>[], unsupported: string[] = []) {
  return { rows, unsupported };
}

const LANGUAGE_HINDI = { language: "hindi", can_speak: true, can_read: true, can_write: false };

describe("CompanionEditService.propose — every drop rule (spec §Edit step 3)", () => {
  it("keeps a legal delete: card, stored proposal, edit_proposed event", async () => {
    const h = setup({ parse: parse([row()]), languageEntries: [LANGUAGE_HINDI] });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "Hindi hata do", CTX);

    expect(turn.reply).toBe(V2_EDIT_CARD_INTRO.latin);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Bhasha",
      op: "delete",
      before: "hindi",
      after: null,
    });
    expect(h.proposals.save).toHaveBeenCalledTimes(1);
    const saved = h.proposals.save.mock.calls[0]![1] as { rows: unknown[] };
    expect(saved.rows).toHaveLength(1);
    const emitted = h.events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(emitted).toContain("chat.companion_edit_proposed");
  });

  it("sends the catalogue, the snapshot and max_rows to the AI service", async () => {
    const h = setup({ parse: parse([]), languageEntries: [LANGUAGE_HINDI] });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);

    const input = h.ai.companionEditParse.mock.calls[0]![0] as {
      catalogue: { section: string; field: string }[];
      snapshot: { ref: string; fields: Record<string, string | null> }[];
      max_rows: number;
    };
    expect(input.max_rows).toBe(3);
    expect(input.catalogue.some((f) => f.section === "skills" && f.field === "skill")).toBe(true);
    expect(input.catalogue.some((f) => f.section === "preferences" && f.field === "expected_salary")).toBe(true);
    // The snapshot carries refs, never DB ids: the employment_id never leaves the server.
    const languages = input.snapshot.find((s) => s.ref === "l1");
    expect(languages?.fields).toEqual({ language: "hindi" });
  });

  it.each([
    ["an unknown field", row({ section: "employment", field: "salary", ref: "e1" })],
    ["an op the catalogue forbids", row({ op: "add", section: "employment", ref: null, field: "employer_name", value: "Tata" })],
    ["edit/delete with an unknown ref", row({ ref: "nope" })],
    ["add carrying a ref", row({ op: "add", section: "skills", ref: "s1", field: "skill", value: "welding" })],
    ["edit without a value", row({ op: "edit", section: "preferences", ref: "pref", field: "shift", value: null })],
    ["a value the field refuses", row({ op: "edit", section: "preferences", ref: "pref", field: "shift", value: "evening" })],
    ["a placeholder-token value (O17)", row({ op: "add", section: "skills", ref: null, field: "skill", value: "[EMPLOYER_1] ki welding" })],
  ])("drops %s", async (_what, modelRow) => {
    const h = setup({ parse: parse([modelRow]), languageEntries: [LANGUAGE_HINDI] });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("drops a no-op — an edit whose value already equals the current one", async () => {
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "preferences", ref: "pref", field: "shift", value: "day" }),
      ]),
      preferenceValues: { shift: "day" },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "shift day hi rakho", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("keeps the good rows and drops the bad ones — one card, dropped_count counted", async () => {
    const h = setup({
      parse: parse([
        row({ op: "add", section: "skills", ref: null, field: "skill", value: "welding" }),
        row({ section: "identity", field: "name", ref: null }),
        row(),
      ]),
      languageEntries: [LANGUAGE_HINDI],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "welding jodo aur Hindi hatao", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(2);
    const saved = h.proposals.save.mock.calls[0]![1] as { rows: unknown[] };
    expect(saved.rows).toHaveLength(2);
    const proposed = h.events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "chat.companion_edit_proposed",
    )![0] as { payload: { dropped_count: number; row_count: number } };
    expect(proposed.payload.dropped_count).toBe(1);
    expect(proposed.payload.row_count).toBe(2);
  });

  it("an identity/contact ask is steered to the Profile screen, with no card", async () => {
    const h = setup({ parse: parse([], ["identity"]) });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "mera naam badlo", CTX);
    expect(turn.reply).toBe(V2_EDIT_IDENTITY.latin);
    expect(turn.edit_proposal).toBeUndefined();
  });

  it("a model failure (null) is the clarify line — never an error", async () => {
    const h = setup({ parse: null });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
  });

  it("a proposal-store refusal offers NO card and claims nothing (contracts §7)", async () => {
    const h = setup({ parse: parse([row()]), languageEntries: [LANGUAGE_HINDI], storeSave: false });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "Hindi hata do", CTX);
    expect(turn.reply).toBe(V2_EDIT_UNAVAILABLE.latin);
    expect(turn.edit_proposal).toBeUndefined();
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});
