/**
 * Migration 0162 — job audience, RVM review state, targeting options, campus-drive requests and
 * the pilot list (#2746).
 *
 * Pinned: additive only (no DROP, UPDATE, DELETE, RENAME or ALTER COLUMN); each new table's
 * deny-by-default lock (ENABLE + hand-appended FORCE + four REVOKEs, the part a regenerate
 * drops); the closed sets in the CHECKs agreeing with the exported constants; the LIVE model
 * agreeing with the file; the operator instructions (apply-before-MERGE, rollback); the
 * schema-contract entries; the key-rotation targets; and the slot. Nothing here connects to a
 * database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { CAMPUS_DRIVE_REQUEST_STATUSES, campusDriveRequests } from "./schema/campus-drive";
import { featurePilotPayers } from "./schema/feature-pilot";
import { JOB_POSTING_AUDIENCES, jobPostings } from "./schema/job";
import {
  INSTITUTE_REVIEW_STATES,
  jobPostingInstituteReviews,
  rvmTargetingOptions,
} from "./schema/job-audience";
import { payers } from "./schema/payer";

const TAG = "0162_job_audience_campus_drives";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const ROTATION = readFileSync(join(__dirname, "reencrypt-pii-backfill.ts"), "utf8");

const statements = FLAT.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// String scan, not a dynamic RegExp (semgrep detect-non-literal-regexp; the 0133 precedent).
const statementFor = (needle: string): string => statements.find((s) => s.includes(needle)) ?? "";

const NEW_TABLES = [
  "job_posting_institute_reviews",
  "rvm_targeting_options",
  "campus_drive_requests",
  "feature_pilot_payers",
] as const;

const quotedList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

describe("the fixture is real", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header DISCUSSES the rollback DROPs, which a naive scan would read as statements.
    expect(RAW).toContain("only AFTER rolling the API back");
    expect(DDL).not.toContain("only AFTER rolling the API back");
  });
});

describe("0162 is additive only", () => {
  it("opens with the short lock_timeout", () => {
    expect(statements[0]).toBe("SET lock_timeout='3s'");
  });

  it("drops, rewrites and renames nothing", () => {
    // Statement-leading verbs, so a foreign key's `ON UPDATE NO ACTION` is not a write.
    for (const statement of statements) {
      for (const verb of ["DROP ", "UPDATE ", "INSERT ", "DELETE ", "TRUNCATE"]) {
        expect(statement.toUpperCase().startsWith(verb), statement).toBe(false);
      }
    }
    for (const clause of [" DROP ", "RENAME", "ALTER COLUMN"]) {
      expect(FLAT.toUpperCase(), clause).not.toContain(clause);
    }
  });

  it("adds the four columns NOT NULL with a catalog-only default", () => {
    expect(statementFor('"job_postings" ADD COLUMN "audience"')).toContain(
      "text DEFAULT 'badabhai_workers' NOT NULL",
    );
    expect(statementFor('"job_postings" ADD COLUMN "rvm_branch_ids"')).toContain(
      "jsonb DEFAULT '[]'::jsonb NOT NULL",
    );
    expect(statementFor('"job_postings" ADD COLUMN "rvm_course_ids"')).toContain(
      "jsonb DEFAULT '[]'::jsonb NOT NULL",
    );
    expect(statementFor('"payers" ADD COLUMN "is_test_account"')).toContain(
      "boolean DEFAULT false NOT NULL",
    );
  });
});

describe("every new table is locked", () => {
  it.each(NEW_TABLES)("%s: ENABLE + FORCE + the four REVOKEs", (table) => {
    expect(FLAT).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT, role).toContain(`REVOKE ALL ON TABLE "${table}" FROM ${role}`);
    }
  });
});

describe("the closed sets match the exported constants", () => {
  it("job_postings_audience_chk is JOB_POSTING_AUDIENCES", () => {
    expect(statementFor("job_postings_audience_chk")).toContain(
      `IN (${quotedList(JOB_POSTING_AUDIENCES)})`,
    );
  });

  it("jpir_state_chk is INSTITUTE_REVIEW_STATES", () => {
    expect(statementFor('CREATE TABLE "job_posting_institute_reviews"')).toContain(
      `IN (${quotedList(INSTITUTE_REVIEW_STATES)})`,
    );
  });

  it("cdr_status_chk is CAMPUS_DRIVE_REQUEST_STATUSES", () => {
    expect(statementFor('CREATE TABLE "campus_drive_requests"')).toContain(
      `IN (${quotedList(CAMPUS_DRIVE_REQUEST_STATUSES)})`,
    );
  });

  it("an agency twin stays a BadaBhai-worker job", () => {
    expect(statementFor("job_postings_twin_audience_chk")).toContain(
      `"job_postings"."sync_source" IS NULL OR "job_postings"."audience" = 'badabhai_workers'`,
    );
  });
});

describe("the review findings are pinned (migration-reviewer + security-reviewer, 2026-11-13)", () => {
  const reviews = statementFor('CREATE TABLE "job_posting_institute_reviews"');
  const drives = statementFor('CREATE TABLE "campus_drive_requests"');
  const pilots = statementFor('CREATE TABLE "feature_pilot_payers"');

  it("a narrowed list is never empty, so a review cannot widen to every branch", () => {
    expect(reviews).toContain(
      `jsonb_array_length("job_posting_institute_reviews"."branch_ids") BETWEEN 1 AND 50`,
    );
    expect(reviews).toContain(
      `jsonb_array_length("job_posting_institute_reviews"."course_ids") BETWEEN 1 AND 100`,
    );
  });

  it("staff refs are uuids, so a name or email cannot be stored in them", () => {
    const uuid =
      "~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'";
    expect(reviews).toContain(`"job_posting_institute_reviews"."reviewer_ref" ${uuid}`);
    expect(drives).toContain(`"campus_drive_requests"."decided_by_ref" ${uuid}`);
  });

  it("the drive contact can be erased without deleting the request", () => {
    expect(drives).toContain('"contact_name_enc" text,');
    expect(drives).toContain('"contact_phone_enc" text,');
    expect(drives).toContain('"contact_erased_at" timestamp with time zone');
    expect(drives).toContain("cdr_contact_chk");
  });

  it("every pilot entry records who added it and why", () => {
    expect(pilots).toContain('"added_by" text NOT NULL');
    expect(pilots).toContain('"reason" text NOT NULL');
  });

  it("Campus's feed index is on the review rows, and job_postings gains no index", () => {
    expect(FLAT).toContain(
      'CREATE INDEX "jpir_feed_idx" ON "job_posting_institute_reviews" USING btree ("institute_code","updated_at","job_posting_id")',
    );
    expect(FLAT).not.toContain('ON "job_postings" USING');
  });
});

describe("the LIVE model carries the same objects", () => {
  const columnsOf = (table: Parameters<typeof getTableConfig>[0]) =>
    getTableConfig(table).columns.map((c) => c.name);

  it("job_postings and payers gain the four columns", () => {
    expect(columnsOf(jobPostings)).toEqual(
      expect.arrayContaining(["audience", "rvm_branch_ids", "rvm_course_ids"]),
    );
    expect(columnsOf(payers)).toContain("is_test_account");
  });

  it("the four tables exist with RLS enabled in the model", () => {
    for (const table of [
      jobPostingInstituteReviews,
      rvmTargetingOptions,
      campusDriveRequests,
      featurePilotPayers,
    ]) {
      const config = getTableConfig(table);
      expect(NEW_TABLES).toContain(config.name);
      expect(config.enableRLS, config.name).toBe(true);
    }
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  it("says apply-before-MERGE and gives the rollback for every object", () => {
    expect(RAW).toContain("APPLY-BEFORE-MERGE");
    expect(RAW).toContain("protection rule");
    expect(RAW).toContain("ROLLBACK");
    for (const table of NEW_TABLES) {
      expect(RAW, table).toContain(`DROP TABLE IF EXISTS "${table}"`);
    }
    for (const column of ["audience", "rvm_branch_ids", "rvm_course_ids", "is_test_account"]) {
      expect(RAW, column).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    }
  });

  it("registers both hot-path columns in the schema contract", () => {
    const byId = (id: string) => SCHEMA_REQUIREMENTS.find((r) => r.id === id);
    expect(byId("0162-job-postings-audience")).toMatchObject({
      migration: TAG,
      kind: "column",
      table: "job_postings",
      object: "audience",
    });
    expect(byId("0162-payers-is-test-account")).toMatchObject({
      migration: TAG,
      kind: "column",
      table: "payers",
      object: "is_test_account",
    });
    for (const table of NEW_TABLES) {
      const lock = SCHEMA_REQUIREMENTS.find((r) => r.kind === "rls" && r.table === table);
      expect(lock?.migration, table).toBe(TAG);
    }
  });

  it("registers both contact columns for key rotation", () => {
    expect(ROTATION).toContain('"campus_drive_requests",\n      "contact_name_enc"');
    expect(ROTATION).toContain('"campus_drive_requests",\n      "contact_phone_enc"');
  });

  it("holds the only 0162 slot, after #2752 Part B's 0161, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(162);
    expect(JOURNAL.entries.filter((e) => e.idx === 162)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.tag).toBe("0161_institute_link");
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
