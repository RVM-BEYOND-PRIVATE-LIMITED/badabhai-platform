/**
 * Migration `<slot>_job_posting_worker_visibility` — BadaBhai worker visibility of a Campus-origin
 * posting (#2891). The file is found by its NAME, not its number: the slot is taken at merge time
 * and may be regenerated under another number, and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table, its index and its foreign key. Nothing dropped, no existing table
 *      altered beyond being referenced, no row written or backfilled.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE RULES THE READ RELIES ON — one row per posting, `off`/`on` only, `off` by default, and
 *      `on` only as a named admin decision.
 *   4. THE HEADER — deploy order (before the READING code, not a switch), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) =>
  /^\d{4}_job_posting_worker_visibility\.sql$/.test(f),
);
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const T = "job_posting_worker_visibility";
const RAW = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

const snapshot = (n: string): { id: string; prevId: string; tables: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", `${n}_snapshot.json`), "utf8"));

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one job_posting_worker_visibility migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${T}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE DEPLOY OF THE CODE THAT READS IT");
    expect(DDL).not.toContain("APPLY BEFORE THE DEPLOY");
  });
});

describe("the migration is additive", () => {
  it("creates exactly one table and one index", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(1);
  });

  it("alters only the new table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([T]));
  });

  it("drops nothing, deletes nothing, writes no rows and backfills nothing", () => {
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

  it("references only job_postings, cascading, so a deleted posting takes its row", () => {
    const refs = [...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+)/g)];
    expect(refs.map((m) => [m[1], m[2]])).toEqual([["job_postings", "cascade"]]);
  });
});

describe("deny by default", () => {
  it("enables AND forces RLS, and revokes every client role — no policy", () => {
    expect(FLAT).toContain(`ALTER TABLE "${T}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${T}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "${T}" FROM ${role}`);
    }
  });

  it("creates no policy and grants nothing", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });
});

describe("the rules the worker read relies on", () => {
  it("one row per posting: the posting id is the primary key", () => {
    expect(FLAT).toContain(`"job_posting_id" uuid PRIMARY KEY NOT NULL`);
  });

  it("a row is off unless set, and off or on only", () => {
    expect(FLAT).toContain(`"state" text DEFAULT 'off' NOT NULL`);
    expect(FLAT).toContain(`CHECK ("${T}"."state" IN ('off', 'on'))`);
  });

  it("the origin is the closed Campus set", () => {
    expect(FLAT).toContain(`CHECK ("${T}"."origin" IN ('campus_posted', 'campus_imported'))`);
  });

  it("a decision names who and when together, and on exists only as a decision", () => {
    expect(FLAT).toContain(
      `CHECK (("${T}"."decided_at" IS NULL) = ("${T}"."decided_by_admin_id" IS NULL) AND ("${T}"."state" = 'off' OR "${T}"."decided_at" IS NOT NULL))`,
    );
  });

  it("indexes the admin list by state and age", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "jpwv_state_created_idx" ON "${T}" USING btree ("state","created_at")`,
    );
  });
});

describe("the header", () => {
  it("states the deploy order, the locks and the rollback", () => {
    expect(RAW).toContain("THEN merge the next #2891 PR");
    expect(RAW).toContain("apply every\n-- lower-numbered migration first");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain(`DROP TABLE "${T}";`);
  });
});

describe("the journal and the snapshot", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records the migration at its slot, after its predecessor, with a later `when`", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(Number(SLOT));
    expect(previous.idx).toBe(Number(SLOT) - 1);
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("its snapshot builds on its predecessor's and records the table", () => {
    const previousSlot = String(Number(SLOT) - 1).padStart(4, "0");
    const next = snapshot(SLOT);
    expect(next.prevId).toBe(snapshot(previousSlot).id);
    expect(next.tables).toHaveProperty(`public.${T}`);
  });
});
