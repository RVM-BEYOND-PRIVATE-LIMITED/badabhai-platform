import { describe, expect, it } from "vitest";
import { parseStudentLines, type ParsedStudentLine } from "./campus-student-bundle";
import { parseImportCampusStudentsArgs } from "./import-campus-students.args";
import {
  campusConsentVersionOf,
  decideStudent,
  holdReasonFor,
  type StudentState,
} from "./import-campus-students";
import { syntheticStudent } from "./student-bundle.test-support";

/**
 * #2887 — the import's decisions (pure) and its arguments. The DB writes, the rollback and the
 * end-to-end proof run against Postgres in `campus-link/institute-tag-rules.db.test.ts`.
 */

function line(
  over: Record<string, unknown> = {},
  phone: string | null = "9876500001",
): ParsedStudentLine {
  const parsed = parseStudentLines(JSON.stringify(syntheticStudent("cand-1", phone, over)));
  return parsed.students[0]!;
}
const empty: StudentState = { subject: null, workerOnPhone: null, workerOnPhoneHasSubject: false };

describe("holdReasonFor", () => {
  it.each([
    [{ phone: { value: null, class: "missing" } }, "phone_missing"],
    [{ phone: { value: null, class: "not_mobile" } }, "phone_not_mobile"],
    [{ phone: { value: "9876500001", class: "shared" } }, "phone_shared"],
    [{ phone: { value: "9876500001", class: "company_number" } }, "phone_company_number"],
    [{ adult: false }, "under_18"],
  ])("%j → %s", (over, reason) => {
    expect(holdReasonFor(line(over).student)).toBe(reason);
  });

  it("a good phone and an adult (or unknown age) is not held here", () => {
    expect(holdReasonFor(line().student)).toBeNull();
    expect(holdReasonFor(line({ adult: null }).student)).toBeNull();
  });
});

describe("decideStudent", () => {
  const l = line();
  it("a new phone and a new Campus id: create", () => {
    expect(decideStudent(l, empty)).toEqual({ kind: "create" });
  });

  it("an existing BadaBhai worker on his phone is never taken over", () => {
    expect(decideStudent(l, { ...empty, workerOnPhone: { id: "w-1" } })).toEqual({
      kind: "held",
      reason: "already_badabhai_worker",
      workerId: null,
    });
  });

  it("a phone another moved student holds: held as shared", () => {
    expect(
      decideStudent(l, { ...empty, workerOnPhone: { id: "w-1" }, workerOnPhoneHasSubject: true }),
    ).toEqual({ kind: "held", reason: "phone_shared", workerId: null });
  });

  it("the same record again: unchanged; a changed record: update", () => {
    const subject = { workerId: "w-1", contentHash: l.contentHash };
    const state = { subject, workerOnPhone: { id: "w-1" }, workerOnPhoneHasSubject: true };
    expect(decideStudent(l, state)).toEqual({ kind: "unchanged", workerId: "w-1" });
    expect(decideStudent(line({ city: "Nashik" }), state)).toEqual({
      kind: "update",
      workerId: "w-1",
    });
  });

  it("his phone changed on Campus since the move: held, the login never moves", () => {
    const subject = { workerId: "w-1", contentHash: "x" };
    expect(
      decideStudent(l, { subject, workerOnPhone: null, workerOnPhoneHasSubject: false }),
    ).toEqual({
      kind: "held",
      reason: "phone_changed",
      workerId: "w-1",
    });
    expect(
      decideStudent(l, { subject, workerOnPhone: { id: "w-2" }, workerOnPhoneHasSubject: true }),
    ).toEqual({ kind: "held", reason: "phone_shared", workerId: "w-1" });
  });

  it("a hold reason wins over everything", () => {
    expect(decideStudent(line({ adult: false }), empty)).toEqual({
      kind: "held",
      reason: "under_18",
      workerId: null,
    });
  });
});

describe("campusConsentVersionOf", () => {
  it("the newest Campus consent record's version and date, made safe", () => {
    const s = line({
      consent: {
        basis: "bulk_move_ruling",
        campus_records: [
          { purpose: "rvm_jobs_access", text_version: "v1", given_at: "2026-01-01T00:00:00Z" },
          {
            purpose: "rvm_jobs_access",
            text_version: "v2 (Hindi)",
            given_at: "2026-06-01T00:00:00Z",
          },
        ],
      },
    }).student;
    const out = campusConsentVersionOf(s);
    expect(out.version).toBe("v2__Hindi_");
    expect(out.givenAt?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("no Campus record: the ruling's version and no date (the run's date is used)", () => {
    expect(campusConsentVersionOf(line().student)).toEqual({
      version: "bulk_move_ruling",
      givenAt: null,
    });
  });
});

describe("parseImportCampusStudentsArgs", () => {
  it("a dry run by default", () => {
    expect(parseImportCampusStudentsArgs(["--bundle", "b"])).toEqual({
      kind: "import",
      bundle: "b",
      apply: false,
      batch: null,
      since: false,
      report: null,
      limit: null,
      productionWrite: false,
    });
  });

  it("apply needs a batch label; since and limit pass through", () => {
    expect(() => parseImportCampusStudentsArgs(["--bundle", "b", "--apply"])).toThrow(/--batch/);
    expect(
      parseImportCampusStudentsArgs([
        "--bundle",
        "b",
        "--apply",
        "--batch",
        "bulk move 1",
        "--since",
        "--limit",
        "10",
        "--report",
        "r.json",
      ]),
    ).toMatchObject({
      apply: true,
      batch: "bulk move 1",
      since: true,
      limit: 10,
      report: "r.json",
    });
  });

  it("rollback takes a batch id only", () => {
    const id = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    expect(parseImportCampusStudentsArgs(["--rollback", id])).toEqual({
      kind: "rollback",
      batchId: id,
      report: null,
      productionWrite: false,
    });
    expect(() => parseImportCampusStudentsArgs(["--rollback", "x"])).toThrow(/uuid/);
    expect(() => parseImportCampusStudentsArgs(["--rollback", id, "--apply"])).toThrow(/only/);
  });

  it("refuses unknown flags, positionals, a missing bundle and a bad limit; never takes a passphrase", () => {
    expect(() => parseImportCampusStudentsArgs([])).toThrow(/--bundle/);
    expect(() => parseImportCampusStudentsArgs(["--bundle", "b", "extra"])).toThrow(/unexpected/);
    expect(() => parseImportCampusStudentsArgs(["--bundle", "b", "--passphrase", "x"])).toThrow();
    expect(() => parseImportCampusStudentsArgs(["--bundle", "b", "--limit", "0"])).toThrow(/limit/);
  });

  it("ignores a leading -- forwarded by a package-script run", () => {
    expect(parseImportCampusStudentsArgs(["--", "--bundle", "b"])).toMatchObject({ bundle: "b" });
  });

  it("passes the production write flag through", () => {
    expect(
      parseImportCampusStudentsArgs(["--bundle", "b", "--i-am-authorised-to-write-to-production"]),
    ).toMatchObject({ productionWrite: true });
  });
});
