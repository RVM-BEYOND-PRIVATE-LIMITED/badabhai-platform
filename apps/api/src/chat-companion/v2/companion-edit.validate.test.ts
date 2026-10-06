import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { CompanionEditParseInputSchema } from "@badabhai/ai-contracts";
import { CompanionTurnSchema } from "../chat-companion.dto";
import {
  V2_EDIT_CARD_INTRO,
  V2_EDIT_IDENTITY,
  V2_EDIT_NONE,
  V2_EDIT_PLACEHOLDER,
  V2_EDIT_UNAVAILABLE,
} from "../companion-replies";
import { profileRow, setup, storedProposal, WORKER_ID } from "./companion-edit.fake";

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
      field_label: "Bhasha",
      op: "delete",
      before: "hindi",
      after: null,
      before_display: "Hindi",
      after_display: null,
    });
    expect(h.proposals.save).toHaveBeenCalledTimes(1);
    const saved = h.proposals.save.mock.calls[0]![1] as { rows: unknown[] };
    expect(saved.rows).toHaveLength(1);
    const emitted = h.events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(emitted).toContain("chat.companion_edit_proposed");
  });

  it("records the edit-parse spend against companion_edit_parse (ADR-0046 O12)", async () => {
    // The spend is recorded before any branch can return, and `record` no-ops on a null meta —
    // the fake returns no metadata, so the call itself is what this pins (same rule as the
    // orchestrator's classify emitter).
    const h = setup({ parse: parse([]), languageEntries: [LANGUAGE_HINDI] });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(h.cost.record).toHaveBeenCalledWith(
      null,
      "companion_edit_parse",
      null,
      "c-1",
      "r-1",
      { workerId: WORKER_ID },
    );
  });

  it("whole-entry deletes — a job or a qualification — are never carded ('Never from chat')", async () => {
    // Employment since the owner ruling of 2026-10-01; qualifications since TD151(1)'s provisional
    // default of 2026-10-05, which mirrors it. Both are dropped before the catalogue gate, and a
    // member-level delete on the card beside them survives.
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "employment", ref: "e1", field: "employer_name", value: null }),
        row({ op: "delete", section: "qualifications", ref: "c1", field: "certificate_name", value: null }),
        row({ op: "delete", section: "languages", ref: "l1", field: "language", value: null }),
      ]),
      employmentViews: [
        {
          employment_id: "66666666-6666-4666-8666-666666666666",
          employer_name: "Tata Motors",
          employer_city: "Pune",
          employer_state: null,
          start_ym: "2019-01",
          end_ym: null,
          roles: [],
        },
      ],
      qualificationLists: {
        certificates: [{ name: "ITI Machinist", issuer: "NCVT", year: 2018, licence_number: null, licence_expiry: null }],
      },
      languageEntries: [LANGUAGE_HINDI],
    });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "purana kaam hata do", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Bhasha",
      field_label: "Bhasha",
      op: "delete",
    });
    expect(savedRows(h).map((r) => r.op)).toEqual(["delete"]);
    expect(proposedPayload(h)).toMatchObject({ row_count: 1, dropped_count: 2 });
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
    // An EDIT: the row helper defaults to `delete`, and an employment delete is the `job_delete`
    // drop (its own line, below) before the catalogue is ever consulted.
    ["an unknown field", row({ op: "edit", section: "employment", field: "salary", ref: "e1", value: "15000" })],
    ["an op the catalogue forbids", row({ op: "add", section: "employment", ref: null, field: "employer_name", value: "Tata" })],
    ["edit/delete with an unknown ref", row({ ref: "nope" })],
    ["add carrying a ref", row({ op: "add", section: "skills", ref: "s1", field: "skill", value: "welding" })],
    ["edit without a value", row({ op: "edit", section: "preferences", ref: "pref", field: "shift", value: null })],
    ["a value the field refuses", row({ op: "edit", section: "preferences", ref: "pref", field: "shift", value: "evening" })],
  ])("drops %s", async (_what, modelRow) => {
    const h = setup({ parse: parse([modelRow]), languageEntries: [LANGUAGE_HINDI] });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  // ADR-0047 G1. With AI_RAW_PII_ENABLED on the model reads the worker's raw message and no
  // placeholder is minted, so an echoed identifier arrives as plain text; a confirmed employer
  // name or work line prints on both résumé PDFs. The clean edit in each case is the control.
  describe("a value carrying a hard identifier (ADR-0047 G1)", () => {
    // ONE ROLE, on purpose: every row is also parsed through the employment writer's real schema
    // (P1-EDIT-DROP-DTO), which refuses an employment with no role — so with `roles: []` each
    // row below would be dropped by the writer, never reaching the gate this block is about.
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
    const edit = (field: string, value: string) =>
      row({ op: "edit", section: "employment", ref: "e1", field, value });

    it.each([
      ["a phone in employer_name", "employer_name", "Tata Motors, call 98765 43210"],
      ["a PAN in work_done", "work_done", "PAN ABCDE1234F, lathe pe shaft"],
      ["an email in role_label", "role_label", "ramesh.k@example.com"],
    ])("drops %s", async (_what, field, value) => {
      const h = setup({ parse: parse([edit(field, value)]), employmentViews: [TATA] });
      const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
      expect(turn.reply).toBe(V2_EDIT_NONE.latin);
      expect(turn.edit_proposal).toBeUndefined();
      expect(h.proposals.save).not.toHaveBeenCalled();
    });

    it.each([
      ["employer_name", "Tata Motors Ltd"],
      ["work_done", "lathe pe shaft"],
      ["role_label", "Senior Welder"],
    ])("control: a clean %s edit on the same entry IS carded", async (field, value) => {
      const h = setup({ parse: parse([edit(field, value)]), employmentViews: [TATA] });
      const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
      expect(turn.edit_proposal?.rows).toHaveLength(1);
      expect(turn.edit_proposal?.rows[0]?.after).toBe(value);
    });

    it("keeps the clean edit beside it — one card, the echo counted as dropped", async () => {
      const h = setup({
        parse: parse([
          edit("employer_name", "Tata Motors Ltd"),
          edit("work_done", "call 98765 43210"),
        ]),
        employmentViews: [TATA],
      });
      const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
      expect(turn.edit_proposal?.rows).toHaveLength(1);
      expect(turn.edit_proposal?.rows[0]?.after).toBe("Tata Motors Ltd");
      expect(JSON.stringify(h.proposals.save.mock.calls)).not.toContain("98765");
      const proposed = h.events.emit.mock.calls.find(
        (c) => (c[0] as { event_name: string }).event_name === "chat.companion_edit_proposed",
      )![0] as { payload: { dropped_count: number } };
      expect(proposed.payload.dropped_count).toBe(1);
    });
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

  it("a new proposal SUPERSEDES the worker's open card and records it (TD150/WP8)", async () => {
    const previous = storedProposal();
    const h = setup({
      parse: parse([row()]),
      languageEntries: [LANGUAGE_HINDI],
      proposal: previous,
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "Hindi hata do", CTX);
    expect(turn.edit_proposal).toBeDefined();

    const cancelled = h.events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: { proposal_id: string; reason: string } })
      .find((e) => e.event_name === "chat.companion_edit_cancelled_v2");
    expect(cancelled?.payload).toEqual({
      proposal_id: previous.proposal_id,
      reason: "superseded",
    });
  });

  it("a proposal-store refusal offers NO card and claims nothing (contracts §7)", async () => {
    const h = setup({ parse: parse([row()]), languageEntries: [LANGUAGE_HINDI], storeSave: false });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "Hindi hata do", CTX);
    expect(turn.reply).toBe(V2_EDIT_UNAVAILABLE.latin);
    expect(turn.edit_proposal).toBeUndefined();
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});

/** The card rows `propose` stored, as the confirm route will see them. */
function savedRows(h: ReturnType<typeof setup>): { op: string; field: string; value: string | null }[] {
  return (h.proposals.save.mock.calls[0]![1] as { rows: { op: string; field: string; value: string | null }[] })
    .rows;
}

function proposedPayload(h: ReturnType<typeof setup>): { dropped_count: number; row_count: number } {
  const call = h.events.emit.mock.calls.find(
    (c) => (c[0] as { event_name: string }).event_name === "chat.companion_edit_proposed",
  )!;
  return (call[0] as { payload: { dropped_count: number; row_count: number } }).payload;
}

const CERT_A = { name: "ITI Fitter", issuer: "NCVT", year: 2016, licence_number: null, licence_expiry: null };
const EMPLOYMENT = {
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

describe("O17 — a masked value points the worker at the Profile screen (P1-EDIT-DROP-O17)", () => {
  it("the only row carried a placeholder token: no card, the Profile-screen line, outcome served", async () => {
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "employment", ref: "e1", field: "employer_name", value: "[EMPLOYER_2]" }),
      ]),
      employmentViews: [EMPLOYMENT],
    });
    const result = await h.service.propose(WORKER_ID, profileRow(), "[EMPLOYER_1] ko [EMPLOYER_2] karo", CTX);
    expect(result.turn.reply).toBe(V2_EDIT_PLACEHOLDER.latin);
    expect(result.turn.tts_text).toBe(V2_EDIT_PLACEHOLDER.dev);
    expect(result.outcome).toBe("served");
    expect(result.turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("a masked row beside a good one: the card carries the good row only", async () => {
    const h = setup({
      parse: parse([
        row({ op: "add", section: "skills", ref: null, field: "skill", value: "[EMPLOYER_1] ki welding" }),
        row({ op: "add", section: "skills", ref: null, field: "skill", value: "TIG welding" }),
      ]),
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.reply).toBe(V2_EDIT_CARD_INTRO.latin);
    expect(turn.edit_proposal?.rows.map((r) => r.after)).toEqual(["TIG welding"]);
  });
});

describe("no-op adds are dropped before the card (P1-EDIT-NOOP)", () => {
  it.each([
    [
      "a language already stored",
      row({ op: "add", section: "languages", ref: null, field: "language", value: "Hindi" }),
      { languageEntries: [LANGUAGE_HINDI] },
    ],
    [
      "an occupation already stored",
      row({ op: "add", section: "occupations", ref: null, field: "role_id", value: "role_welder" }),
      { occupationEntries: [{ role_id: "role_welder", label: "Welder" }] },
    ],
    [
      "a city already preferred",
      row({ op: "add", section: "preferences", ref: null, field: "preferred_cities", value: "pune" }),
      { preferenceValues: { preferred_cities: ["Pune"] } },
    ],
    [
      "a document already ready",
      row({ op: "add", section: "preferences", ref: null, field: "documents_ready", value: "aadhaar" }),
      { preferenceValues: { documents_ready: ["aadhaar"] } },
    ],
    [
      "a skill already printed, in another case",
      row({ op: "add", section: "skills", ref: null, field: "skill", value: "mig WELDING" }),
      {},
    ],
  ])("drops %s: no card, no stored proposal", async (_what, modelRow, state) => {
    const h = setup({ parse: parse([modelRow]), ...state });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "add karo", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });
});

describe("one card row per change (P1-EDIT-NOOP, contracts-privacy BUG-2)", () => {
  it("the same add twice is one row", async () => {
    const h = setup({
      parse: parse([
        row({ op: "add", section: "skills", ref: null, field: "skill", value: "TIG welding" }),
        row({ op: "add", section: "skills", ref: null, field: "skill", value: "tig welding" }),
      ]),
    });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(savedRows(h)).toHaveLength(1);
    expect(proposedPayload(h).dropped_count).toBe(1);
  });

  it("two deletes of ONE member (different anchor fields) are one delete", async () => {
    // A member delete names its ROW; the field is only its anchor (skills and languages are
    // one-field rows, so the same entry can only be reached through that field).
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "preferences", ref: "pc1", field: "preferred_cities", value: null }),
        row({ op: "delete", section: "preferences", ref: "pc1", field: "preferred_cities", value: null }),
      ]),
      preferenceValues: { preferred_cities: ["Pune", "Mumbai"] },
    });
    await h.service.propose(WORKER_ID, profileRow(), "Pune hata do", CTX);
    expect(savedRows(h)).toHaveLength(1);
  });

  it("a second language delete of the same entry is dropped", async () => {
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "languages", ref: "l1", field: "language", value: null }),
        row({ op: "delete", section: "languages", ref: "l1", field: "language", value: null }),
      ]),
      languageEntries: [LANGUAGE_HINDI],
    });
    await h.service.propose(WORKER_ID, profileRow(), "Hindi hata do", CTX);
    expect(savedRows(h).map((r) => r.op)).toEqual(["delete"]);
  });

  it("two edits of one field keep the first", async () => {
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "preferences", ref: "pref", field: "shift", value: "night" }),
        row({ op: "edit", section: "preferences", ref: "pref", field: "shift", value: "day" }),
      ]),
    });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(savedRows(h).map((r) => r.value)).toEqual(["night"]);
  });
});

describe("the section writer's REAL schema drops a row before the card (P1-EDIT-DROP-DTO)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a phone number in a certificate issuer never reaches a card (the DTO's PII screen)", async () => {
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "qualifications", ref: "c1", field: "certificate_issuer", value: "NCVT 9876543210" }),
      ]),
      qualificationLists: { certificates: [CERT_A] },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "issuer badlo", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("an end month before the stored start month is dropped (the DTO's end >= start)", async () => {
    const h = setup({
      parse: parse([row({ op: "edit", section: "employment", ref: "e1", field: "end_ym", value: "2018-06" })]),
      employmentViews: [EMPLOYMENT],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "2018 mein chhoda", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("two rows that pass alone but not together keep only the first", async () => {
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "employment", ref: "e1", field: "start_ym", value: "2020-01" }),
        row({ op: "edit", section: "employment", ref: "e1", field: "end_ym", value: "2019-06" }),
      ]),
      employmentViews: [EMPLOYMENT],
    });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(savedRows(h).map((r) => r.field)).toEqual(["start_ym"]);
  });

  it("a fifth occupation is dropped (the DTO's cap of four)", async () => {
    const h = setup({
      parse: parse([row({ op: "add", section: "occupations", ref: null, field: "role_id", value: "role_plumber" })]),
      occupationEntries: [
        { role_id: "role_welder", label: "Welder" },
        { role_id: "role_carpenter", label: "Carpenter" },
        { role_id: "role_cnc_operator", label: "CNC Operator" },
        { role_id: "role_vmc_operator", label: "VMC Operator" },
      ],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "plumber bhi", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
  });

  it("the credential-year ceiling moves with the clock, never frozen at module load", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-03-01T00:00:00.000Z"));
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "qualifications", ref: "c1", field: "certificate_year", value: "2031" }),
      ]),
      qualificationLists: { certificates: [CERT_A] },
    });
    await h.service.propose(WORKER_ID, profileRow(), "is saal mila", CTX);
    expect(savedRows(h).map((r) => r.value)).toEqual(["2031"]);
  });
});

describe("every card row explains itself (BUG-CARD-LABELS, POLISH-language-slugs)", () => {
  it("three preference rows on one card are told apart by their field labels", async () => {
    // The audit's case: "Pasand: Nahi → Haan" could have been travel, relocation or a room.
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "preferences", ref: "pref", field: "willing_to_travel", value: "haan" }),
        row({ op: "edit", section: "preferences", ref: "pref", field: "accommodation_needed", value: "nahi" }),
        row({ op: "edit", section: "preferences", ref: "pref", field: "availability_status", value: "immediate" }),
      ]),
      preferenceValues: {
        willing_to_travel: false,
        accommodation_needed: true,
        availability: { status: "within_month", available_from: null, notice_period_days: null },
      },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);

    expect(CompanionTurnSchema.safeParse(turn).success).toBe(true);
    expect(turn.edit_proposal?.rows.map(({ row_id: _id, ...rest }) => rest)).toEqual([
      {
        section_label: "Pasand",
        field_label: "Travel kar sakte hain",
        op: "edit",
        before: "false",
        after: "true",
        before_display: "Nahi",
        after_display: "Haan",
      },
      {
        section_label: "Pasand",
        field_label: "Rehne ki jagah chahiye",
        op: "edit",
        before: "true",
        after: "false",
        before_display: "Haan",
        after_display: "Nahi",
      },
      {
        section_label: "Pasand",
        field_label: "Kab join kar sakte hain",
        op: "edit",
        before: "within_month",
        after: "immediate",
        before_display: "Within a month",
        after_display: "Immediately",
      },
    ]);
  });

  it("a free-text edit keeps before/after as typed and sends no display label", async () => {
    const h = setup({
      parse: parse([row({ op: "edit", section: "employment", ref: "e1", field: "end_ym", value: "2021-05" })]),
      employmentViews: [{ ...EMPLOYMENT, end_ym: "2021-03" }],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "2021 may tak kiya", CTX);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Kaam",
      field_label: "Kab tak kiya",
      before: "2021-03",
      after: "2021-05",
      before_display: null,
      after_display: null,
    });
  });

  it("a qualification EDIT names the FIELD, not the entry — no 'Yeh poora certificate' row exists any more", async () => {
    // TD151(1) (2026-10-05): a qualification whole-entry delete is no longer carded, so a
    // certificate row the worker can act on is an EDIT of one field and is labelled as that
    // field. The "Yeh poora certificate" label survives only for a card stored before the ruling.
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "qualifications", ref: "c1", field: "certificate_year", value: "2019" }),
      ]),
      qualificationLists: { certificates: [CERT_A] },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "certificate ka saal 2019 kar do", CTX);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Certificate aur padhai",
      field_label: "Certificate ka saal",
      op: "edit",
      before: "2016",
      after: "2019",
      before_display: null,
      after_display: null,
    });
  });

  it.each(["employer_name", "employer_city", "employer_state", "start_ym", "end_ym", "role_label", "work_done"])(
    "a whole-JOB delete anchored on %s is never carded — no 'Yeh poora kaam' row ('Never from chat')",
    async (field) => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const h = setup({
        parse: parse([row({ op: "delete", section: "employment", ref: "e1", field, value: null })]),
        employmentViews: [EMPLOYMENT],
      });
      const { turn } = await h.service.propose(WORKER_ID, profileRow(), "Tata wala kaam hatao", CTX);
      expect(turn.edit_proposal).toBeUndefined();
      expect(turn.reply).toBe(V2_EDIT_PLACEHOLDER.latin);
      expect(h.proposals.save).not.toHaveBeenCalled();
    },
  );

  it("an occupation add shows the role's taxonomy label beside its id", async () => {
    const h = setup({
      parse: parse([row({ op: "add", section: "occupations", ref: null, field: "role_id", value: "role_vmc_operator" })]),
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "VMC bhi jodo", CTX);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Aur kaam",
      field_label: "Role",
      op: "add",
      before: null,
      after: "role_vmc_operator",
      before_display: null,
      after_display: "VMC Operator",
    });
  });

  it("the labels ride the WIRE only — the stored card is unchanged", async () => {
    const h = setup({ parse: parse([row()]), languageEntries: [LANGUAGE_HINDI] });
    await h.service.propose(WORKER_ID, profileRow(), "Hindi hata do", CTX);
    const saved = h.proposals.save.mock.calls[0]![1] as { rows: Record<string, unknown>[] };
    expect(Object.keys(saved.rows[0]!).sort()).toEqual(
      ["before", "field", "op", "row_id", "section", "section_label", "target", "value"].sort(),
    );
  });
});

describe("the card's row cap is the API's own (CON-2.2b / BUG-MAXROWS)", () => {
  const FOUR_ADDS = ["TIG welding", "Gas cutting", "Grinding", "Fitting"].map((value) =>
    row({ op: "add", section: "skills", ref: null, field: "skill", value }),
  );

  it("four valid rows from the model make a card of three, the fourth counted as dropped", async () => {
    const h = setup({ parse: parse(FOUR_ADDS) });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(3);
    expect(savedRows(h)).toHaveLength(3);
    expect(proposedPayload(h)).toMatchObject({ row_count: 3, dropped_count: 1 });
  });

  it("a knob above what one confirm may tick still asks for, and cards, three at most", async () => {
    const h = setup({ parse: parse(FOUR_ADDS), maxRows: 10 });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect((h.ai.companionEditParse.mock.calls[0]![0] as { max_rows: number }).max_rows).toBe(3);
    expect(savedRows(h)).toHaveLength(3);
  });

  it("a knob below three is honoured on both ends", async () => {
    const h = setup({ parse: parse(FOUR_ADDS), maxRows: 2 });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect((h.ai.companionEditParse.mock.calls[0]![0] as { max_rows: number }).max_rows).toBe(2);
    expect(savedRows(h)).toHaveLength(2);
  });
});

describe("the snapshot fits the edit-parse contract (BUG-SNAPSHOT-CAP)", () => {
  const SKILLS = Array.from({ length: 70 }, (_, i) => `Skill number ${i + 1}`);
  const richProfile = () =>
    profileRow({
      rawProfile: { skills: [], skill_labels: SKILLS, machines: [], experiences: [], education: [], certifications: [] },
    } as never);

  it("a rich profile is cut to the contract's 64 rows — every small section kept, logged with a closed reason", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const h = setup({ parse: parse([]), languageEntries: [LANGUAGE_HINDI] });
    await h.service.propose(WORKER_ID, richProfile(), "kuch badlo", CTX);

    const input = h.ai.companionEditParse.mock.calls[0]![0] as { snapshot: { ref: string }[] };
    // The body the AI service will accept — a 65-row body is a 422 and a permanent clarify line.
    expect(CompanionEditParseInputSchema.safeParse(input).success).toBe(true);
    expect(input.snapshot).toHaveLength(64);
    const refs = input.snapshot.map((s) => s.ref);
    expect(refs).toContain("l1");
    expect(refs).toContain("pref");
    const lines = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("reason=snapshot_cap");
    expect(lines).not.toContain("Skill number");
    warn.mockRestore();
  });

  it("a row the message names is kept even when its position is past the family's share", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const h = setup({ parse: parse([]) });
    await h.service.propose(WORKER_ID, richProfile(), "skill number 70 hata do", CTX);
    const input = h.ai.companionEditParse.mock.calls[0]![0] as {
      snapshot: { ref: string; fields: Record<string, string | null> }[];
    };
    expect(input.snapshot.some((s) => s.fields["skill"] === "Skill number 70")).toBe(true);
  });

  it("a ref the model was never shown cannot be addressed", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const h = setup({
      parse: parse([row({ op: "delete", section: "skills", ref: "s70", field: "skill", value: null })]),
    });
    const { turn } = await h.service.propose(WORKER_ID, richProfile(), "kuch hatao", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
  });
});

describe("a row's field must belong to the entry its ref names (EDIT-ROW-KIND)", () => {
  // The model's output is untrusted. `q1` is an education and `certificate_name` is a
  // qualifications field, so a section check alone passed `q1 certificate_name` — and the apply,
  // which goes by the ref's list, would edit the education's field as though it were a
  // certificate's (the delete form of this rule is moot since TD151(1), 2026-10-05).
  const EDU = { credential: "iti", field: "Fitter", council: "ncvt", year: 2016, institute: "Govt ITI" };
  const TRAINING = { name: "CNC basics", provider: "NTTF", year: 2020 };

  it.each([
    ["a certificate field on an education", row({ op: "edit", section: "qualifications", ref: "q1", field: "certificate_name", value: "ITI Fitter" })],
    ["an education field on a certificate", row({ op: "edit", section: "qualifications", ref: "c1", field: "education_year", value: "2019" })],
    ["a training field on a certificate", row({ op: "edit", section: "qualifications", ref: "c1", field: "training_year", value: "2019" })],
    ["a scalar preference on a city member", row({ op: "edit", section: "preferences", ref: "pc1", field: "shift", value: "night" })],
    ["a list preference on the scalar row", row({ op: "delete", section: "preferences", ref: "pref", field: "preferred_cities", value: null })],
    ["one list's member deleted as another list's", row({ op: "delete", section: "preferences", ref: "pc1", field: "work_types", value: null })],
  ])("drops %s — no card, nothing stored", async (_what, modelRow) => {
    const h = setup({
      parse: parse([modelRow]),
      qualificationLists: { certificates: [CERT_A], educations: [EDU], trainings: [TRAINING] },
      preferenceValues: { shift: "day", preferred_cities: ["Pune"], work_types: ["full_time"] },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch hatao", CTX);
    expect(turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("the same entry anchored on its OWN field is carded", async () => {
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "qualifications", ref: "q1", field: "education_council", value: "scvt" }),
      ]),
      qualificationLists: { certificates: [CERT_A], educations: [EDU] },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "council SCVT hai", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Certificate aur padhai",
      field_label: "Council / board",
      op: "edit",
      before: "ncvt",
      after: "scvt",
    });
  });

  it("a mis-kinded row beside a good one: the card carries the good row only, dropped counted", async () => {
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "qualifications", ref: "q1", field: "certificate_name", value: "ITI" }),
        row({ op: "edit", section: "preferences", ref: "pref", field: "shift", value: "night" }),
      ]),
      qualificationLists: { educations: [EDU] },
      preferenceValues: { shift: "day" },
    });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(savedRows(h).map((r) => [r.op, r.field])).toEqual([["edit", "shift"]]);
    expect(proposedPayload(h)).toMatchObject({ row_count: 1, dropped_count: 1 });
  });
});

describe("'Never from chat' — chat never deletes a whole job (owner ruling, 2026-10-01); see the qualification twin below", () => {
  // The production primary model (gemini-2.5-flash-lite), measured 3/3: "welder hata do" (drop the
  // TRADE) came back as `delete employment e1`, because the snapshot shows "Welder" only as the
  // job's role_label. The card said "Kaam · Yeh poora kaam", pre-ticked, so one Haan would remove
  // the worker's whole job.
  const WELDER = { role_id: "role_welder", label: "Welder" };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    warn.mockClear();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const warnLines = (): string[] => warn.mock.calls.map((c) => String(c[0]));
  const emittedNames = (h: ReturnType<typeof setup>): string[] =>
    h.events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

  it("'welder hata do' read as a job delete: no card, the Profile-screen line, nothing saved", async () => {
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "employment", ref: "e1", field: "employer_name", value: null }),
      ]),
      employmentViews: [EMPLOYMENT],
      occupationEntries: [WELDER],
    });
    const result = await h.service.propose(WORKER_ID, profileRow(), "welder hata do", CTX);

    expect(result.turn.reply).toBe(V2_EDIT_PLACEHOLDER.latin);
    expect(result.turn.tts_text).toBe(V2_EDIT_PLACEHOLDER.dev);
    expect(result.outcome).toBe("served");
    expect(result.turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
    expect(emittedNames(h)).not.toContain("chat.companion_edit_proposed");
    expect(h.db.transaction).not.toHaveBeenCalled();

    // ONE counts-only line with the closed reason — the worker id, never a value.
    const lines = warnLines().filter((line) => line.includes("reason=job_delete_from_chat"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(WORKER_ID);
    expect(lines[0]).toContain("1 of 1 rows");
    for (const line of warnLines()) {
      expect(line).not.toContain("Tata");
      expect(line).not.toContain("Welder");
      expect(line).not.toContain("welder");
    }
  });

  it("'mujhe welder ka kaam nahi karna': the trade delete is carded, the job delete beside it is not", async () => {
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "employment", ref: "e1", field: "role_label", value: null }),
        row({ op: "delete", section: "occupations", ref: "o1", field: "role_id", value: null }),
      ]),
      employmentViews: [EMPLOYMENT],
      occupationEntries: [WELDER],
    });
    const { turn, outcome } = await h.service.propose(
      WORKER_ID,
      profileRow(),
      "mujhe welder ka kaam nahi karna",
      CTX,
    );

    expect(outcome).toBe("proposed");
    expect(turn.reply).toBe(V2_EDIT_CARD_INTRO.latin);
    expect(turn.edit_proposal?.rows.map(({ row_id: _id, ...rest }) => rest)).toEqual([
      {
        section_label: "Aur kaam",
        field_label: "Role",
        op: "delete",
        before: "role_welder",
        after: null,
        before_display: "Welder",
        after_display: null,
      },
    ]);
    expect(savedRows(h).map((r) => [r.op, r.field])).toEqual([["delete", "role_id"]]);
    expect(proposedPayload(h)).toMatchObject({ row_count: 1, dropped_count: 1 });
    expect(warnLines().filter((line) => line.includes("reason=job_delete_from_chat"))).toHaveLength(1);
  });

  it("an employment EDIT still works: 'Tata ki jagah Mahindra likho' is carded", async () => {
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "employment", ref: "e1", field: "employer_name", value: "Mahindra" }),
      ]),
      employmentViews: [EMPLOYMENT],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "Tata ki jagah Mahindra likho", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Kaam",
      field_label: "Kahan kaam kiya",
      op: "edit",
      before: "Tata Motors",
      after: "Mahindra",
    });
    expect(warnLines().some((line) => line.includes("reason=job_delete_from_chat"))).toBe(false);
  });

  it.each([
    ["purana employer hata do", "employer_name"],
    ["Tata wala kaam delete karo", "start_ym"],
  ])("%j: whatever the model proposes, the worker is pointed at the Profile screen", async (text, field) => {
    // The prompt now asks for NO row and `other` (the gold expects []); a model that still
    // proposes the job delete meets the API's own wall. Both serve the same line.
    const followed = setup({ parse: parse([], ["other"]), employmentViews: [EMPLOYMENT] });
    const ignored = setup({
      parse: parse([row({ op: "delete", section: "employment", ref: "e1", field, value: null })]),
      employmentViews: [EMPLOYMENT],
    });
    for (const h of [followed, ignored]) {
      const result = await h.service.propose(WORKER_ID, profileRow(), text, CTX);
      expect(result.turn.reply).toBe(V2_EDIT_PLACEHOLDER.latin);
      expect(result.outcome).toBe("served");
      expect(h.proposals.save).not.toHaveBeenCalled();
    }
  });

  it("no rows and unsupported ['other'] → the Profile-screen line, not 'samajh nahi aaya'", async () => {
    // contracts §2.2: `other` is "things asked that cannot be edited here" — rephrasing cannot help.
    const h = setup({ parse: parse([], ["other"]) });
    const result = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(result.turn.reply).toBe(V2_EDIT_PLACEHOLDER.latin);
    expect(result.outcome).toBe("served");
    expect(warnLines().some((line) => line.includes("reason=job_delete_from_chat"))).toBe(false);
  });

  it("no rows and nothing unsupported → still the clarify line (unchanged)", async () => {
    const h = setup({ parse: parse([]) });
    const result = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(result.turn.reply).toBe(V2_EDIT_NONE.latin);
    expect(result.outcome).toBe("clarify");
  });

  it("identity still wins: a job delete beside an identity ask gets the identity line", async () => {
    const h = setup({
      parse: parse(
        [row({ op: "delete", section: "employment", ref: "e1", field: "employer_name", value: null })],
        ["identity"],
      ),
      employmentViews: [EMPLOYMENT],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(turn.reply).toBe(V2_EDIT_IDENTITY.latin);
  });

  it("the AI service is offered no employment delete at all", async () => {
    const h = setup({ parse: parse([]) });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    const input = h.ai.companionEditParse.mock.calls[0]![0] as {
      catalogue: { section: string; field: string; ops: string[] }[];
    };
    const employment = input.catalogue.filter((f) => f.section === "employment");
    expect(employment).toHaveLength(7);
    for (const entry of employment) expect(entry.ops).toEqual(["edit"]);
  });
});

describe("qualification whole-entry deletes are Profile-only (TD151(1), 2026-10-05)", () => {
  // The 2026-10-01 "Never from chat" ruling covered jobs; TD151(1) extends it to the credentials
  // that kept the same shape ("Yeh poora certificate" on one Haan). The pins below are the three
  // the task names: "ITI hata do", "certificate hata do", and a trade word that appears only
  // inside a certificate (ITI Fitter / ITI Turner), which must never become a delete of the
  // certificate — or of anything else whole.
  const CERTIFICATES = [
    { name: "ITI Fitter", issuer: "NCVT", year: 2016, licence_number: null, licence_expiry: null },
    { name: "ITI Turner", issuer: "NCVT", year: 2018, licence_number: null, licence_expiry: null },
  ];
  const SAFETY_EDU = { credential: "10th", field: "Science", council: "CBSE", year: 2014, institute: null };
  const SAFETY_TRAINING = { name: "Safety", provider: "NIMI", year: 2021 };

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    warn.mockClear();
  });
  afterEach(() => warn.mockRestore());

  const warnLines = (): string[] => warn.mock.calls.map((c) => String(c[0]));

  it.each([
    ["ITI hata do", "c1", "certificate_name"],
    ["ITI Turner hata do", "c2", "certificate_name"],
    ["certificate hata do", "c1", "certificate_year"],
    ["padhai hata do", "q1", "education_field"],
    ["training hata do", "t1", "training_name"],
  ])(
    "%j read as a whole-entry delete: no card, the Profile-screen line, nothing saved",
    async (text, ref, field) => {
      const h = setup({
        parse: parse([row({ op: "delete", section: "qualifications", ref, field, value: null })]),
        qualificationLists: {
          certificates: CERTIFICATES,
          educations: [SAFETY_EDU],
          trainings: [SAFETY_TRAINING],
        },
      });
      const result = await h.service.propose(WORKER_ID, profileRow(), text, CTX);

      expect(result.turn.reply).toBe(V2_EDIT_PLACEHOLDER.latin);
      expect(result.turn.tts_text).toBe(V2_EDIT_PLACEHOLDER.dev);
      expect(result.outcome).toBe("served");
      expect(result.turn.edit_proposal).toBeUndefined();
      expect(h.proposals.save).not.toHaveBeenCalled();
      expect(h.db.transaction).not.toHaveBeenCalled();

      // ONE counts-only line, reason names the entry kind, never a value.
      const lines = warnLines().filter((line) => line.includes("reason=qualification_delete_from_chat"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(WORKER_ID);
      expect(lines[0]).toContain("1 of 1 rows");
      for (const line of warnLines()) {
        expect(line).not.toContain("ITI");
        expect(line).not.toContain("Turner");
        expect(line).not.toContain("Fitter");
      }
    },
  );

  it("a trade word inside a certificate beside a clean edit: only the edit is carded", async () => {
    // "welder" never names an occupations row here; the model reaches for the certificate that
    // mentions it. The delete is dropped and counted; the year edit beside it survives.
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "qualifications", ref: "c1", field: "certificate_name", value: null }),
        row({ op: "edit", section: "qualifications", ref: "c2", field: "certificate_year", value: "2019" }),
      ]),
      qualificationLists: { certificates: CERTIFICATES },
    });
    const { turn, outcome } = await h.service.propose(WORKER_ID, profileRow(), "welder wala certificate hata do", CTX);

    expect(outcome).toBe("proposed");
    expect(turn.edit_proposal?.rows).toHaveLength(1);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Certificate aur padhai",
      field_label: "Certificate ka saal",
      op: "edit",
      after: "2019",
    });
    expect(savedRows(h).map((r) => r.op)).toEqual(["edit"]);
    expect(proposedPayload(h)).toMatchObject({ row_count: 1, dropped_count: 1 });
    expect(warnLines().filter((line) => line.includes("reason=qualification_delete_from_chat"))).toHaveLength(1);
  });

  it("a job delete and a qualification delete on one card share ONE counts-only line with both reasons", async () => {
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "employment", ref: "e1", field: "employer_name", value: null }),
        row({ op: "delete", section: "qualifications", ref: "c1", field: "certificate_name", value: null }),
      ]),
      employmentViews: [EMPLOYMENT],
      qualificationLists: { certificates: CERTIFICATES },
    });
    const result = await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    expect(result.turn.reply).toBe(V2_EDIT_PLACEHOLDER.latin);
    const lines = warnLines().filter((line) => line.includes("whole-entry delete"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=job_delete_from_chat,qualification_delete_from_chat");
    expect(lines[0]).toContain("2 of 2 rows");
  });

  it("a qualification EDIT still works: 'certificate ka saal 2019 kar do' is carded", async () => {
    const h = setup({
      parse: parse([
        row({ op: "edit", section: "qualifications", ref: "c1", field: "certificate_year", value: "2019" }),
      ]),
      qualificationLists: { certificates: CERTIFICATES },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "certificate ka saal 2019 kar do", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
    expect(warnLines().some((line) => line.includes("qualification_delete_from_chat"))).toBe(false);
  });

  it("the AI service is offered no qualification delete at all", async () => {
    const h = setup({ parse: parse([]) });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
    const input = h.ai.companionEditParse.mock.calls[0]![0] as {
      catalogue: { section: string; field: string; ops: string[] }[];
    };
    const qualifications = input.catalogue.filter((f) => f.section === "qualifications");
    expect(qualifications).toHaveLength(11);
    for (const entry of qualifications) expect(entry.ops).toEqual(["edit"]);
  });
});
