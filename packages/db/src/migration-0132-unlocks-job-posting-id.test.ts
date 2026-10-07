/**
 * Migration 0132 — `unlocks.job_posting_id` (#2033).
 *
 * The company-posting context of a contact unlock, the `job_postings` twin of `unlocks.job_id`.
 * Pinned beyond the drift check: additive-only (one nullable column with no default, one FK with
 * ON DELETE SET NULL, nothing dropped or rewritten, no backfill), the model agreeing with the
 * DDL, the APPLY-BEFORE-DEPLOY instruction + schema-contract registration, the rollback, and
 * the slot. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { unlocks } from "./schema/payer";

const TAG = "0132_unlocks_job_posting_id";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const FLAT = DDL.replace(/\s+/g, " ");
const FK = "unlocks_job_posting_id_job_postings_id_fk";

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("0132 is additive", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain('DROP COLUMN "job_posting_id"');
    expect(DDL).not.toContain("DROP COLUMN");
  });

  it("is exactly one ADD COLUMN and one ADD CONSTRAINT on unlocks — and nothing else", () => {
    const statements = FLAT.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toEqual([
      'ALTER TABLE "unlocks" ADD COLUMN "job_posting_id" uuid',
      `ALTER TABLE "unlocks" ADD CONSTRAINT "${FK}" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action`,
    ]);
  });

  it("drops, rewrites and backfills nothing", () => {
    const upper = FLAT.toUpperCase();
    // `ON DELETE set null` / `ON UPDATE no action` are the FK's action clauses, not statements.
    const statementsOnly = upper
      .replace("ON DELETE SET NULL", "")
      .replace("ON UPDATE NO ACTION", "");
    for (const verb of [
      "DROP ",
      "UPDATE ",
      "INSERT ",
      "DELETE ",
      "TRUNCATE",
      "RENAME",
      "ALTER COLUMN",
    ]) {
      expect(statementsOnly, verb).not.toContain(verb);
    }
    expect(upper).not.toContain("NOT NULL");
    expect(upper).not.toContain("DEFAULT");
  });
});

describe("the model agrees with the DDL", () => {
  it("unlocks.job_posting_id is a nullable uuid with no default", () => {
    const col = getTableConfig(unlocks).columns.find((c) => c.name === "job_posting_id");
    expect(col).toBeDefined();
    expect(col!.getSQLType()).toBe("uuid");
    expect(col!.notNull).toBe(false);
    expect(col!.hasDefault).toBe(false);
  });

  it("the FK targets job_postings.id ON DELETE SET NULL under the generated name", () => {
    const fk = getTableConfig(unlocks).foreignKeys.find((f) => f.getName() === FK);
    expect(fk).toBeDefined();
    const ref = fk!.reference();
    expect(ref.columns.map((c) => c.name)).toEqual(["job_posting_id"]);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
    expect(getTableConfig(ref.foreignTable).name).toBe("job_postings");
    expect(fk!.onDelete).toBe("set null");
  });
});

describe("the operator instructions and the slot", () => {
  it("says APPLY-BEFORE-DEPLOY, names the reader, and is registered in schema-contract", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    expect(RAW).toContain("UnlocksRepository");
    expect(RAW).toContain("0132-unlocks-job-posting-id");
    const req = SCHEMA_REQUIREMENTS.find((r) => r.id === "0132-unlocks-job-posting-id");
    expect(req).toMatchObject({
      migration: TAG,
      kind: "column",
      table: "unlocks",
      object: "job_posting_id",
    });
  });

  it("states the lock guidance and the rollback", () => {
    expect(RAW).toContain("lock_timeout = '3s'");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain("ROLLBACK");
    expect(RAW).toContain(`DROP CONSTRAINT "${FK}"`);
    expect(RAW).toContain('ALTER TABLE "unlocks" DROP COLUMN "job_posting_id"');
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
