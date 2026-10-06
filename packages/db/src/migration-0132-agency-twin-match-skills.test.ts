/**
 * Migration 0132 — `jobs.match_skill_ids` + `job_postings.sync_source` (ADR-0050 §4.1, #1957).
 *
 * Pinned beyond the drift check: additive-only (two columns, three CHECKs, nothing dropped,
 * nothing rewritten, no backfill), each column's nullability/default exactly as the ADR states,
 * each CHECK's predicate, the LIVE model agreeing with the frozen file, the APPLY-BEFORE-DEPLOY
 * instruction and rollback stated, and the slot. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { JOB_POSTING_SYNC_SOURCES, jobPostings, jobs } from "./schema/job";

const TAG = "0132_agency_twin_match_skills";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const statements = FLAT.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// String scan, not a dynamic RegExp (semgrep detect-non-literal-regexp; the 0131 precedent).
const statementFor = (needle: string): string => statements.find((s) => s.includes(needle)) ?? "";

describe("the fixture is real", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("WHAT IT IS NOT.");
    expect(DDL).not.toContain("WHAT IT IS NOT.");
    expect(RAW).toContain('DROP COLUMN "match_skill_ids"');
    expect(DDL).not.toContain("DROP COLUMN");
  });
});

describe("0132 is additive", () => {
  it("is exactly two ADD COLUMN and three ADD CONSTRAINT — and nothing else", () => {
    expect(statements).toHaveLength(5);
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(2);
    expect((FLAT.match(/ADD CONSTRAINT/g) ?? []).length).toBe(3);
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)].sort()).toEqual(["job_postings", "jobs"]);
  });

  it("drops, rewrites and backfills nothing — and adds no index", () => {
    const upper = FLAT.toUpperCase();
    for (const verb of [
      "DROP ",
      "UPDATE ",
      "INSERT ",
      "DELETE ",
      "TRUNCATE",
      "RENAME",
      "ALTER COLUMN",
      "CREATE INDEX",
      "CREATE UNIQUE INDEX",
    ]) {
      expect(upper, verb).not.toContain(verb);
    }
  });

  it("jobs.match_skill_ids is NOT NULL DEFAULT '[]' — every existing row reads 'not chosen yet'", () => {
    const line = statementFor('"jobs" ADD COLUMN "match_skill_ids"');
    expect(line).toContain("jsonb");
    expect(line).toContain("DEFAULT '[]'::jsonb");
    expect(line).toContain("NOT NULL");
  });

  it("job_postings.sync_source is NULLABLE with no default — native rows stay NULL", () => {
    const line = statementFor('"job_postings" ADD COLUMN "sync_source"');
    expect(line).toContain("text");
    expect(line).not.toContain("NOT NULL");
    expect(line).not.toContain("DEFAULT");
  });
});

describe("the three CHECKs in the migration — a FROZEN record", () => {
  it("jobs_match_skill_ids_array_chk pins the column to a JSON array", () => {
    expect(statementFor('"jobs_match_skill_ids_array_chk"')).toContain(
      `jsonb_typeof("jobs"."match_skill_ids") = 'array'`,
    );
  });

  it("job_postings_sync_source_chk is NULL-tolerant and closes the set on 'agency_job'", () => {
    const text = statementFor('"job_postings_sync_source_chk"');
    expect(text).toContain(`"job_postings"."sync_source" IS NULL`);
    expect(text).toContain(`"job_postings"."sync_source" = 'agency_job'`);
  });

  it("job_postings_twin_owner_chk pins C2: a twin is linked and never payer-owned", () => {
    const text = statementFor('"job_postings_twin_owner_chk"');
    expect(text).toContain(`"job_postings"."sync_source" IS NULL OR`);
    expect(text).toContain(`"job_postings"."source_job_id" IS NOT NULL`);
    expect(text).toContain(`"job_postings"."payer_id" IS NULL`);
  });
});

describe("the LIVE model carries the same columns and CHECKs", () => {
  const dialect = new PgDialect();
  const checkSql = (table: typeof jobPostings | typeof jobs, name: string): string => {
    const check = getTableConfig(table).checks.find((c) => c.name === name);
    if (!check) throw new Error(`${name} is not on the model`);
    return dialect.sqlToQuery(check.value).sql;
  };

  it("models both columns with the migration's nullability", () => {
    const jobCol = getTableConfig(jobs).columns.find((c) => c.name === "match_skill_ids");
    expect(jobCol?.notNull).toBe(true);
    expect(jobCol?.hasDefault).toBe(true);
    const postingCol = getTableConfig(jobPostings).columns.find((c) => c.name === "sync_source");
    expect(postingCol?.notNull).toBe(false);
    expect(postingCol?.hasDefault).toBe(false);
  });

  it("models all three CHECKs", () => {
    expect(checkSql(jobs, "jobs_match_skill_ids_array_chk")).toContain("jsonb_typeof");
    expect(checkSql(jobPostings, "job_postings_sync_source_chk")).toContain("'agency_job'");
    expect(checkSql(jobPostings, "job_postings_twin_owner_chk")).toContain("IS NOT NULL");
  });

  it("the shared sync-source constant is exactly the CHECK's closed set", () => {
    expect([...JOB_POSTING_SYNC_SOURCES]).toEqual(["agency_job"]);
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  it("says APPLY-BEFORE-DEPLOY and names the bare-select readers that make it so", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    for (const reader of [
      "JobPostingsRepository",
      "AgencyJobsRepository",
      "ApplicationsRepository.findJobById",
    ]) {
      expect(RAW, reader).toContain(reader);
    }
  });

  it("is registered in the schema contract under the ids the header names", () => {
    for (const id of ["0132-jobs-match-skill-ids", "0132-job-postings-sync-source"]) {
      expect(RAW, id).toContain(id);
      const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === id);
      expect(entry?.migration, id).toBe(TAG);
      expect(entry?.kind, id).toBe("column");
    }
  });

  it("states the lock guidance and the rollback", () => {
    expect(RAW).toContain("lock_timeout = '3s'");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain("ROLLBACK");
    for (const c of [
      "job_postings_twin_owner_chk",
      "job_postings_sync_source_chk",
      "jobs_match_skill_ids_array_chk",
    ]) {
      expect(RAW, c).toContain(`DROP CONSTRAINT "${c}"`);
    }
    expect(RAW).toContain('ALTER TABLE "jobs" DROP COLUMN "match_skill_ids"');
    expect(RAW).toContain('ALTER TABLE "job_postings" DROP COLUMN "sync_source"');
  });

  it("holds the only 0132 slot, after 0131, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(132);
    expect(JOURNAL.entries.filter((e) => e.idx === 132)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(131);
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
