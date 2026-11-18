/**
 * Migration `<slot>_job_posting_choices` — which posting button a company tapped (#2751 items 1 to
 * 3). The file is found by its NAME, not its number: the slot is taken at merge time and may be
 * regenerated under another number, and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table, its indexes and its foreign key. Nothing dropped, no existing table
 *      altered beyond being referenced, no row written.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. ONE ROW PER POSTING — the posting id is the primary key (the service's insert relies on it),
 *      the closed codes match `@badabhai/types`, and the posting's deletion cascades.
 *   4. THE HEADER — deploy order (before the switch, not before the deploy), the locks, the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { POSTING_CHOICES, POSTING_SURFACES } from "@badabhai/types";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_job_posting_choices\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const T = "job_posting_choices";
const RAW = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

const snapshot = (n: string): { id: string; prevId: string; tables: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", `${n}_snapshot.json`), "utf8"));

const inList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one job_posting_choices migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${T}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE POSTING_CHOICE_ROLLOUT IS SET");
    expect(DDL).not.toContain("APPLY BEFORE POSTING_CHOICE_ROLLOUT IS SET");
  });
});

describe("the migration is additive", () => {
  it("creates exactly one table and two indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(2);
  });

  it("alters only the new table (no column lands on job_postings)", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([T]));
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

  it("references only job_postings, and the posting's deletion cascades", () => {
    const refs = [
      ...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+ ?\w*)/g),
    ];
    expect(refs.map((m) => `${m[1]}:${m[2]!.replace(/ ON$/, "")}`)).toEqual([
      "job_postings:cascade",
    ]);
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

describe("one row per posting, closed codes from @badabhai/types", () => {
  it("the posting id is the primary key", () => {
    expect(FLAT).toContain(`"job_posting_id" uuid PRIMARY KEY NOT NULL`);
  });

  it("the choice and surface CHECKs spell the shared sets", () => {
    expect(FLAT).toContain(`CHECK ("${T}"."choice" IN (${inList(POSTING_CHOICES)}))`);
    expect(FLAT).toContain(`CHECK ("${T}"."surface" IN (${inList(POSTING_SURFACES)}))`);
  });

  it("indexed for the weekly count and the company read", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "job_posting_choices_recorded_idx" ON "${T}" USING btree ("recorded_at")`,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "job_posting_choices_payer_idx" ON "${T}" USING btree ("payer_id")`,
    );
  });

  it("no free text column", () => {
    expect(FLAT).not.toMatch(/"(note|notes|reason|comment|label)[a-z_]*" text/);
  });
});

describe("the header", () => {
  it("states the deploy order, the slot order, the locks and the rollback", () => {
    expect(RAW).toContain("NOT BEFORE THE DEPLOY");
    expect(RAW).toContain("Apply every lower-numbered migration first");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain(`DROP TABLE IF EXISTS "${T}";`);
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
