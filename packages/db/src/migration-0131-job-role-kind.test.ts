/**
 * Migration 0131 — `job_postings.role_kind` + `jobs.role_kind` (ADR-0036 addendum 2026-09-29).
 *
 * The payer's role pick for a posting, over the 21 DECLARED worker-side kinds. Display and
 * classification only — never a match or rank input, on no worker read this phase.
 *
 * Pinned beyond the drift check: additive-only (two nullable columns, two CHECKs, nothing
 * dropped, nothing rewritten, no backfill), both CHECKs NULL-tolerant and closing EXACTLY the 21
 * kinds declared when this was written (a frozen record), the LIVE model's two CHECKs agreeing
 * with the shared `TRADE_FORM_KINDS_ALL` (the tripwire that outlives this file), the
 * APPLY-BEFORE-DEPLOY instruction and rollback stated, and the slot. Nothing here connects to a
 * database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { jobPostings, jobs } from "./schema/job";

const TAG = "0131_job_role_kind";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

/** The 21 declared kinds as of 0131 — `TRADE_FORM_KINDS_ALL` on the day it was written. */
const KINDS_0131 = [
  "cnc_turner",
  "vmc_milling",
  "cnc_grinding",
  "cam_programmer",
  "cad_draughtsman",
  "conventional_machinist",
  "tool_die_maker",
  "welder",
  "sheet_metal_worker",
  "press_operator",
  "painter_coating",
  "fitter",
  "maintenance_technician",
  "industrial_electrician",
  "assembly_line_worker",
  "quality_inspector",
  "injection_moulding_operator",
  "mould_die_maker",
  "blow_moulding_operator",
  "rubber_moulding_operator",
  "plastic_process_technician",
] as const;

const CHECKS = ["job_postings_role_kind_chk", "jobs_role_kind_chk"] as const;

const checkText = (name: string): string =>
  FLAT.match(new RegExp(`"${name}" CHECK[^;]*`))?.[0] ?? "";
const listed = (text: string): string[] =>
  [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);

describe("the fixture is real", () => {
  it("reads a migration that adds both columns and both CHECKs", () => {
    expect(FLAT).toContain('ALTER TABLE "job_postings" ADD COLUMN "role_kind" text');
    expect(FLAT).toContain('ALTER TABLE "jobs" ADD COLUMN "role_kind" text');
    for (const name of CHECKS) expect(listed(checkText(name)).length).toBeGreaterThan(0);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header spells out the rollback's DROP statements; without stripping, the "drops
    // nothing" assertion below would be judged against prose.
    expect(RAW).toContain("WHAT IT IS NOT.");
    expect(DDL).not.toContain("WHAT IT IS NOT.");
    expect(RAW).toContain('DROP COLUMN "role_kind"');
    expect(DDL).not.toContain("DROP COLUMN");
  });
});

describe("0131 is additive", () => {
  it("is exactly two ADD COLUMN and two ADD CONSTRAINT — and nothing else", () => {
    // Split on `;` — the `--> statement-breakpoint` markers are SQL comments, so the header
    // strip above has already removed them from DDL.
    const statements = FLAT.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(4);
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(2);
    expect((FLAT.match(/ADD CONSTRAINT/g) ?? []).length).toBe(2);
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)].sort()).toEqual(["job_postings", "jobs"]);
  });

  it("drops, rewrites and backfills nothing", () => {
    const upper = FLAT.toUpperCase();
    for (const verb of [
      "DROP ",
      "UPDATE ",
      "INSERT ",
      "DELETE ",
      "TRUNCATE",
      "RENAME",
      "ALTER COLUMN",
    ]) {
      expect(upper, verb).not.toContain(verb);
    }
  });

  it("both columns are NULLABLE with no default — catalog-only, no backfill", () => {
    // A default would make every posting that exists today claim a role nobody picked, and a
    // NOT NULL would force exactly that guess onto every chat-published posting.
    for (const table of ["job_postings", "jobs"]) {
      const line = FLAT.match(new RegExp(`"${table}" ADD COLUMN "role_kind"[^;]*`))?.[0] ?? "";
      expect(line, table).not.toBe("");
      expect(line, table).not.toContain("NOT NULL");
      expect(line, table).not.toContain("DEFAULT");
    }
  });
});

describe("the two CHECKs in the migration — a FROZEN record", () => {
  it.each(CHECKS)("%s is NULL-tolerant — 'no role picked' must stay writable", (name) => {
    expect(checkText(name)).toContain("IS NULL");
  });

  it.each(CHECKS)("%s closes EXACTLY the 21 kinds declared when it was written", (name) => {
    // Pinned to a LITERAL, not the live constant: a migration file never changes, so a 22nd
    // declared kind is widened by a NEW migration and must not turn this file's test red. The
    // LIVE agreement is the model test below.
    const kinds = listed(checkText(name));
    expect([...kinds].sort()).toEqual([...KINDS_0131].sort());
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("the two lists are identical — the same vocabulary on both entities", () => {
    expect(listed(checkText(CHECKS[0]))).toEqual(listed(checkText(CHECKS[1])));
  });

  // NOTE: we deliberately do NOT assert `KINDS_0131 === TRADE_FORM_KINDS_ALL` here. A migration is
  // a frozen record, so its literal is pinned to KINDS_0131 (above); the LIVE agreement with the
  // shared constant belongs to the model tripwire below. Tying the frozen literal to the live
  // constant would make this "frozen" test unsatisfiable the day a 22nd kind is declared.
});

describe("the LIVE model — both role_kind CHECKs agree with the shared constant", () => {
  // THE TRIPWIRE THAT OUTLIVES THIS MIGRATION. It reads the drizzle model, not a frozen file, so
  // a 22nd DECLARED kind turns it red until BOTH constraints are widened — the edit 0118 asked
  // for and #1693 forgot on `wri_identity_role_kind_chk` (migration 0124).
  const dialect = new PgDialect();
  const kindsIn = (table: typeof jobPostings | typeof jobs, name: string): string[] => {
    const check = getTableConfig(table).checks.find((c) => c.name === name);
    if (!check) throw new Error(`${name} is not on the model`);
    const text = dialect.sqlToQuery(check.value).sql;
    expect(text, name).toContain("IS NULL");
    return listed(text).sort();
  };

  it("job_postings_role_kind_chk closes exactly TRADE_FORM_KINDS_ALL", () => {
    expect(kindsIn(jobPostings, "job_postings_role_kind_chk")).toEqual(
      [...TRADE_FORM_KINDS_ALL].sort(),
    );
  });

  it("jobs_role_kind_chk closes exactly TRADE_FORM_KINDS_ALL", () => {
    expect(kindsIn(jobs, "jobs_role_kind_chk")).toEqual([...TRADE_FORM_KINDS_ALL].sort());
  });
});

describe("the operator instructions and the slot", () => {
  it("says APPLY-BEFORE-DEPLOY and names the bare-select readers that make it so", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    for (const reader of [
      "JobPostingsRepository",
      "AgencyJobsRepository",
      "ApplicationsRepository.findJobById",
    ]) {
      expect(RAW, reader).toContain(reader);
    }
    expect(RAW).toContain("0131-job-postings-role-kind");
    expect(RAW).toContain("0131-jobs-role-kind");
  });

  it("states the lock guidance and the rollback", () => {
    expect(RAW).toContain("lock_timeout = '3s'");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain("ROLLBACK");
    expect(RAW).toContain('DROP CONSTRAINT "job_postings_role_kind_chk"');
    expect(RAW).toContain('DROP CONSTRAINT "jobs_role_kind_chk"');
    expect(RAW).toContain('ALTER TABLE "job_postings" DROP COLUMN "role_kind"');
    expect(RAW).toContain('ALTER TABLE "jobs" DROP COLUMN "role_kind"');
  });

  it("holds the only 0131 slot, after 0130, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(131);
    expect(JOURNAL.entries.filter((e) => e.idx === 131)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(130);
    // drizzle skips any file whose `when` is at or below the ledger's newest created_at, so a
    // `when` below its predecessor's would be silently skipped wherever 0130 is recorded.
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
