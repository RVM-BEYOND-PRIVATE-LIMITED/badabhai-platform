import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { NewWorkerAttribute } from "@badabhai/db";
import { SetMyPreferencesSchema } from "../../profiles/worker-preferences.dto";
import { WorkerPreferencesService } from "../../profiles/worker-preferences.service";
import { V2_EDIT_STALE } from "../companion-replies";
import { profileRow, setup, storedProposal, WORKER_ID } from "./companion-edit.fake";
import type { StoredEditProposalRow } from "./edit-proposal.store";
import { qualificationFingerprint, type QualificationList } from "./edit-snapshot";

/**
 * WHAT A HAAN WRITES (ADR-0046 O4) — each section's apply, pinned on the exact body its writer
 * receives. The audit's apply-correctness items live here; the confirm-route behaviour (claims,
 * expiry, the fallback card) lives in `companion-edit.confirm.test.ts`.
 */

const CTX = { correlationId: "c-1", requestId: "r-1" } as never;
const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const ids = (n: number) => `44444444-4444-4444-8444-44444444444${n}`;

function prefRow(n: number, over: Partial<StoredEditProposalRow>): StoredEditProposalRow {
  return {
    row_id: ids(n),
    section: "preferences",
    op: "edit",
    field: null,
    value: null,
    before: null,
    section_label: "Pasand",
    target: null,
    ...over,
  };
}

/** A qualification card row, targeted the way `propose` targets it: list, index, fingerprint. */
function qualRow(
  n: number,
  list: QualificationList,
  index: number,
  entry: Record<string, unknown>,
  over: Partial<StoredEditProposalRow>,
): StoredEditProposalRow {
  return {
    row_id: ids(n),
    section: "qualifications",
    op: "delete",
    field: "certificate_name",
    value: null,
    before: String(entry["name"] ?? ""),
    section_label: "Certificate aur padhai",
    target: { list, index, fp: qualificationFingerprint(list, entry) },
    ...over,
  };
}

async function confirmAll(h: ReturnType<typeof setup>, rows: readonly StoredEditProposalRow[]) {
  return h.service.confirm(WORKER_ID, profileRow(), PROPOSAL_ID, rows.map((r) => r.row_id), CTX);
}

/** The body a writer received on its (only) call. */
function bodyOf(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0]![1] as Record<string, unknown>;
}

/** The REAL preferences writer over a stored-attribute fake — the #1504 rule is its, not ours. */
function realPreferencesWriter(stored: { attributeKey: string; valueKind: string; valueBool?: boolean; valueTextList?: string[] }[]) {
  const rows = stored.map((r) => ({
    valueBool: null,
    valueNumber: null,
    valueText: null,
    valueTextList: null,
    valueJson: null,
    ...r,
  }));
  const upsertMany = vi.fn(async (_rows: NewWorkerAttribute[]) => 0);
  const deleteKeys = vi.fn(async (_workerId: string, _keys: readonly string[]) => 0);
  const loadKeys = vi.fn(async (_workerId: string, keys: readonly string[]) =>
    rows.filter((r) => keys.includes(r.attributeKey)),
  );
  const svc = new WorkerPreferencesService(
    { upsertMany, deleteKeys, loadKeys } as never,
    {
      findById: async () => ({ id: WORKER_ID, resumeNightShiftReady: null }),
      latestResume: async () => null,
      updateResumePrefs: vi.fn(),
    } as never,
    { emit: vi.fn(async () => undefined) } as never,
    { add: vi.fn(async () => undefined) } as never,
  );
  return { svc, upsertMany, deleteKeys };
}

describe("preferences — a false or an empty list is an ANSWER (BUG-PREFS-TOUCHED-ONLY)", () => {
  it('"travel nahi kar sakta": true → false reaches the writer as a touched key, and the writer stores it', async () => {
    const row = prefRow(1, { field: "willing_to_travel", value: "false", before: "true" });
    const h = setup({
      proposal: storedProposal({ rows: [row] }),
      preferenceValues: { willing_to_travel: true },
    });
    expect((await confirmAll(h, [row])).kind).toBe("applied");
    const body = bodyOf(h.preferences.setForWorker);
    expect(body).toEqual({ touched_only: true, willing_to_travel: false });

    // The same body through the REAL writer, with `true` stored: `false` is written, not skipped
    // as an old build's default (which is what it did without `touched_only`).
    const writer = realPreferencesWriter([
      { attributeKey: "willing_to_travel", valueKind: "boolean", valueBool: true },
    ]);
    await writer.svc.setForWorker(WORKER_ID, SetMyPreferencesSchema.parse(body), CTX, {});
    const written = writer.upsertMany.mock.calls[0]![0];
    expect(written.find((r) => r.attributeKey === "willing_to_travel")?.valueBool).toBe(false);
  });

  it("removing the LAST preferred city clears the list, not silently nothing", async () => {
    const row = prefRow(1, {
      op: "delete",
      field: "preferred_cities",
      before: "Pune",
      target: { member: "Pune" },
    });
    const h = setup({
      proposal: storedProposal({ rows: [row] }),
      preferenceValues: { preferred_cities: ["Pune"] },
    });
    await confirmAll(h, [row]);
    const body = bodyOf(h.preferences.setForWorker);
    expect(body).toEqual({ touched_only: true, preferred_cities: [] });

    const writer = realPreferencesWriter([
      { attributeKey: "preferred_locations", valueKind: "text_list", valueTextList: ["Pune"] },
    ]);
    await writer.svc.setForWorker(WORKER_ID, SetMyPreferencesSchema.parse(body), CTX, {});
    expect(writer.deleteKeys.mock.calls[0]![1]).toContain("preferred_locations");
  });
});

describe("preferences — several rows on ONE list all land (contracts-privacy BUG-1)", () => {
  it('"Pune aur Mumbai dono add karo": both cities written', async () => {
    const rows = [
      prefRow(1, { op: "add", field: "preferred_cities", value: "Pune" }),
      prefRow(2, { op: "add", field: "preferred_cities", value: "Mumbai" }),
    ];
    const h = setup({
      proposal: storedProposal({ rows }),
      preferenceValues: { preferred_cities: ["Delhi"] },
    });
    const result = await confirmAll(h, rows);
    expect(result).toMatchObject({ kind: "applied", appliedCount: 2 });
    expect(bodyOf(h.preferences.setForWorker)["preferred_cities"]).toEqual(["Delhi", "Pune", "Mumbai"]);
  });

  it("an add and a delete on the same list both land", async () => {
    const rows = [
      prefRow(1, { op: "add", field: "preferred_cities", value: "Mumbai" }),
      prefRow(2, { op: "delete", field: "preferred_cities", before: "Pune", target: { member: "Pune" } }),
    ];
    const h = setup({
      proposal: storedProposal({ rows }),
      preferenceValues: { preferred_cities: ["Delhi", "Pune"] },
    });
    await confirmAll(h, rows);
    expect(bodyOf(h.preferences.setForWorker)["preferred_cities"]).toEqual(["Delhi", "Mumbai"]);
  });
});

describe("preferences — a shift edit seeds night-shift readiness like the form (BUG-NIGHT-SEED)", () => {
  const SHIFT_NIGHT = prefRow(1, { field: "shift", value: "night", before: null });

  it("seeds from the confirmed shift AFTER the commit, BEFORE the résumé is asked for", async () => {
    const h = setup({ proposal: storedProposal({ rows: [SHIFT_NIGHT] }) });
    let committedAtSeed = -1;
    h.preferences.seedNightShiftReadyFromShift.mockImplementation(async () => {
      committedAtSeed = h.committed.length;
    });
    expect((await confirmAll(h, [SHIFT_NIGHT])).kind).toBe("applied");
    expect(h.preferences.seedNightShiftReadyFromShift).toHaveBeenCalledWith(WORKER_ID, "night");
    expect(committedAtSeed).toBe(1);
    expect(h.preferences.seedNightShiftReadyFromShift.mock.invocationCallOrder[0]!).toBeLessThan(
      h.resumes.queueChatEditRegeneration.mock.invocationCallOrder[0]!,
    );
  });

  it("a rolled-back confirm seeds nothing", async () => {
    const h = setup({ proposal: storedProposal({ rows: [SHIFT_NIGHT] }), writerThrows: true });
    expect((await confirmAll(h, [SHIFT_NIGHT])).kind).toBe("failed");
    expect(h.preferences.seedNightShiftReadyFromShift).not.toHaveBeenCalled();
  });

  it("a preference row that is not the shift seeds nothing", async () => {
    const row = prefRow(1, { field: "job_type", value: "permanent", before: null });
    const h = setup({ proposal: storedProposal({ rows: [row] }) });
    expect((await confirmAll(h, [row])).kind).toBe("applied");
    expect(h.preferences.seedNightShiftReadyFromShift).not.toHaveBeenCalled();
  });
});

const A = { name: "ITI Fitter", issuer: "NCVT", year: 2016, licence_number: null, licence_expiry: null };
const B = { name: "Welding Level 2", issuer: "L&T", year: 2018, licence_number: null, licence_expiry: null };
const C = { name: "Crane Safety", issuer: "DGFASLI", year: 2019, licence_number: null, licence_expiry: null };
const EDU = { credential: "iti", field: "Fitter", council: "ncvt", year: 2016, institute: "Govt ITI" };

describe("qualifications — rows land on the entry the card showed (contracts-privacy BUG-2)", () => {
  it('"delete A + fix B\'s year" edits B — never C, however the delete shifts the list', async () => {
    const rows = [
      qualRow(1, "certificates", 0, A, { op: "delete" }),
      qualRow(2, "certificates", 1, B, {
        op: "edit",
        field: "certificate_year",
        value: "2020",
        before: "2018",
      }),
    ];
    const h = setup({ proposal: storedProposal({ rows }), qualificationLists: { certificates: [A, B, C] } });
    expect((await confirmAll(h, rows)).kind).toBe("applied");
    expect(bodyOf(h.qualifications.replaceForWorker)["certificates"]).toEqual([
      { ...B, year: 2020 },
      C,
    ]);
  });

  it("two delete rows naming ONE entry delete one entry, not two", async () => {
    const rows = [
      qualRow(1, "certificates", 0, A, { op: "delete", field: "certificate_name" }),
      qualRow(2, "certificates", 0, A, { op: "delete", field: "certificate_year", before: "2016" }),
    ];
    const h = setup({ proposal: storedProposal({ rows }), qualificationLists: { certificates: [A, B, C] } });
    await confirmAll(h, rows);
    expect(bodyOf(h.qualifications.replaceForWorker)["certificates"]).toEqual([B, C]);
  });

  it("identical twin entries: deleting the second leaves exactly one", async () => {
    const rows = [qualRow(1, "certificates", 1, A, { op: "delete" })];
    const h = setup({ proposal: storedProposal({ rows }), qualificationLists: { certificates: [A, A] } });
    await confirmAll(h, rows);
    expect(bodyOf(h.qualifications.replaceForWorker)["certificates"]).toEqual([A]);
  });
});

describe("qualifications — the stale check survives a reorder (P1-CONF-STALE)", () => {
  const EDIT_B_YEAR = qualRow(1, "certificates", 1, B, {
    op: "edit",
    field: "certificate_year",
    value: "2020",
    before: "2018",
  });

  it("the list was REORDERED elsewhere: not stale, and B is the entry edited", async () => {
    const h = setup({
      proposal: storedProposal({ rows: [EDIT_B_YEAR] }),
      // Built against [A, B, C]; the worker reordered the page to [C, A, B] meanwhile.
      qualificationLists: { certificates: [C, A, B] },
    });
    expect((await confirmAll(h, [EDIT_B_YEAR])).kind).toBe("applied");
    expect(bodyOf(h.qualifications.replaceForWorker)["certificates"]).toEqual([C, A, { ...B, year: 2020 }]);
  });

  it("the entry at the same index now has the same year but is ANOTHER certificate: stale", async () => {
    // Index 1 used to be B (2018); a different certificate from 2018 now sits there.
    const other = { ...C, year: 2018 };
    const h = setup({
      proposal: storedProposal({ rows: [EDIT_B_YEAR] }),
      qualificationLists: { certificates: [A, other, C] },
    });
    const result = await confirmAll(h, [EDIT_B_YEAR]);
    expect(result.kind).toBe("stale");
    if (result.kind === "stale") expect(result.turn.reply).toBe(V2_EDIT_STALE.latin);
    expect(h.qualifications.replaceForWorker).not.toHaveBeenCalled();
  });

  it("the entry was edited elsewhere (another field): stale, nothing written", async () => {
    const h = setup({
      proposal: storedProposal({ rows: [EDIT_B_YEAR] }),
      qualificationLists: { certificates: [A, { ...B, issuer: "NCVT" }, C] },
    });
    expect((await confirmAll(h, [EDIT_B_YEAR])).kind).toBe("stale");
    expect(h.db.transaction).not.toHaveBeenCalled();
  });

  it("a card stored before EDIT-ROW-KIND — a certificate field on an education — is stale, never applied", async () => {
    // `undefined ?? null === before: null` used to pass the check, and the apply (by the ref's
    // list) would have deleted the education under a row that said "certificate".
    const misKinded = qualRow(1, "educations", 0, EDU, {
      op: "delete",
      field: "certificate_name",
      before: null,
    });
    const h = setup({
      proposal: storedProposal({ rows: [misKinded] }),
      qualificationLists: { certificates: [A], educations: [EDU] },
    });
    const result = await confirmAll(h, [misKinded]);
    expect(result.kind).toBe("stale");
    expect(h.db.transaction).not.toHaveBeenCalled();
    expect(h.qualifications.replaceForWorker).not.toHaveBeenCalled();
  });

  it("a card stored before the fingerprint existed is stale, never guessed at", async () => {
    const legacy = { ...EDIT_B_YEAR, target: { list: "certificates", index: 1 } };
    const h = setup({
      proposal: storedProposal({ rows: [legacy] }),
      qualificationLists: { certificates: [A, B, C] },
    });
    expect((await confirmAll(h, [legacy])).kind).toBe("stale");
  });
});

describe("qualifications — only the list the worker changed is re-sent (BUG-PARTIAL-LISTS)", () => {
  it("an education edit never re-sends the trainings list the GET withheld a row from", async () => {
    const row = qualRow(1, "educations", 0, EDU, {
      op: "edit",
      field: "education_year",
      value: "2017",
      before: "2016",
    });
    const h = setup({
      proposal: storedProposal({ rows: [row] }),
      qualificationLists: { certificates: [A], educations: [EDU], trainings: [] },
      qualificationsPartial: ["trainings"],
    });
    await confirmAll(h, [row]);
    const body = bodyOf(h.qualifications.replaceForWorker);
    expect(Object.keys(body)).toEqual(["educations"]);
    expect(body["educations"]).toEqual([{ ...EDU, year: 2017 }]);
  });
});

describe("skills — a label is never printed twice (P1-EDIT-NOOP)", () => {
  it("an add of a label already printed (another case) writes the list unchanged", async () => {
    const row: StoredEditProposalRow = {
      row_id: ids(1),
      section: "skills",
      op: "add",
      field: "skill",
      value: "mig welding",
      before: null,
      section_label: "Skills",
      target: null,
    };
    const h = setup({ proposal: storedProposal({ rows: [row] }) });
    await confirmAll(h, [row]);
    expect(h.profiles.setResumeSkillLabels).toHaveBeenCalledWith(
      profileRow().id,
      { skills: ["skill_milling"], skillLabels: ["MIG welding"] },
      h.tx,
    );
  });
});
