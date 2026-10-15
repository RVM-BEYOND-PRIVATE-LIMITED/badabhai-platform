import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { RESUME_SECTIONS } from "../../chat/resume-menu";
import { V2_EDIT_NONE, V2_EDIT_PLACEHOLDER, V2_EDIT_STALE } from "../companion-replies";
import type { CompanionTurn } from "../chat-companion.dto";
import { profileRow, setup, WORKER_ID } from "./companion-edit.fake";

/**
 * #2295 — THE EDIT PATH FOR A WORKER WHOSE PROFILE THE TRADE FORM MADE, end to end through the
 * real `propose` and `confirm` (only the section reads, writers, stores and the AI client faked).
 *
 * The model's outputs below are REAL: claude-haiku-4-5 answering the API's own request for this
 * fixture — the catalogue, the snapshot `snapshotRows` built from it (before the languages fix, so
 * with no `l` rows), `max_rows` 3 — through a local ai-service on the shipped edit-parse prompt
 * (sha256 prefix 8b852f358d91), 2026-10-15. The phrases and every value are fabricated.
 *
 * What they showed: the API's per-row gates accept every concrete change the catalogue covers (the
 * salary, city and shift cards below), so a form-made profile is not refused wholesale. The one
 * API defect was LANGUAGES: the form stores them as the `languages` preference attribute, the
 * résumé prints that attribute while the worker has no Languages-page rows, and the edit path read
 * only the rows — so it saw no language, and an add replaced everything the form stored on the
 * sheet. The edit path now reads and writes the store the résumé prints (`languageSourceOf`).
 */

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;

/** One job, as the form's employment page stored it. */
const EMPLOYMENT = [
  {
    employment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    employer_name: "Shree Balaji Engineering",
    employer_city: "Nashik",
    employer_state: "Maharashtra",
    start_ym: "2019-04",
    end_ym: null,
    roles: [
      {
        role_label: "CNC Turner",
        start_ym: "2019-04",
        end_ym: null,
        work_done: null,
        work_done_voice_note_id: null,
      },
    ],
  },
];

const ITI = { credential: "iti", field: "Turner", council: "ncvt", year: 2018, institute: null };

/** The form's preferences page — languages included, as the bare attribute list it writes. */
const PREFERENCES = {
  shift: "day",
  job_type: "permanent",
  willing_to_relocate: false,
  salary_expected_max: 18000,
  preferred_cities: ["Nashik"],
  languages: ["hindi"],
};

/** Every CNC-turning pack answer is a worker attribute, so the draft carries no skill label. */
const FORM_DRAFT = { skills: [], skill_labels: [], machines: [], resume_profile: null };

/** The recorded model outputs (see the header). */
const RECORDED = {
  marathi: {
    text: "skills mein Marathi jod do",
    rows: [{ op: "add", section: "languages", ref: null, field: "language", value: "Marathi" }],
    unsupported: [],
  },
  salary: {
    text: "meri salary 25000 kar do",
    rows: [
      { op: "edit", section: "preferences", ref: "pref", field: "expected_salary", value: "25000" },
    ],
    unsupported: [],
  },
  city: {
    text: "city Pune kar do",
    rows: [
      { op: "edit", section: "preferences", ref: "pc1", field: "preferred_cities", value: "Pune" },
    ],
    unsupported: [],
  },
  nightShift: {
    text: "night shift bhi chalega",
    rows: [{ op: "edit", section: "preferences", ref: "pref", field: "shift", value: "night" }],
    unsupported: [],
  },
  fanuc: { text: "Fanuc hata do", rows: [], unsupported: ["other"] },
  certificate: { text: "ek certificate add karo ITI Turner", rows: [], unsupported: ["other"] },
  experience: {
    text: "experience 6 saal kar do",
    rows: [{ op: "edit", section: "employment", ref: "e1", field: "end_ym", value: null }],
    unsupported: [],
  },
} as const;

type Recorded = (typeof RECORDED)[keyof typeof RECORDED];

function formTurner(recorded: Recorded, over: Parameters<typeof setup>[0] = {}) {
  return setup({
    parse: { rows: recorded.rows, unsupported: recorded.unsupported },
    employmentViews: EMPLOYMENT,
    qualificationLists: { educations: [ITI] },
    preferenceValues: PREFERENCES,
    brain: "on",
    ...over,
  });
}

const profile = () => profileRow({ rawProfile: FORM_DRAFT as never });

async function propose(h: ReturnType<typeof setup>, text: string) {
  return h.service.propose(WORKER_ID, profile(), text, CTX);
}

/** Haan on every row of the card `propose` just stored. */
async function confirmCard(h: ReturnType<typeof setup>, turn: CompanionTurn) {
  const card = turn.edit_proposal!;
  return h.service.confirm(
    WORKER_ID,
    profile(),
    card.proposal_id,
    card.rows.map((row) => row.row_id),
    CTX,
  );
}

const cardRows = (turn: CompanionTurn) =>
  turn.edit_proposal?.rows.map(({ section_label, op, before, after }) => ({
    section_label,
    op,
    before,
    after,
  }));

const keys = (turn: CompanionTurn) => turn.suggested_options.map((option) => option.option_key);
const SECTION_KEYS = RESUME_SECTIONS.map((section) => section.key);

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("#2295 root cause — a form-made worker's languages are the attribute the résumé prints", () => {
  it("the model is SHOWN the form's languages (they were missing from the snapshot)", async () => {
    const h = formTurner(RECORDED.marathi);
    await propose(h, RECORDED.marathi.text);
    const sent = (h.ai.companionEditParse.mock.calls[0] as unknown[])[0] as {
      snapshot: { ref: string; section: string; fields: Record<string, string | null> }[];
    };
    expect(sent.snapshot.filter((row) => row.section === "languages")).toEqual([
      { ref: "l1", section: "languages", fields: { language: "hindi" } },
    ]);
  });

  it("'skills mein Marathi jod do' → a card; Haan writes the ATTRIBUTE, Hindi kept, in one transaction", async () => {
    const h = formTurner(RECORDED.marathi);
    const proposed = await propose(h, RECORDED.marathi.text);
    expect(proposed.outcome).toBe("proposed");
    expect(cardRows(proposed.turn)).toEqual([
      { section_label: "Bhasha", op: "add", before: null, after: "marathi" },
    ]);

    const applied = await confirmCard(h, proposed.turn);
    expect(applied.kind).toBe("applied");
    expect(h.db.transaction).toHaveBeenCalledTimes(1);
    expect(h.languages.replaceForWorker).not.toHaveBeenCalled();
    expect(h.committed).toHaveLength(1);
    expect(h.committed[0]!.writer).toBe("preferences");
    expect(h.committed[0]!.args[1]).toEqual({
      touched_only: true,
      languages: ["hindi", "marathi"],
    });
    // On the transaction's handle, never autocommitted.
    expect((h.committed[0]!.args[3] as { tx: unknown }).tx).toBe(h.tx);
  });

  it("a card mixing the language add with the salary edit lands both, in ONE transaction", async () => {
    const h = formTurner({
      text: "Marathi jod do aur salary 25000 kar do",
      rows: [...RECORDED.marathi.rows, ...RECORDED.salary.rows],
      unsupported: [],
    } as never);
    const proposed = await propose(h, "Marathi jod do aur salary 25000 kar do");
    await confirmCard(h, proposed.turn);
    expect(h.db.transaction).toHaveBeenCalledTimes(1);
    expect(h.committed.map((write) => write.args[1])).toEqual([
      { touched_only: true, languages: ["hindi", "marathi"] },
      { touched_only: true, salary_expected_max: 25000, salary_expected_min: null },
    ]);
  });

  it("a writer failure rolls BOTH back: nothing is committed", async () => {
    const h = formTurner(RECORDED.marathi, { failingWriters: ["preferences"] });
    const proposed = await propose(h, RECORDED.marathi.text);
    expect((await confirmCard(h, proposed.turn)).kind).toBe("failed");
    expect(h.committed).toEqual([]);
  });

  it("with Languages-page rows the same add writes the ROWS, exactly as before", async () => {
    const hindi = { language: "hindi", can_speak: true, can_read: true, can_write: false };
    const h = formTurner(RECORDED.marathi, {
      languageEntries: [hindi],
      preferenceValues: { ...PREFERENCES, languages: ["hindi", "punjabi"] },
    });
    const proposed = await propose(h, RECORDED.marathi.text);
    await confirmCard(h, proposed.turn);
    expect(h.preferences.setForWorker).not.toHaveBeenCalled();
    expect(h.committed.map((write) => [write.writer, write.args[1]])).toEqual([
      [
        "languages",
        {
          languages: [
            hindi,
            { language: "marathi", can_speak: true, can_read: false, can_write: false },
          ],
        },
      ],
    ]);
  });

  it("an add of a language the FORM already stored is a no-op: no card", async () => {
    const h = formTurner(RECORDED.marathi, {
      preferenceValues: { ...PREFERENCES, languages: ["hindi", "marathi"] },
    });
    const proposed = await propose(h, RECORDED.marathi.text);
    expect(proposed.outcome).toBe("clarify");
    expect(proposed.turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });

  it("a delete addresses the attribute's member, and Haan removes it from the attribute", async () => {
    // CONSTRUCTED (not recorded): the delete the model gives once `l1` is in its snapshot.
    const h = formTurner({
      text: "Hindi hata do",
      rows: [{ op: "delete", section: "languages", ref: "l1", field: "language", value: null }],
      unsupported: [],
    } as never);
    const proposed = await propose(h, "Hindi hata do");
    expect(cardRows(proposed.turn)).toEqual([
      { section_label: "Bhasha", op: "delete", before: "hindi", after: null },
    ]);
    await confirmCard(h, proposed.turn);
    expect(h.committed.map((write) => write.args[1])).toEqual([
      { touched_only: true, languages: [] },
    ]);
  });

  it("a card read from the attribute is STALE once the languages moved to rows: nothing written", async () => {
    const h = formTurner({
      text: "Hindi hata do",
      rows: [{ op: "delete", section: "languages", ref: "l1", field: "language", value: null }],
      unsupported: [],
    } as never);
    const proposed = await propose(h, "Hindi hata do");
    // The worker saves the Languages page before tapping Haan: the sheet now prints the rows.
    h.languages.getForWorker.mockResolvedValue({
      languages: [{ language: "hindi", can_speak: true, can_read: false, can_write: false }],
      partial: false,
      dropped_count: 0,
    });
    const result = await confirmCard(h, proposed.turn);
    expect(result.kind).toBe("stale");
    if (result.kind === "stale") expect(result.turn.reply).toBe(V2_EDIT_STALE.latin);
    expect(h.committed).toEqual([]);
  });

  it.each([
    ["the preferences read fails", { preferencesReadFails: true }],
    ["the attribute was partly withheld", { preferencesPartial: ["languages"] }],
    ["a Languages-page row was withheld", { languagesPartial: true }],
  ] as const)("FAIL CLOSED when %s: the add is never carded", async (_why, over) => {
    const h = formTurner(RECORDED.marathi, over);
    const proposed = await propose(h, RECORDED.marathi.text);
    expect(proposed.turn.edit_proposal).toBeUndefined();
    expect(h.proposals.save).not.toHaveBeenCalled();
  });
});

describe("#2295 — the other recorded outputs on the same form-made profile", () => {
  it.each([
    [
      "salary",
      RECORDED.salary,
      [{ section_label: "Pasand", op: "edit", before: "18000", after: "25000" }],
    ],
    [
      "city",
      RECORDED.city,
      [
        { section_label: "Pasand", op: "delete", before: "Nashik", after: null },
        { section_label: "Pasand", op: "add", before: null, after: "Pune" },
      ],
    ],
    [
      "night shift",
      RECORDED.nightShift,
      [{ section_label: "Pasand", op: "edit", before: "day", after: "night" }],
    ],
  ] as const)("%s → a card with the expected rows", async (_name, recorded, rows) => {
    const h = formTurner(recorded);
    const proposed = await propose(h, recorded.text);
    expect(proposed.outcome).toBe("proposed");
    expect(cardRows(proposed.turn)).toEqual(rows);
  });

  it.each([
    [
      "a controller (a pack answer, not editable from chat)",
      RECORDED.fanuc,
      V2_EDIT_PLACEHOLDER,
      "served",
    ],
    [
      "a new certificate (qualifications are edit-only)",
      RECORDED.certificate,
      V2_EDIT_PLACEHOLDER,
      "served",
    ],
    [
      "experience years (no catalogue field; a null value)",
      RECORDED.experience,
      V2_EDIT_NONE,
      "clarify",
    ],
  ] as const)(
    "%s → no card, and the EDIT SECTION chips on the brain",
    async (_why, recorded, line, outcome) => {
      const h = formTurner(recorded);
      const proposed = await propose(h, recorded.text);
      expect(proposed.outcome).toBe(outcome);
      expect(proposed.turn.reply).toBe(line.latin);
      expect(keys(proposed.turn)).toEqual(SECTION_KEYS);
    },
  );
});
