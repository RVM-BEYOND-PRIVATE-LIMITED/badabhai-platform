/**
 * Migration `<slot>_student_move` — the bulk move of RVM students into BadaBhai (#2887): the import
 * ledger, the per-field source markers and the visibility switch. The file is found by its NAME,
 * not its number: the slot is taken at merge time and may be regenerated under another number, and
 * this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — five new tables, their indexes and foreign keys. Nothing dropped, no existing
 *      table altered beyond being referenced, no row written.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs per table are hand-appended; a regenerate drops
 *      them.
 *   3. THE KEYS THE IMPORT RELIES ON — one row per candidate per run, one candidate per worker,
 *      one marker per worker and field, one visibility row per worker, hidden by default.
 *   4. THE HEADER — deploy order (before the SWITCH), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_student_move\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const TABLES = [
  "student_import_batches",
  "student_import_rows",
  "student_import_subjects",
  "worker_field_sources",
  "student_visibility",
];
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
  it("finds exactly one student_move migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates all five tables", () => {
    for (const table of TABLES) expect(FLAT).toContain(`CREATE TABLE "${table}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE SWITCH");
    expect(DDL).not.toContain("APPLY BEFORE THE SWITCH");
  });
});

describe("the migration is additive", () => {
  it("creates exactly five tables and five indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(5);
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

  it("references only workers and its own batch table", () => {
    const refs = [...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\)/g)].map((m) => m[1]);
    expect(new Set(refs)).toEqual(new Set(["workers", "student_import_batches"]));
  });

  it("a worker's erasure takes his subject, marker and visibility rows, and keeps the run log", () => {
    for (const table of ["student_import_subjects", "worker_field_sources", "student_visibility"]) {
      expect(FLAT).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade`,
      );
    }
    expect(FLAT).toContain(
      `ADD CONSTRAINT "student_import_rows_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null`,
    );
  });
});

describe("deny by default", () => {
  it.each(TABLES)("%s: enables AND forces RLS, and revokes every client role — no policy", (t) => {
    expect(FLAT).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "${t}" FROM ${role}`);
    }
  });

  it("creates no policy and grants nothing", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });
});

describe("the keys the import relies on", () => {
  it("one row per candidate per run", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "student_import_rows_batch_source_uq" ON "student_import_rows" USING btree ("batch_id","source_id")`,
    );
  });

  it("one candidate per worker (one phone is one person), keyed by source and candidate id", () => {
    expect(FLAT).toContain(`CONSTRAINT "student_import_subjects_pk" PRIMARY KEY("source","source_id")`);
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "student_import_subjects_worker_uq" ON "student_import_subjects" USING btree ("worker_id")`,
    );
  });

  it("one marker per worker and field, from the import or the worker", () => {
    expect(FLAT).toContain(`CONSTRAINT "worker_field_sources_pk" PRIMARY KEY("worker_id","field_key")`);
    expect(FLAT).toContain(
      `CHECK ("worker_field_sources"."source" IN ('campus_import', 'worker'))`,
    );
  });

  it("one visibility row per worker, hidden by default", () => {
    expect(FLAT).toContain(`"worker_id" uuid PRIMARY KEY NOT NULL, "visible" boolean DEFAULT false NOT NULL`);
  });

  it("no personal data: no name, phone or free-text column", () => {
    expect(FLAT).not.toMatch(/"(full_name|name|phone[a-z_]*|email[a-z_]*)" /);
    expect(FLAT).not.toMatch(/_enc" text/);
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the locks and the rollback", () => {
    expect(RAW).toContain("STUDENT_MOVE_ENABLED");
    expect(RAW).toContain("Apply every\n-- lower-numbered migration first");
    expect(RAW).toContain("lock_timeout");
    for (const table of TABLES) expect(RAW).toContain(`DROP TABLE "${table}";`);
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

  it("its snapshot builds on its predecessor's and records all five tables", () => {
    const previousSlot = String(Number(SLOT) - 1).padStart(4, "0");
    const next = snapshot(SLOT);
    expect(next.prevId).toBe(snapshot(previousSlot).id);
    for (const table of TABLES) expect(next.tables).toHaveProperty(`public.${table}`);
  });
});
