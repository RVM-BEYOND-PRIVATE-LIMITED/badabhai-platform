/**
 * Migration `<slot>_company_import` — the Campus company import ledger (#2754 item 4). The file is
 * found by its NAME, not its number: the slot is taken at merge time and may be regenerated under
 * another number, and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — two new tables, their indexes and one foreign key between them. No existing
 *      table is altered or referenced, no row is written.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs per table are hand-appended; a regenerate drops
 *      them.
 *   3. IDEMPOTENCE — one ledger row per source record across batches, one batch per key: the
 *      unique indexes a second run relies on to add nothing.
 *   4. THE HEADER — deploy order (before the first import run), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL and journal.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_company_import\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const BATCHES = "company_import_batches";
const ROWS = "company_import_rows";
const TABLES = [BATCHES, ROWS];
const RAW = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one company_import migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates both tables", () => {
    for (const table of TABLES) expect(FLAT).toContain(`CREATE TABLE "${table}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE FIRST IMPORT RUN");
    expect(DDL).not.toContain("APPLY BEFORE THE FIRST IMPORT RUN");
  });
});

describe("the migration is additive", () => {
  it("creates exactly two tables and five indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(2);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(5);
  });

  it("alters only the new tables", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(TABLES));
  });

  it("drops nothing, deletes nothing, writes no rows and seeds nothing", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP CONSTRAINT",
      "DROP INDEX",
      "TRUNCATE",
      "DELETE FROM",
      "INSERT INTO",
      'UPDATE "',
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    expect(FLAT).not.toContain("__drizzle_migrations");
  });

  it("references only its own batch table, and refuses to delete a batch that has rows", () => {
    const refs = [...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+)/g)];
    expect(refs.map((m) => m[1])).toEqual([BATCHES]);
    expect(refs.map((m) => m[2])).toEqual(["restrict"]);
  });
});

describe("the RLS tail is present (a regenerate drops it)", () => {
  for (const table of TABLES) {
    it(`${table}: ENABLE, FORCE and the four REVOKEs`, () => {
      expect(FLAT).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(FLAT).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
        expect(FLAT).toContain(`REVOKE ALL ON TABLE "${table}" FROM ${role}`);
      }
    });
  }

  it("creates no policy, so every client role is denied", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
  });
});

describe("a second run adds nothing", () => {
  it("one ledger row per (source system, kind, source id), across every batch", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "company_import_rows_source_uq" ON "${ROWS}" USING btree ("source_system","kind","source_id")`,
    );
  });

  it("one batch per batch key", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "company_import_batches_batch_key_uq" ON "${BATCHES}" USING btree ("batch_key")`,
    );
  });

  it("a row that moved something names its target, and a row that moved nothing says why", () => {
    expect(FLAT).toContain("company_import_rows_target_chk");
    expect(FLAT).toContain("company_import_rows_reason_chk");
  });
});

describe("the header", () => {
  it("states the deploy order, the locks, the rollback and that it is not re-runnable", () => {
    expect(RAW).toContain("APPLY BEFORE THE FIRST IMPORT RUN, NOT BEFORE THE DEPLOY");
    expect(RAW).toContain("lock_timeout = '3s'");
    expect(RAW).toContain('DROP TABLE "company_import_rows"');
    expect(RAW).toContain("SAFE TO RE-RUN: no");
  });

  it("names no migration number of its own (a regenerate keeps it word for word)", () => {
    const header = RAW.split("CREATE TABLE")[0] ?? "";
    expect(header).not.toMatch(/\b0\d{3}_company_import\b/);
  });
});

describe("the journal", () => {
  it("records the migration once, as the newest entry it was generated after", () => {
    const entries = JOURNAL.entries.filter((e) => e.tag === TAG);
    expect(entries).toHaveLength(1);
    const prior = JOURNAL.entries.filter((e) => e.idx < entries[0]!.idx);
    for (const e of prior) expect(e.when).toBeLessThan(entries[0]!.when);
  });
});
