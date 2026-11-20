/**
 * Migration `<slot>_admin_job_audience` — an admin decides where each job shows (#2956), and the
 * trades RVM trains (#2957). The file is found by its NAME, not its number: the slot is taken at
 * merge time and may be regenerated under another number, and this test must follow it without
 * an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — two new tables and one foreign key. Nothing dropped, no existing table altered
 *      beyond being referenced, no row written, seeded or backfilled.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs per table are hand-appended; a regenerate drops
 *      them.
 *   3. THE RULES THE ADMIN ROUTES RELY ON — one decision row per posting, the closed audience set,
 *      a sha256 content hash, a named deciding admin; a trade key's shape, and a removal that names
 *      who and when together.
 *   4. THE HEADER — deploy order (before the switch, not the deploy), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_admin_job_audience\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const D = "job_posting_audience_decisions";
const C = "campus_trades";
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
  it("finds exactly one admin_job_audience migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates both tables", () => {
    expect(FLAT).toContain(`CREATE TABLE "${D}"`);
    expect(FLAT).toContain(`CREATE TABLE "${C}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE `ADMIN_JOB_AUDIENCE_ENABLED` IS TURNED ON");
    expect(DDL).not.toContain("APPLY BEFORE");
  });
});

describe("the migration is additive", () => {
  it("creates exactly two tables and no index beyond their primary keys", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(2);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(0);
  });

  it("alters only the new tables", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([D, C]));
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

  it("references only job_postings, cascading, so a deleted posting takes its decision", () => {
    const refs = [...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+)/g)];
    expect(refs.map((m) => [m[1], m[2]])).toEqual([["job_postings", "cascade"]]);
  });
});

describe("deny by default", () => {
  it.each([D, C])("%s: enables AND forces RLS, and revokes every client role", (table) => {
    expect(FLAT).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "${table}" FROM ${role}`);
    }
  });

  it("creates no policy and grants nothing", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });
});

describe("the decision row", () => {
  it("one row per posting: the posting id is the primary key", () => {
    expect(FLAT).toContain(`"job_posting_id" uuid PRIMARY KEY NOT NULL`);
  });

  it("the audience is the closed set job_postings uses", () => {
    expect(FLAT).toContain(
      `CHECK ("${D}"."audience" IN ('badabhai_workers', 'rvm_students', 'both'))`,
    );
  });

  it("the content hash is lower-case sha256 hex, and every decision names its admin", () => {
    expect(FLAT).toContain(`CHECK ("${D}"."content_hash" ~ '^[0-9a-f]{64}$')`);
    expect(FLAT).toContain(`"decided_by_admin_id" uuid NOT NULL`);
  });
});

describe("the trade list", () => {
  it("the key is the trade key, shape only (a new trade kind needs no migration)", () => {
    expect(FLAT).toContain(`"trade_key" text PRIMARY KEY NOT NULL`);
    expect(FLAT).toContain(`CHECK ("${C}"."trade_key" ~ '^[a-z][a-z0-9_]{0,63}$')`);
  });

  it("a removal names who and when together", () => {
    expect(FLAT).toContain(
      `CHECK (("${C}"."removed_at" IS NULL) = ("${C}"."removed_by_admin_id" IS NULL))`,
    );
  });
});

describe("the header", () => {
  it("states the deploy order, the locks and the rollback", () => {
    expect(RAW).toContain("NOT BEFORE THE DEPLOY");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain(`DROP TABLE "${D}";`);
    expect(RAW).toContain(`DROP TABLE "${C}";`);
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

  it("its snapshot builds on its predecessor's and records both tables", () => {
    const previousSlot = String(Number(SLOT) - 1).padStart(4, "0");
    const next = snapshot(SLOT);
    expect(next.prevId).toBe(snapshot(previousSlot).id);
    expect(next.tables).toHaveProperty(`public.${D}`);
    expect(next.tables).toHaveProperty(`public.${C}`);
  });
});
