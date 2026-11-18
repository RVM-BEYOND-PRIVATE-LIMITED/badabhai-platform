/**
 * #2754 item 11 — the verification report's rules, over the synthetic pilot bundle (3 companies;
 * each with one live job, one paused, one past expiry; two applicants on the live job, one of them
 * already opened by the company; an 18-view starter line that converts and a free line that does
 * not). The BadaBhai side is written by hand, so every kind of difference is one edit away.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseImportCampusCompaniesArgs } from "../import-campus-companies.cli";
import type { CampusBundle } from "./bundle.schema";
import { decideJob } from "./mapping";
import { readCampusBundle } from "./read-bundle";
import { buildSyntheticBundle } from "./synthetic-bundle";
import { compareSides, writeReportFiles, type BadaBhaiFacts, type LedgerFact } from "./verify-report";

const DIR = "/bundle";

function pilotBundle(): CampusBundle {
  const { manifest, texts } = buildSyntheticBundle({ companies: 3, seed: "report-seed" });
  const files = new Map<string, Buffer>();
  for (const [name, text] of Object.entries(texts)) files.set(join(DIR, name), Buffer.from(text, "utf8"));
  files.set(join(DIR, "manifest.json"), Buffer.from(JSON.stringify(manifest), "utf8"));
  return readCampusBundle(DIR, (path) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error("ENOENT");
    return bytes;
  });
}

interface MutableFacts {
  ledger: Map<string, LedgerFact>;
  payerStatus: Map<string, string>;
  postingStatus: Map<string, string>;
  application: Map<string, { action: string; jobPostingId: string | null }>;
  unlockStatus: Map<string, string>;
  lotCredits: Map<string, number>;
}

/** BadaBhai as a clean import leaves it: every record Campus would move, moved. */
function cleanImport(bundle: CampusBundle): MutableFacts {
  const f: MutableFacts = {
    ledger: new Map(),
    payerStatus: new Map(),
    postingStatus: new Map(),
    application: new Map(),
    unlockStatus: new Map(),
    lotCredits: new Map(),
  };
  const moved = (targetId: string): LedgerFact => ({ state: "created", targetId, reason: null });
  for (const c of bundle.companies) {
    f.ledger.set(`company:${c.source_id}`, moved(`payer-${c.source_id}`));
    f.payerStatus.set(`payer-${c.source_id}`, "active");
  }
  const posting = new Map<string, string>();
  for (const j of bundle.jobs) {
    if (!decideJob(j).move) continue;
    posting.set(j.source_id, `posting-${j.source_id}`);
    f.ledger.set(`job:${j.source_id}`, moved(`posting-${j.source_id}`));
    f.postingStatus.set(`posting-${j.source_id}`, "open");
  }
  for (const a of bundle.applications) {
    const postingId = posting.get(a.job_source_id);
    if (!postingId) continue;
    f.ledger.set(`application:${a.source_id}`, moved(`app-${a.source_id}`));
    f.application.set(`app-${a.source_id}`, { action: "applied", jobPostingId: postingId });
    if (a.company_unlocked_at !== null) {
      f.ledger.set(`access:${a.source_id}`, moved(`unlock-${a.source_id}`));
      f.unlockStatus.set(`unlock-${a.source_id}`, "granted");
    }
  }
  for (const l of bundle.unusedPlans) {
    if (l.plan_code !== "starter") continue;
    f.ledger.set(`balance:${l.key}`, moved(`lot-${l.key}`));
    f.lotCredits.set(`lot-${l.key}`, l.cv_views_left ?? 0);
  }
  return f;
}

const facts = (f: MutableFacts): BadaBhaiFacts => f;

describe("compareSides", () => {
  const bundle = pilotBundle();
  const company = bundle.companies[0]!.source_id;
  const liveJob = bundle.jobs.find((j) => j.company_source_id === company && decideJob(j).move)!;
  const external = bundle.applications.find(
    (a) => a.job_source_id === liveJob.source_id && a.candidate.kind === "external",
  )!;
  const student = bundle.applications.find(
    (a) => a.job_source_id === liveJob.source_id && a.candidate.kind === "rvm_student",
  )!;
  const starter = bundle.unusedPlans.find((l) => l.company_source_id === company && l.plan_code === "starter")!;

  it("a clean import has both sides equal and no difference", () => {
    const report = compareSides(bundle, {}, facts(cleanImport(bundle)));
    expect(report.differences).toEqual([]);
    expect(report.totals).toEqual({
      companies: 3,
      companiesOnBadaBhai: 3,
      campusLiveJobs: 3,
      badabhaiOpenPostings: 3,
      campusApplicants: 6,
      badabhaiApplicantsMoved: 6,
      badabhaiApplicantsHeld: 0,
      campusCredits: 54,
      badabhaiCredits: 54,
      explained: 0,
      unexplained: 0,
    });
    expect(report.jobs).toHaveLength(3);
    expect(report.jobs[0]).toMatchObject({ campusApplicants: 2, moved: 2, held: 0, other: 0, postingStatus: "open" });
    expect(report.companies[0]).toMatchObject({ campusOpenedContacts: 1, badabhaiOpenedContacts: 1, ledger: "created" });
  });

  it("paused and expired Campus jobs are not Campus's live jobs, and the free tier is not a credit", () => {
    const report = compareSides(bundle, {}, facts(cleanImport(bundle)));
    for (const line of report.companies) {
      expect(line.campusLiveJobs).toBe(1);
      expect(line.campusCredits).toBe(18);
    }
  });

  it("an import that never ran is all unexplained", () => {
    const empty = cleanImport(bundle);
    empty.ledger.clear();
    const report = compareSides(bundle, {}, facts(empty));
    const codes = new Set(report.differences.filter((d) => !d.explained).map((d) => d.code));
    expect(codes).toEqual(new Set(["company_not_imported", "job_not_imported", "balance_not_imported"]));
    expect(report.totals.unexplained).toBe(3 + 3 + 3);
    // Its applicants are explained by their job, which is itself the unexplained line.
    expect(report.differences.filter((d) => d.scope === "application").every((d) => d.explained)).toBe(true);
    expect(report.totals.companiesOnBadaBhai).toBe(0);
  });

  it("a held applicant is counted as held and is explained by his reason", () => {
    const f = cleanImport(bundle);
    f.ledger.set(`application:${student.source_id}`, { state: "held", targetId: null, reason: "rvm_student_not_moved" });
    const report = compareSides(bundle, {}, facts(f));
    expect(report.differences).toEqual([
      expect.objectContaining({ scope: "application", sourceId: student.source_id, explained: true, code: "rvm_student_not_moved" }),
    ]);
    expect(report.totals).toMatchObject({ badabhaiApplicantsMoved: 5, badabhaiApplicantsHeld: 1, unexplained: 0 });
    expect(report.jobs[0]).toMatchObject({ moved: 1, held: 1 });
  });

  it("a company the import kept back is explained, and so are its jobs and lines", () => {
    const f = cleanImport(bundle);
    f.ledger.set(`company:${company}`, { state: "exception", targetId: null, reason: "phone_shared_on_badabhai" });
    f.ledger.set(`job:${liveJob.source_id}`, { state: "skipped", targetId: null, reason: "company_not_placed" });
    for (const a of [external, student]) {
      f.ledger.set(`application:${a.source_id}`, { state: "skipped", targetId: null, reason: "job_not_moved" });
      f.ledger.delete(`access:${a.source_id}`);
    }
    f.ledger.set(`balance:${starter.key}`, { state: "skipped", targetId: null, reason: "company_not_placed" });
    const report = compareSides(bundle, {}, facts(f));
    expect(report.totals.unexplained).toBe(0);
    expect(report.differences.map((d) => d.code).sort()).toEqual(
      ["company_not_placed", "company_not_placed", "job_not_moved", "job_not_moved", "phone_shared_on_badabhai"].sort(),
    );
    expect(report.companies[0]).toMatchObject({ ledger: "exception:phone_shared_on_badabhai", payerId: null });
  });

  it("a BadaBhai row that is gone or changed since the import is unexplained, whatever the ledger says", () => {
    const f = cleanImport(bundle);
    f.payerStatus.set(`payer-${company}`, "archived");
    f.postingStatus.set(`posting-${liveJob.source_id}`, "closed");
    f.application.delete(`app-${student.source_id}`);
    f.unlockStatus.delete(`unlock-${external.source_id}`);
    f.lotCredits.set(`lot-${starter.key}`, 5);
    const report = compareSides(bundle, {}, facts(f));
    expect(report.differences.filter((d) => !d.explained).map((d) => d.code).sort()).toEqual(
      ["access_missing", "account_archived", "application_missing", "lot_credits_differ", "posting_closed"].sort(),
    );
    expect(report.companies[0]).toMatchObject({ badabhaiOpenPostings: 0, badabhaiCredits: 5, unexplained: 5 });
  });

  it("an application moved onto another posting, or turned into a skip, is changed", () => {
    const f = cleanImport(bundle);
    f.application.set(`app-${student.source_id}`, { action: "skipped", jobPostingId: `posting-${liveJob.source_id}` });
    f.application.set(`app-${external.source_id}`, { action: "applied", jobPostingId: "posting-other" });
    const report = compareSides(bundle, {}, facts(f));
    expect(report.differences.map((d) => d.code)).toEqual(["application_changed", "application_changed"]);
  });

  it("a matched account and a reused application count as moved", () => {
    const f = cleanImport(bundle);
    f.ledger.set(`company:${company}`, { state: "matched", targetId: `payer-${company}`, reason: null });
    f.ledger.set(`application:${student.source_id}`, { state: "matched", targetId: `app-${student.source_id}`, reason: null });
    expect(compareSides(bundle, {}, facts(f)).differences).toEqual([]);
  });
});

describe("writeReportFiles", () => {
  const bundle = pilotBundle();

  it("writes the three files with ids, counts and codes, and no personal detail", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "campus-report-")), "out");
    const f = cleanImport(bundle);
    f.ledger.clear();
    writeReportFiles(dir, compareSides(bundle, {}, facts(f)));
    expect(readdirSync(dir).sort()).toEqual(["companies.csv", "differences.csv", "jobs.csv"]);
    const all = ["companies.csv", "differences.csv", "jobs.csv"].map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
    expect(all.split("\n")[0]).toMatch(/^company_source_id,campus_moves,ledger,/);
    for (const c of bundle.companies) {
      expect(all).not.toContain(c.name);
      if (c.contact.email) expect(all).not.toContain(c.contact.email);
      if (c.proven_phone.value) expect(all).not.toContain(c.proven_phone.value);
    }
    for (const a of bundle.applications) {
      if (a.candidate.kind === "external" && a.candidate.phone) expect(all).not.toContain(a.candidate.phone);
    }
    expect(all).not.toMatch(/@/);
  });

  it("refuses a folder that already holds something", () => {
    const dir = mkdtempSync(join(tmpdir(), "campus-report-"));
    writeFileSync(join(dir, "old.csv"), "x");
    expect(() => writeReportFiles(dir, compareSides(bundle, {}, facts(cleanImport(bundle))))).toThrow("is not empty");
  });
});

describe("the --report arguments", () => {
  it("needs a batch key and a bundle, and names a default folder", () => {
    expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", "--report"])).toThrow("--report needs --batch");
    expect(parseImportCampusCompaniesArgs(["--bundle", "x", "--report", "--batch", "pilot-1"])).toEqual({
      mode: "report",
      bundle: "x",
      planQuota: {},
      batch: "pilot-1",
      out: "campus-import-report-pilot-1",
    });
    expect(
      parseImportCampusCompaniesArgs(["--bundle", "x", "--report", "--batch", "pilot-1", "--out", "r"]),
    ).toMatchObject({ out: "r" });
  });

  it("is read only: it refuses every apply flag, and --out alone", () => {
    const base = ["--bundle", "x", "--report", "--batch", "pilot-1"];
    expect(() => parseImportCampusCompaniesArgs([...base, "--apply"])).toThrow("cannot be combined");
    expect(() => parseImportCampusCompaniesArgs([...base, "--run-by", "me"])).toThrow("needs --apply");
    expect(() => parseImportCampusCompaniesArgs([...base, "--worker-hold-live"])).toThrow("need --apply");
    expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", "--out", "r"])).toThrow("--out needs --report");
  });
});
