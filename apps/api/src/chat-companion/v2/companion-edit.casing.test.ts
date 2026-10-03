import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { WorkerEmploymentService } from "../../profiles/worker-employment.service";
import { WorkerQualificationsService } from "../../profiles/worker-qualifications.service";
import { V2_EDIT_DONE, V2_EDIT_NONE, V2_EDIT_STALE } from "../companion-replies";
import { type Harness, profileRow, setup, storedProposal, WORKER_ID } from "./companion-edit.fake";
import type { StoredEditProposalRow } from "./edit-proposal.store";

/**
 * #1940 — THE CARD AND THE STORE AGREE ON CASING.
 *
 * The employment and qualifications writers now store `employer_name` and the education `field` in
 * the app's casing. The edit card sits in front of them, and three of its rules compare strings: the
 * no-op drop (`value === before`), the stale check (stored `before` against a fresh read) and the
 * confirm's counts. Each is pinned here against the REAL writers, because the casing under test is
 * theirs; a stub writer would store whatever the card said and prove nothing.
 */

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;
const TATA_ID = "66666666-6666-4666-8666-666666666666";
const RVM_ID = "77777777-7777-4777-8777-777777777777";

/** A model row, as `companionEditParse` would return it. */
function modelRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    op: "edit",
    section: "employment",
    ref: "e1",
    field: "employer_name",
    value: null,
    ...over,
  };
}

function parse(rows: Record<string, unknown>[]) {
  return { rows, unsupported: [] };
}

/** One employment as `GET /workers/me/employment` returns it. */
function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    employment_id: TATA_ID,
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
    ...over,
  };
}

const EDU = {
  credential: "iti",
  field: "Mechanical",
  council: "ncvt",
  year: 2016,
  institute: null,
};

/**
 * The REAL employment writer behind the harness's spy, over a repository stub. `encrypt` is a spy,
 * so the plaintext it sealed — what the column will hold — can be read back.
 */
function realEmploymentWriter(h: Harness) {
  type Row = { employerNameEnc: string; roles: readonly { roleLabel: string }[] };
  const repoReplace = vi.fn(async (_workerId: string, rows: readonly Row[]) => ({
    replacedExisting: true,
    existingCount: rows.length,
    skipped: false,
    carriedUnreadable: 0,
  }));
  const encrypt = vi.fn((plaintext: string) => `sealed(${plaintext.length})`);
  const emit = vi.fn(async (_event: { event_name: string; payload: unknown }) => undefined);
  const writer = new WorkerEmploymentService(
    { replaceForWorker: repoReplace, findOwnedVoiceNoteIds: vi.fn() } as never,
    { findById: async () => ({ id: WORKER_ID }), latestResume: async () => null } as never,
    { encrypt } as never,
    { emit } as never,
    { add: vi.fn() } as never,
    { employmentSuggestionsForWorker: async () => [] } as never,
  );
  h.employment.replaceForWorker.mockImplementation((...args: unknown[]) =>
    writer.replaceForWorker(...(args as Parameters<WorkerEmploymentService["replaceForWorker"]>)),
  );
  /** The plaintext each stored employer name was sealed from, in order. */
  const sealed = (): string[] => encrypt.mock.calls.map((call) => call[0]);
  return { repoReplace, sealed, emit };
}

/** The REAL qualifications writer behind the harness's spy, over a repository stub. */
function realQualificationsWriter(h: Harness) {
  type Input = { educations?: readonly { field: string | null }[] };
  const repoReplace = vi.fn(async (_workerId: string, input: Input) => ({
    certificatesWritten: 0,
    educationsWritten: input.educations?.length ?? 0,
    trainingsWritten: 0,
    replacedExisting: true,
  }));
  const writer = new WorkerQualificationsService(
    { replaceForWorker: repoReplace } as never,
    { findById: async () => ({ id: WORKER_ID }), latestResume: async () => null } as never,
    { emit: vi.fn(async () => undefined) } as never,
    { encrypt: vi.fn(() => "TOKEN") } as never,
    { add: vi.fn() } as never,
  );
  h.qualifications.replaceForWorker.mockImplementation((...args: unknown[]) =>
    writer.replaceForWorker(
      ...(args as Parameters<WorkerQualificationsService["replaceForWorker"]>),
    ),
  );
  return { repoReplace };
}

/** Propose, then Haan on every row of the card it produced. */
async function proposeThenConfirm(h: Harness, text: string) {
  const { turn } = await h.service.propose(WORKER_ID, profileRow(), text, CTX);
  const card = turn.edit_proposal!;
  const result = await h.service.confirm(
    WORKER_ID,
    profileRow(),
    card.proposal_id,
    card.rows.map((row) => row.row_id),
    CTX,
  );
  return { card, result };
}

function eventPayload(
  emit: { mock: { calls: unknown[][] } },
  name: string,
): Record<string, unknown> {
  const call = emit.mock.calls.find((c) => (c[0] as { event_name: string }).event_name === name)!;
  return (call[0] as { payload: Record<string, unknown> }).payload;
}

describe("the card's `after` is the string the writer stores (#1940)", () => {
  it("employer name: 'mahindra logistics' is carded as 'Mahindra Logistics', and Haan seals exactly that", async () => {
    const h = setup({
      parse: parse([modelRow({ value: "mahindra logistics" })]),
      employmentViews: [job()],
    });
    const writer = realEmploymentWriter(h);
    const { card, result } = await proposeThenConfirm(h, "Tata ki jagah mahindra logistics likho");

    expect(card.rows[0]).toMatchObject({ before: "Tata Motors", after: "Mahindra Logistics" });
    expect(result.kind).toBe("applied");
    expect(writer.sealed()).toEqual([card.rows[0]!.after]);
  });

  it("education field: 'mechanical engineering' is carded cased, and the repository receives the card's `after`", async () => {
    const h = setup({
      parse: parse([
        modelRow({
          section: "qualifications",
          ref: "q1",
          field: "education_field",
          value: "mechanical engineering",
        }),
      ]),
      qualificationLists: { educations: [EDU] },
    });
    const writer = realQualificationsWriter(h);
    const { card, result } = await proposeThenConfirm(h, "trade mechanical engineering likho");

    expect(card.rows[0]).toMatchObject({ before: "Mechanical", after: "Mechanical Engineering" });
    expect(result.kind).toBe("applied");
    expect(writer.repoReplace.mock.calls[0]![1].educations).toEqual([
      { ...EDU, field: card.rows[0]!.after },
    ]);
  });

  it("a value the rule keeps is carded and sealed byte-identical: 'RVM CAD Pvt Ltd'", async () => {
    const h = setup({
      parse: parse([modelRow({ value: "RVM CAD Pvt Ltd" })]),
      employmentViews: [job()],
    });
    const writer = realEmploymentWriter(h);
    const { card } = await proposeThenConfirm(h, "RVM CAD Pvt Ltd likho");
    expect(card.rows[0]!.after).toBe("RVM CAD Pvt Ltd");
    expect(writer.sealed()).toEqual(["RVM CAD Pvt Ltd"]);
  });

  it("the role label is carded and stored as typed — casing it is an open owner decision", async () => {
    const h = setup({
      parse: parse([modelRow({ field: "role_label", value: "cnc turner" })]),
      employmentViews: [job()],
    });
    const writer = realEmploymentWriter(h);
    const { card } = await proposeThenConfirm(h, "role cnc turner likho");
    expect(card.rows[0]!.after).toBe("cnc turner");
    expect(writer.repoReplace.mock.calls[0]![1][0]!.roles[0]!.roleLabel).toBe("cnc turner");
  });
});

describe("the no-op drop compares stored strings with stored strings (#1940)", () => {
  it.each([
    ["employer name", modelRow({ value: "tata motors" }), { employmentViews: [job()] }],
    [
      "education field",
      modelRow({
        section: "qualifications",
        ref: "q1",
        field: "education_field",
        value: "mechanical",
      }),
      { qualificationLists: { educations: [EDU] } },
    ],
  ] as const)(
    "%s: a casing-only edit of the cased stored value is no edit — no card, nothing saved",
    async (_what, row, state) => {
      const h = setup({ parse: parse([row]), ...state });
      const { turn } = await h.service.propose(WORKER_ID, profileRow(), "spelling theek karo", CTX);
      // Without the casing in `normaliseValue`, this was a card ("Tata Motors" → "tata motors")
      // whose Haan wrote the same bytes and still spent a résumé regeneration.
      expect(turn.edit_proposal).toBeUndefined();
      expect(turn.reply).toBe(V2_EDIT_NONE.latin);
      expect(h.proposals.save).not.toHaveBeenCalled();
    },
  );

  it("beside a real change, the casing-only row is dropped and counted in dropped_count", async () => {
    const h = setup({
      parse: parse([
        modelRow({ value: "tata motors" }),
        modelRow({ field: "employer_city", value: "Mumbai" }),
      ]),
      employmentViews: [job()],
    });
    const { turn } = await h.service.propose(WORKER_ID, profileRow(), "tata motors, Mumbai", CTX);
    expect(turn.edit_proposal?.rows.map((r) => r.after)).toEqual(["Mumbai"]);
    expect(eventPayload(h.events.emit, "chat.companion_edit_proposed")).toMatchObject({
      row_count: 1,
      dropped_count: 1,
    });
  });

  it("a legacy lowercase row is carded truthfully: the same bytes from the model still show the casing Haan will store", async () => {
    // Stored before the API cased (or before the backfill reached it). The model echoing those
    // bytes is not a no-op any more: Haan stores "Tata Motors", so the card says so.
    const h = setup({
      parse: parse([modelRow({ value: "tata motors" })]),
      employmentViews: [job({ employer_name: "tata motors" })],
    });
    const writer = realEmploymentWriter(h);
    const { card, result } = await proposeThenConfirm(h, "tata motors");
    expect(card.rows[0]).toMatchObject({ before: "tata motors", after: "Tata Motors" });
    expect(result.kind).toBe("applied");
    expect(writer.sealed()).toEqual(["Tata Motors"]);
  });
});

describe("a Haan round-trips: what the writer stored is the next card's `before` (#1940)", () => {
  it("the same ask after a Haan is a no-op, and a further edit passes the stale check on the cased value", async () => {
    // 1. Haan on "mahindra logistics" stores "Mahindra Logistics".
    const first = setup({
      parse: parse([modelRow({ value: "mahindra logistics" })]),
      employmentViews: [job()],
    });
    const writer = realEmploymentWriter(first);
    await proposeThenConfirm(first, "mahindra logistics likho");
    const [stored] = writer.sealed();
    expect(stored).toBe("Mahindra Logistics");

    // 2. The GET now returns that value. Asking again changes nothing, so there is no card.
    const again = setup({
      parse: parse([modelRow({ value: "mahindra logistics" })]),
      employmentViews: [job({ employer_name: stored })],
    });
    const { turn } = await again.service.propose(
      WORKER_ID,
      profileRow(),
      "mahindra logistics likho",
      CTX,
    );
    expect(turn.edit_proposal).toBeUndefined();

    // 3. A real edit cards the cased value as its `before`, and the confirm's fresh read of the
    //    same cased value is NOT stale: the row is applied.
    const next = setup({
      parse: parse([modelRow({ value: "mahindra logistics ltd" })]),
      employmentViews: [job({ employer_name: stored })],
    });
    const nextWriter = realEmploymentWriter(next);
    const { card, result } = await proposeThenConfirm(next, "mahindra logistics ltd likho");
    expect(card.rows[0]).toMatchObject({
      before: "Mahindra Logistics",
      after: "Mahindra Logistics Ltd",
    });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") expect(result.turn.reply).toBe(V2_EDIT_DONE.latin);
    expect(nextWriter.sealed()).toEqual(["Mahindra Logistics Ltd"]);
  });

  it("a card built on a legacy lowercase `before` is stale once the row was re-cased meanwhile — nothing written", async () => {
    // The #1432 runbook's residual, unchanged: the backfill (or any writer, now that every writer
    // cases) moved the stored bytes under an open card, so the card no longer describes the row.
    const row: StoredEditProposalRow = {
      row_id: "44444444-4444-4444-8444-444444444444",
      section: "employment",
      op: "edit",
      field: "employer_city",
      value: "Mumbai",
      before: "Pune",
      section_label: "Kaam",
      target: { employment_id: TATA_ID },
    };
    const nameRow: StoredEditProposalRow = {
      ...row,
      row_id: "55555555-5555-4555-8555-555555555555",
      field: "employer_name",
      value: "Tata Motors Ltd",
      before: "tata motors",
    };
    const h = setup({
      proposal: storedProposal({ rows: [row, nameRow] }),
      employmentViews: [job({ employer_name: "Tata Motors" })],
    });
    const result = await h.service.confirm(
      WORKER_ID,
      profileRow(),
      storedProposal().proposal_id,
      [row.row_id, nameRow.row_id],
      CTX,
    );
    expect(result.kind).toBe("stale");
    if (result.kind === "stale") expect(result.turn.reply).toBe(V2_EDIT_STALE.latin);
    expect(h.employment.replaceForWorker).not.toHaveBeenCalled();
    expect(h.committed).toEqual([]);
  });
});

describe("the counts on the spine are the card's, never inflated by casing (#1940)", () => {
  it("a city edit over two jobs re-cases the legacy name it re-sends, yet reports applied_count 1 and employer_count 2", async () => {
    // The employment PUT is a whole-history replace, so the untouched job rides along and is
    // stored cased, exactly as the form path stores it. The renderer already printed it cased
    // (`casedEmployer`), so the sheet does not move. No count anywhere says "2 changed".
    const h = setup({
      parse: parse([modelRow({ field: "employer_city", value: "Mumbai" })]),
      employmentViews: [
        job(),
        job({ employment_id: RVM_ID, employer_name: "rvm cad", employer_city: null }),
      ],
    });
    const writer = realEmploymentWriter(h);
    const { card, result } = await proposeThenConfirm(h, "Tata Mumbai mein tha");

    expect(card.rows).toHaveLength(1);
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") expect(result.appliedCount).toBe(1);
    expect(writer.sealed()).toEqual(["Tata Motors", "Rvm Cad"]);
    expect(eventPayload(h.events.emit, "chat.companion_edit_confirmed")).toMatchObject({
      applied_count: 1,
      sections: ["employment"],
    });
    expect(writer.emit).toHaveBeenCalledTimes(1);
    expect(eventPayload(writer.emit, "worker.employment_recorded")).toEqual({
      worker_id: WORKER_ID,
      employer_count: 2,
      durations_stated: 2,
      replaced_existing: true,
    });
  });
});
