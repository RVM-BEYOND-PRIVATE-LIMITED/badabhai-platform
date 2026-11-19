/**
 * Migration `<slot>_company_import_notices` — the send log of the first sign-in message to a moved
 * company (#2787). The file is found by its NAME, not its number: the slot is taken at merge time
 * and may be regenerated under another number, and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table, its indexes and two foreign keys. No existing table is altered,
 *      no row is written.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. ONCE PER COMPANY PER CHANNEL — the unique index a second run relies on to send nothing more.
 *   4. THE HEADER — deploy order (before the first send), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL and journal.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_company_import_notices\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const TABLE = "company_import_notices";
const RAW = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one company_import_notices migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${TABLE}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE FIRST `--notify --send` RUN");
    expect(DDL).not.toContain("APPLY BEFORE THE FIRST");
  });
});

describe("the migration is additive", () => {
  it("creates exactly one table and two indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(2);
  });

  it("alters only the new table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([TABLE]));
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

  it("restricts deleting a batch with a log, and erases the log with the company", () => {
    const refs = [...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+)/g)];
    expect(refs.map((m) => `${m[1]}:${m[2]}`).sort()).toEqual([
      "company_import_batches:restrict",
      "payers:cascade",
    ]);
  });
});

describe("the RLS tail is present (a regenerate drops it)", () => {
  it("ENABLE, FORCE and the four REVOKEs", () => {
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "${TABLE}" FROM ${role}`);
    }
  });

  it("creates no policy, so every client role is denied", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
  });
});

describe("each company is told once per channel", () => {
  it("one row per (payer, channel), across every batch", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "company_import_notices_payer_channel_uq" ON "${TABLE}" USING btree ("payer_id","channel")`,
    );
  });

  it("closes the channel and state vocabularies, and ties sent_at and reason to the state", () => {
    expect(FLAT).toContain(`"channel" IN ('email', 'sms')`);
    expect(FLAT).toContain(`"state" IN ('sent', 'failed', 'skipped')`);
    expect(FLAT).toContain("company_import_notices_outcome_chk");
  });
});

describe("the header", () => {
  it("states the deploy order, the locks, the rollback and that it is not re-runnable", () => {
    expect(RAW).toContain("NOT BEFORE THE DEPLOY");
    expect(RAW).toContain("lock_timeout = '3s'");
    expect(RAW).toContain(`DROP TABLE "${TABLE}"`);
    expect(RAW).toContain("SAFE TO RE-RUN: no");
  });

  it("names no migration number of its own (a regenerate keeps it word for word)", () => {
    const header = RAW.split("CREATE TABLE")[0] ?? "";
    expect(header).not.toMatch(/\b0\d{3}_company_import_notices\b/);
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
