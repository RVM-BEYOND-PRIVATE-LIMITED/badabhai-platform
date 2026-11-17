/**
 * #2754 part 1 — the Campus bundle reader, the mapping rules and the dry-run plan. Pure: the bundle
 * is built in memory (`buildSyntheticBundle`, the same format Campus writes) and read through an
 * injected byte reader, so nothing touches the disk or a database.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CampusApplication, CampusCompany, CampusJob, CampusLogin, CampusUnusedPlan } from "./bundle.schema";
import { buildImportPlan } from "./plan";
import {
  campusPhoneToE164,
  decideApplication,
  decideBalance,
  decideCompany,
  decideJob,
  IMPORTED_JOB_AUDIENCE,
} from "./mapping";
import { CampusBundleError, readCampusBundle } from "./read-bundle";
import { buildSyntheticBundle, syntheticId } from "./synthetic-bundle";
import { formatImportPlan, parseImportCampusCompaniesArgs } from "../import-campus-companies.cli";

const DIR = "/bundle";

/** An in-memory bundle folder: file name -> bytes. */
function folder(manifest: Record<string, unknown>, texts: Record<string, string>): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const [name, text] of Object.entries(texts)) files.set(join(DIR, name), Buffer.from(text, "utf8"));
  files.set(join(DIR, "manifest.json"), Buffer.from(JSON.stringify(manifest), "utf8"));
  return files;
}

function reader(files: Map<string, Buffer>) {
  return (path: string): Buffer => {
    const bytes = files.get(path);
    if (!bytes) throw new Error("ENOENT");
    return bytes;
  };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function synthetic(companies = 3) {
  return buildSyntheticBundle({ companies, seed: "test-seed" });
}

/** Re-seal one file after editing it, so only the check under test can fail. */
function reseal(manifest: Record<string, unknown>, name: string, text: string, records: number) {
  const files = { ...(manifest.files as Record<string, unknown>), [name]: { records, sha256: sha(text) } };
  return { ...manifest, files };
}

describe("readCampusBundle: a well-formed bundle", () => {
  it("reads every file of a synthetic bundle with every check on", () => {
    const { manifest, texts } = synthetic(3);
    const bundle = readCampusBundle(DIR, reader(folder(manifest, texts)));
    expect(bundle.companies).toHaveLength(3);
    expect(bundle.jobs).toHaveLength(9);
    expect(bundle.applications).toHaveLength(6);
    expect(bundle.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a job and an application Campus never updated (updated_at null, as Campus writes it)", () => {
    const { manifest, texts } = synthetic(1);
    let sealed: Record<string, unknown> = manifest;
    const edited = { ...texts };
    for (const name of ["jobs.jsonl", "applications.jsonl"]) {
      const rows = texts[name]!.trim().split("\n").map((l) => JSON.parse(l));
      for (const r of rows) r.updated_at = null;
      const text = `${rows.map((r: unknown) => JSON.stringify(r)).join("\n")}\n`;
      edited[name] = text;
      sealed = reseal(sealed, name, text, rows.length);
    }
    const bundle = readCampusBundle(DIR, reader(folder(sealed, edited)));
    expect(bundle.jobs[0]!.updated_at).toBeNull();
    expect(bundle.applications[0]!.updated_at).toBeNull();
  });

  it("is deterministic: the same seed gives the same manifest hash", () => {
    const a = synthetic(3);
    const b = synthetic(3);
    expect(readCampusBundle(DIR, reader(folder(a.manifest, a.texts))).manifestSha256).toBe(
      readCampusBundle(DIR, reader(folder(b.manifest, b.texts))).manifestSha256,
    );
  });
});

describe("readCampusBundle: refusals", () => {
  it("refuses another format or version", () => {
    const { manifest, texts } = synthetic(1);
    expect(() => readCampusBundle(DIR, reader(folder({ ...manifest, version: 2 }, texts)))).toThrow(
      CampusBundleError,
    );
    expect(() =>
      readCampusBundle(DIR, reader(folder({ ...manifest, format: "something-else" }, texts))),
    ).toThrow(/manifest.json: format/);
  });

  it("refuses a file whose bytes do not hash to the manifest", () => {
    const { manifest, texts } = synthetic(1);
    const edited = { ...texts, "companies.jsonl": texts["companies.jsonl"]!.replace("Pilot", "Pilox") };
    expect(() => readCampusBundle(DIR, reader(folder(manifest, edited)))).toThrow(
      "companies.jsonl: sha256 does not match the manifest",
    );
  });

  it("refuses a record count that differs from the manifest", () => {
    const { manifest, texts } = synthetic(1);
    const text = texts["jobs.jsonl"]!;
    const sealed = reseal(manifest, "jobs.jsonl", text, 99);
    expect(() => readCampusBundle(DIR, reader(folder(sealed, texts)))).toThrow(
      "jobs.jsonl: 3 records on disk, the manifest says 99",
    );
  });

  it("refuses a missing file", () => {
    const { manifest, texts } = synthetic(1);
    const files = folder(manifest, texts);
    files.delete(join(DIR, "logins.jsonl"));
    expect(() => readCampusBundle(DIR, reader(files))).toThrow("logins.jsonl: listed in the manifest but cannot be read");
  });

  it("names the field path of a bad record and never its value", () => {
    const { manifest, texts } = synthetic(1);
    const rows = texts["companies.jsonl"]!.trim().split("\n").map((l) => JSON.parse(l));
    rows[0].approval_status = "rejected-and-secret-9876543210";
    const text = `${rows.map((r: unknown) => JSON.stringify(r)).join("\n")}\n`;
    const sealed = reseal(manifest, "companies.jsonl", text, rows.length);
    let message = "";
    try {
      readCampusBundle(DIR, reader(folder(sealed, { ...texts, "companies.jsonl": text })));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("companies.jsonl line 1: approval_status");
    expect(message).not.toContain("9876543210");
    expect(message).not.toContain("secret");
  });

  it("refuses an application whose job belongs to another company", () => {
    const { manifest, texts } = synthetic(2);
    const rows = texts["applications.jsonl"]!.trim().split("\n").map((l) => JSON.parse(l));
    rows[0].company_source_id = syntheticId("test-seed", "company:2");
    const text = `${rows.map((r: unknown) => JSON.stringify(r)).join("\n")}\n`;
    const sealed = reseal(manifest, "applications.jsonl", text, rows.length);
    expect(() => readCampusBundle(DIR, reader(folder(sealed, { ...texts, "applications.jsonl": text })))).toThrow(
      "applications.jsonl line 1: company_source_id is not the job's company",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The mapping rules
// ---------------------------------------------------------------------------------------------

const companyBase: CampusCompany = {
  source_id: "c1",
  name: "Acme",
  approval_status: "approved",
  approved_at: null,
  created_at: "2026-11-01T00:00:00Z",
  sign_in_phone: { value: "9876543210", class: "good", source: "owner_login" },
  proven_phone: { value: "9876543210", verified_at: "2026-11-01T00:00:00Z" },
  contact: { name: null, email: "hr@acme.example", phone: null },
  profile: {},
  gst: { gstin: null },
  counts: { jobs: 0, applications_moving: 0, applications_held: 0 },
};
const ownerEmail: CampusLogin = {
  source_id: "l1",
  company_source_id: "c1",
  kind: "owner",
  type: "email",
  value: "Owner@Acme.example",
  verified_at: null,
};

describe("campusPhoneToE164", () => {
  it("takes a 10-digit mobile, with or without 91", () => {
    expect(campusPhoneToE164("9876543210")).toBe("+919876543210");
    expect(campusPhoneToE164("919876543210")).toBe("+919876543210");
    expect(campusPhoneToE164("+91 98765 43210")).toBe("+919876543210");
  });

  it("refuses anything that is not an Indian mobile", () => {
    for (const v of [null, "", "0123456789", "5876543210", "98765", "1234567890123"]) {
      expect(campusPhoneToE164(v)).toBeNull();
    }
  });
});

describe("decideCompany", () => {
  it("approved on Campus is verified; the owner login's e-mail wins, lower-cased", () => {
    const d = decideCompany(companyBase, [ownerEmail]);
    expect(d).toMatchObject({ move: true, verification: "verified", email: "owner@acme.example" });
  });

  it("pending on Campus stays pending", () => {
    expect(decideCompany({ ...companyBase, approval_status: "pending" }, [])).toMatchObject({
      move: true,
      verification: "pending",
    });
  });

  it("only Campus's proven owner phone is recorded as proven (Prakash, 17 Nov)", () => {
    expect(decideCompany(companyBase, [])).toMatchObject({ phone: "+919876543210", phoneProven: true });
    const unproven = { ...companyBase, proven_phone: { value: null, verified_at: null } };
    expect(decideCompany(unproven, [])).toMatchObject({ phone: "+919876543210", phoneProven: false });
  });

  it("a shared or candidate's number is not stored: e-mail sign-in stays", () => {
    for (const cls of ["shared", "candidate_number"] as const) {
      const c = {
        ...companyBase,
        proven_phone: { value: null, verified_at: null },
        sign_in_phone: { value: "9876543210", class: cls, source: "contact_phone" },
      };
      expect(decideCompany(c, [])).toMatchObject({
        move: true,
        phone: null,
        phoneProven: false,
        noPhoneReason: `sign_in_phone_${cls}`,
      });
    }
  });

  it("no phone and no e-mail is an exception", () => {
    const c = {
      ...companyBase,
      proven_phone: { value: null, verified_at: null },
      sign_in_phone: { value: null, class: "missing" as const, source: null },
      contact: { name: null, email: null, phone: null },
    };
    expect(decideCompany(c, [])).toEqual({ move: false, reason: "no_contact" });
  });
});

describe("decideJob", () => {
  const job = { status: "active", past_expiry: false } as CampusJob;
  it("only active, unexpired jobs move", () => {
    expect(decideJob(job)).toEqual({ move: true });
    expect(decideJob({ ...job, status: "paused" })).toEqual({ move: false, reason: "job_paused" });
    expect(decideJob({ ...job, status: "pending_approval" })).toEqual({ move: false, reason: "job_pending_approval" });
    expect(decideJob({ ...job, past_expiry: true })).toEqual({ move: false, reason: "job_past_expiry" });
  });

  it("every moved job is for both audiences, held from workers until an admin opens it (#2891)", () => {
    expect(IMPORTED_JOB_AUDIENCE).toBe("both");
  });
});

describe("decideApplication", () => {
  const app = (status: string, candidate: CampusApplication["candidate"]): CampusApplication => ({
    source_id: "a1",
    job_source_id: "j1",
    company_source_id: "c1",
    status,
    applied_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    company_unlocked_at: null,
    candidate,
  });
  const external = { source_id: "p1", kind: "external" as const, name: "X", phone: "9876543210", email: null };
  const rvm = { source_id: "p2", kind: "rvm_student" as const, student_ref: "s1" };

  it.each([
    ["applied", "new"],
    ["pending", "new"],
    ["under_review", "new"],
    ["shortlisted", "shortlist"],
    ["interview_scheduled", "shortlist"],
    ["on_hold", "shortlist"],
    ["offered", "selected"],
    ["selected", "selected"],
    ["hired", "hired"],
    ["rejected", "passed"],
  ])("Campus %s is the %s stage", (status, stage) => {
    expect(decideApplication(app(status, rvm))).toEqual({ move: true, stage, candidate: "rvm_student" });
  });

  it("withdrawn does not move; an unknown status is an exception", () => {
    expect(decideApplication(app("withdrawn", rvm))).toEqual({ move: false, reason: "application_withdrawn" });
    expect(decideApplication(app("ghosted", rvm))).toEqual({ move: false, reason: "application_status_unmapped" });
  });

  it("an outside candidate needs a phone (a worker row has one; no placeholder exists)", () => {
    expect(decideApplication(app("applied", { ...external, phone: null }))).toEqual({
      move: false,
      reason: "applicant_no_phone",
    });
    expect(decideApplication(app("applied", external))).toMatchObject({ move: true, candidate: "external" });
  });
});

describe("decideBalance", () => {
  const line = (over: Partial<CampusUnusedPlan>): CampusUnusedPlan =>
    ({ key: "k", line: "cv_views_in_wallet", company_source_id: "c1", plan_code: "starter", ...over }) as CampusUnusedPlan;

  it("unused CV views convert one for one", () => {
    expect(decideBalance(line({ cv_views_left: 7 }), {})).toEqual({ convert: true, credits: 7 });
    expect(decideBalance(line({ line: "cv_views_left_on_plan_jobs", cv_views_left: 3 }), {})).toEqual({
      convert: true,
      credits: 3,
    });
  });

  it("nothing left, the free tier and a never-registered payment convert nothing", () => {
    expect(decideBalance(line({ cv_views_left: 0 }), {})).toEqual({ convert: false, reason: "nothing_left" });
    expect(decideBalance(line({ plan_code: "free", cv_views_left: 5 }), {})).toEqual({
      convert: false,
      reason: "free_tier_not_converted",
    });
    expect(decideBalance(line({ line: "payment_never_registered", company_source_id: undefined }), {})).toEqual({
      convert: false,
      reason: "payment_never_registered",
    });
  });

  it("a paid plan never posted converts its full quota, and an unknown plan is never guessed", () => {
    const never = line({ line: "paid_plan_never_posted", plan_code: "growth" });
    expect(decideBalance(never, { growth: 30 })).toEqual({ convert: true, credits: 30 });
    expect(decideBalance(never, {})).toEqual({ convert: false, reason: "plan_quota_unknown" });
  });
});

// ---------------------------------------------------------------------------------------------
// The dry-run plan and its printout
// ---------------------------------------------------------------------------------------------

describe("buildImportPlan over the synthetic pilot bundle", () => {
  const { manifest, texts } = synthetic(3);
  const bundle = readCampusBundle(DIR, reader(folder(manifest, texts)));
  const plan = buildImportPlan(bundle);

  it("places all three companies: two with a proven phone, one e-mail only", () => {
    expect(plan.companies).toMatchObject({ total: 3, toPlace: 3, exceptions: {} });
    expect(plan.phones).toEqual({ proven: 2, unproven: 0, none: { sign_in_phone_missing: 1 } });
    expect(plan.verification).toEqual({ verified: 2, pending: 1 });
  });

  it("moves the active job only, and both of its applications", () => {
    expect(plan.jobs).toEqual({ total: 9, move: 3, skipped: { job_past_expiry: 3, job_paused: 3 } });
    expect(plan.applications).toMatchObject({ move: 6, rvmStudents: 3, external: 3, heldOnCampus: 3 });
    expect(plan.carriedAccess).toBe(3);
  });

  it("converts the plan-job views and not the free tier", () => {
    expect(plan.balances).toEqual({
      lines: 6,
      convert: 3,
      credits: 54,
      skipped: { free_tier_not_converted: 3 },
    });
  });

  it("prints counts and Campus ids only: no name, phone or e-mail from the bundle", () => {
    const printed = formatImportPlan(plan).join("\n");
    for (const c of bundle.companies) {
      expect(printed).not.toContain(c.name);
      if (c.proven_phone.value) expect(printed).not.toContain(c.proven_phone.value);
      if (c.contact.email) expect(printed).not.toContain(c.contact.email);
    }
    for (const a of bundle.applications) {
      if (a.candidate.kind === "external") {
        expect(printed).not.toContain(a.candidate.name!);
        expect(printed).not.toContain(a.candidate.phone!);
      }
    }
    expect(printed).toContain(bundle.companies[0]!.source_id);
  });
});

describe("the CLI arguments", () => {
  it("needs a bundle for the dry run", () => {
    expect(() => parseImportCampusCompaniesArgs([])).toThrow("--bundle <folder> is required");
    expect(parseImportCampusCompaniesArgs(["--bundle", "x"])).toEqual({ mode: "plan", bundle: "x", planQuota: {} });
  });

  it("refuses --report and --rollback until their parts are built", () => {
    for (const flag of ["--report", "--rollback"]) {
      expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", flag])).toThrow("is not built yet");
    }
  });

  it("--apply needs a batch key and who is running it", () => {
    expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", "--apply"])).toThrow("--batch <key>");
    expect(() =>
      parseImportCampusCompaniesArgs(["--bundle", "x", "--apply", "--batch", "Bad Key"]),
    ).toThrow("--batch <key>");
    expect(() =>
      parseImportCampusCompaniesArgs(["--bundle", "x", "--apply", "--batch", "pilot-1"]),
    ).toThrow("--run-by");
    expect(
      parseImportCampusCompaniesArgs(["--bundle", "x", "--apply", "--batch", "pilot-1", "--run-by", "prakash", "--test"]),
    ).toEqual({
      mode: "apply",
      bundle: "x",
      planQuota: {},
      batch: "pilot-1",
      runBy: "prakash",
      testReason: "pilot_test",
      agents: [],
      creditValidityDays: 30,
    });
  });

  it("--test and --rehearsal are exclusive, and batch flags need --apply", () => {
    expect(() =>
      parseImportCampusCompaniesArgs(["--bundle", "x", "--apply", "--batch", "b", "--run-by", "p", "--test", "--rehearsal"]),
    ).toThrow("cannot be combined");
    expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", "--batch", "b"])).toThrow("--batch needs --apply");
    expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", "--test"])).toThrow("need --apply");
  });

  it("refuses an unknown flag rather than guessing", () => {
    expect(() => parseImportCampusCompaniesArgs(["--bundle", "x", "--force"])).toThrow();
  });

  it("needs a seed to write a synthetic bundle", () => {
    expect(() => parseImportCampusCompaniesArgs(["--write-synthetic", "out"])).toThrow("--seed is required");
    expect(parseImportCampusCompaniesArgs(["--write-synthetic", "out", "--seed", "s"])).toEqual({
      mode: "synthetic",
      out: "out",
      companies: 3,
      seed: "s",
      phones: [],
    });
  });
});
