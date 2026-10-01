import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("a DELETE is legal on employment and qualifications — edit/delete-only sections", async () => {
    // The A4 eval caught the opposite: with `delete` allowed on no field, every employment and
    // qualification delete was silently dropped. The field is only the row's ANCHOR here.
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "employment", ref: "e1", field: "employer_name", value: null }),
        row({ op: "delete", section: "qualifications", ref: "c1", field: "certificate_name", value: null }),
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
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "purana kaam hata do", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(2);
    expect(turn.edit_proposal?.rows.map((r) => r.op)).toEqual(["delete", "delete"]);
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
const CERT_B = { name: "Welding Level 2", issuer: "L&T", year: 2018, licence_number: null, licence_expiry: null };
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

  it("two deletes of ONE entry (different anchor fields) are one delete", async () => {
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "qualifications", ref: "c1", field: "certificate_name", value: null }),
        row({ op: "delete", section: "qualifications", ref: "c1", field: "certificate_year", value: null }),
      ]),
      qualificationLists: { certificates: [CERT_A, CERT_B] },
    });
    await h.service.propose(WORKER_ID, profileRow(), "pehla certificate hatao", CTX);
    expect(savedRows(h)).toHaveLength(1);
  });

  it("an edit of an entry the same card deletes is dropped — the delete says it all", async () => {
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "qualifications", ref: "c1", field: "certificate_name", value: null }),
        row({ op: "edit", section: "qualifications", ref: "c1", field: "certificate_year", value: "2017" }),
      ]),
      qualificationLists: { certificates: [CERT_A, CERT_B] },
    });
    await h.service.propose(WORKER_ID, profileRow(), "kuch", CTX);
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

  it("a whole-entry delete is labelled as the entry, whatever field the model anchored on", async () => {
    const h = setup({
      parse: parse([row({ op: "delete", section: "employment", ref: "e1", field: "start_ym", value: null })]),
      employmentViews: [EMPLOYMENT],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "Tata wala kaam hatao", CTX);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Kaam",
      field_label: "Yeh poora kaam",
      op: "delete",
      before: "2019-01",
      before_display: null,
    });
  });

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
  // qualifications field, so a section check alone passed `delete q1 certificate_name` — and the
  // apply, which goes by the ref's list, would delete the education under a card that said
  // "Yeh poora certificate" with no value.
  const EDU = { credential: "iti", field: "Fitter", council: "ncvt", year: 2016, institute: "Govt ITI" };
  const TRAINING = { name: "CNC basics", provider: "NTTF", year: 2020 };

  it.each([
    ["a certificate field on an education (delete)", row({ op: "delete", section: "qualifications", ref: "q1", field: "certificate_name", value: null })],
    ["an education field on a certificate (delete)", row({ op: "delete", section: "qualifications", ref: "c1", field: "education_year", value: null })],
    ["a training field on a certificate (edit)", row({ op: "edit", section: "qualifications", ref: "c1", field: "training_year", value: "2019" })],
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

  it("the same entry anchored on its OWN field is carded, and labelled as that entry", async () => {
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "qualifications", ref: "q1", field: "education_council", value: null }),
      ]),
      qualificationLists: { certificates: [CERT_A], educations: [EDU] },
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "ITI wali padhai hatao", CTX);
    expect(turn.edit_proposal?.rows).toHaveLength(1);
    expect(turn.edit_proposal?.rows[0]).toMatchObject({
      section_label: "Certificate aur padhai",
      field_label: "Yeh poori padhai",
      op: "delete",
      before: "ncvt",
    });
  });

  it("a mis-kinded row beside a good one: the card carries the good row only, dropped counted", async () => {
    const h = setup({
      parse: parse([
        row({ op: "delete", section: "qualifications", ref: "q1", field: "certificate_name", value: null }),
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
