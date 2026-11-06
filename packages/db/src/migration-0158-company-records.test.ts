/**
 * Migration 0158 — company records (#2564 B10): archive-ready statuses + company
 * profile/search columns.
 *
 * Registered in the schema contract from day one — the #2506 lesson (0138 shipped
 * without an entry, auto-deployed ahead of its manual apply, and every payer
 * lookup 500'd). The company writers name every new column explicitly and the
 * archive cascade writes `status = 'archived'`, so the same miss here would 500
 * company create/edit/list/archive/restore (and the narrowed posting CHECK would
 * reject the archive write itself).
 *
 * Pinned: the exact statement set (two CHECK swaps + twelve nullable ADD COLUMNs +
 * one GIN index — nothing dropped, renamed or backfilled in SQL; the word-hash
 * backfill is the `db:backfill:company-name-words` runner), each column's
 * nullability, the LIVE model agreeing with the file, the operator instructions
 * (apply-before-deploy, rollback, the schema-contract id) and the slot. Nothing
 * here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { agencyProfiles, employerProfiles } from "./schema/payer-onboarding";
import { payers } from "./schema/payer";

const TAG = "0158_company_records";
const CONTRACT_ID = "0158-company-records";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const statements = FLAT.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// String scan, not a dynamic RegExp (semgrep detect-non-literal-regexp; the 0133 precedent).
const statementFor = (needle: string): string => statements.find((s) => s.includes(needle)) ?? "";

describe("the fixture is real", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("only AFTER rolling the API back");
    expect(DDL).not.toContain("only AFTER rolling the API back");
  });
});

describe("0158 is additive only", () => {
  it("is two CHECK swaps + eleven nullable ADD COLUMNs + one GIN index", () => {
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(11);
    expect(FLAT).toContain('CREATE INDEX "payers_org_word_hashes_gin_idx"');
    // NOTE: the FK-style clauses carry `ON DELETE … ON UPDATE …` — the quotes pin
    // each verb to a real statement, so referential actions cannot trip this.
    for (const verb of ['DROP "', 'UPDATE "', "INSERT INTO", "DELETE FROM", "TRUNCATE", "RENAME"]) {
      expect(FLAT.toUpperCase(), verb).not.toContain(verb);
    }
  });

  it("every new column is nullable with no default (pre-column rows render honestly)", () => {
    for (const col of [
      '"payers" ADD COLUMN "org_name_word_hashes" text[]',
      '"agency_profiles" ADD COLUMN "gst_number_enc" text',
      '"agency_profiles" ADD COLUMN "gst_number_hash" text',
      '"agency_profiles" ADD COLUMN "website" text',
      '"agency_profiles" ADD COLUMN "city" text',
      '"agency_profiles" ADD COLUMN "address_enc" text',
      '"agency_profiles" ADD COLUMN "contact_name_enc" text',
      '"employer_profiles" ADD COLUMN "gst_number_hash" text',
      '"employer_profiles" ADD COLUMN "city" text',
      '"employer_profiles" ADD COLUMN "address_enc" text',
      '"employer_profiles" ADD COLUMN "contact_name_enc" text',
    ]) {
      const line = statementFor(col);
      expect(line, col).not.toHaveLength(0);
      expect(line, col).not.toContain("NOT NULL");
      expect(line, col).not.toContain("DEFAULT");
    }
  });

  it("widens both posting CHECKs with 'archived' (additive: existing rows satisfy it)", () => {
    expect(FLAT).toContain("'archived'");
    // NOTE: `statementFor` would match the DROP first — pin the ADD CONSTRAINT line.
    const status =
      statements.find((s) => s.includes("job_postings_status_chk") && s.includes("ADD CONSTRAINT")) ??
      "";
    expect(status).toContain("'suspended'");
    expect(status).toContain("'archived'");
    const previous =
      statements.find(
        (s) => s.includes("job_postings_previous_status_chk") && s.includes("ADD CONSTRAINT"),
      ) ?? "";
    expect(previous).toContain("'suspended'");
    expect(previous).toContain("'archived'");
  });
});

describe("the LIVE model carries the same shape", () => {
  it("models the word-hash array on payers", () => {
    const col = getTableConfig(payers).columns.find((c) => c.name === "org_name_word_hashes");
    expect(col).toBeDefined();
    expect(col!.notNull).toBe(false);
  });

  it("models the profile columns on both tables", () => {
    for (const [table, names] of [
      [employerProfiles, ["gst_number_hash", "city", "address_enc", "contact_name_enc"]],
      [
        agencyProfiles,
        ["gst_number_enc", "gst_number_hash", "website", "city", "address_enc", "contact_name_enc"],
      ],
    ] as const) {
      const cols = getTableConfig(table).columns.map((c) => c.name);
      for (const name of names) expect(cols, name).toContain(name);
    }
  });

  it("the posting model admits 'archived' (status CHECK + previous CHECK + vocabularies)", () => {
    const jobSchema = readFileSync(join(__dirname, "schema", "job.ts"), "utf8");
    expect(jobSchema).toContain("'archived'");
    expect(jobSchema).toContain("job_postings_previous_status_chk");
    // The TS vocabularies the CHECKs mirror: JobStatus (jobs table) and
    // JOB_POSTING_STATUSES (@badabhai/types, mirrored by job_postings_status_chk).
    expect(jobSchema).toContain('"archived"');
    const typesIndex = readFileSync(
      join(__dirname, "..", "..", "types", "src", "index.ts"),
      "utf8",
    );
    expect(typesIndex).toContain('"archived"');
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  it("says manual-apply-BEFORE-the-deploy and names the schema-contract id", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    expect(RAW).toContain("Manual apply BEFORE the build");
    expect(RAW).toContain(CONTRACT_ID);
  });

  it("is registered in the schema contract against the company writers", () => {
    const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === CONTRACT_ID);
    expect(entry).toMatchObject({
      migration: TAG,
      kind: "column",
      table: "payers",
      object: "org_name_word_hashes",
    });
    for (const reader of ["AdminCompaniesRepository", "PayersRepository"]) {
      expect(entry?.requiredBy, reader).toContain(reader);
    }
  });

  it("states the lock guidance and the rollback for every added object", () => {
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain("ROLLBACK");
    expect(RAW).toContain('DROP INDEX "payers_org_word_hashes_gin_idx"');
    for (const name of ["org_name_word_hashes", "gst_number_hash", "contact_name_enc"]) {
      expect(RAW, name).toContain(`DROP COLUMN IF EXISTS "${name}"`);
    }
  });

  it("holds the only 0158 slot, after 0157, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(158);
    expect(JOURNAL.entries.filter((e) => e.idx === 158)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(157);
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
