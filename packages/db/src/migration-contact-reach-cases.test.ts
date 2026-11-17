/**
 * Migration `<slot>_contact_reach_cases` — the couldn't-reach cases and the desk's call attempts
 * (#2750 item 7). The file is found by its NAME, not its number:
 * the slot is taken at merge time and may be regenerated under another number, and this test must
 * follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — two new tables, their indexes and foreign keys. Nothing dropped, no existing
 *      table altered beyond being referenced, no row written.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs per table are hand-appended; a regenerate drops
 *      them.
 *   3. ONE ACTIVE WAIVER PER COMPANY AND PER JOB, ONE USE PER OPEN — the unique indexes the
 *      service relies on, and the CHECKs tying scope to posting and `active` to `cleared_at`.
 *   4. THE HEADER — deploy order (before the SWITCH), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_contact_reach_cases\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const CASES = "contact_reach_cases";
const ATTEMPTS = "contact_reach_attempts";
const TABLES = [CASES, ATTEMPTS];
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
  it("finds exactly one contact_reach_cases migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates both tables", () => {
    for (const table of TABLES) expect(FLAT).toContain(`CREATE TABLE "${table}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE SWITCH");
    expect(DDL).not.toContain("APPLY BEFORE THE SWITCH");
  });
});

describe("the migration is additive", () => {
  it("creates exactly two tables and four indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(2);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(4);
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

  it("references only unlocks (cascade), workers (set null, erasure) and its own case table", () => {
    const refs = [...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+ ?\w*)/g)];
    expect(refs.map((m) => `${m[1]}:${m[2]!.replace(/ ON$/, "")}`).sort()).toEqual([
      "contact_reach_cases:cascade",
      "unlocks:cascade",
      "workers:set null",
    ]);
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

describe("one case per open, a closed status, a resolution that adds up", () => {
  it("one case per open: unlock_id is UNIQUE", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "contact_reach_cases_unlock_uq" ON "${CASES}" USING btree ("unlock_id")`,
    );
  });

  it("the desk queue and the deadline sweep read open cases by deadline", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "contact_reach_cases_open_deadline_idx" ON "${CASES}" USING btree ("deadline_at") WHERE "${CASES}"."status" = 'open'`,
    );
  });

  it("closed status and result codes, no negative return", () => {
    expect(FLAT).toContain(
      `CHECK ("${CASES}"."status" IN ('open', 'reached_interested', 'reached_declined', 'not_reached'))`,
    );
    expect(FLAT).toContain(`CHECK ("${CASES}"."credits_returned" >= 0)`);
    expect(FLAT).toContain(
      `CHECK ("${ATTEMPTS}"."result" IN ('no_answer', 'busy', 'switched_off', 'wrong_number', 'other'))`,
    );
  });

  it("open means unresolved, and a resolution names who resolved it", () => {
    expect(FLAT).toContain(
      `CHECK (("${CASES}"."status" = 'open') = ("${CASES}"."resolved_at" IS NULL) AND ("${CASES}"."resolved_at" IS NULL) = ("${CASES}"."resolved_by" IS NULL) AND ("${CASES}"."resolved_by_admin_id" IS NULL OR "${CASES}"."resolved_by" = 'desk'))`,
    );
  });

  it("no free text column on either table", () => {
    expect(FLAT).not.toMatch(/"(note|notes|reason|comment)[a-z_]*" text/);
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the locks and the rollback", () => {
    expect(RAW).toContain("CREDIT_RULES_ROLLOUT");
    expect(RAW).toContain("Apply every lower-numbered migration first");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain(`DROP TABLE "${ATTEMPTS}";`);
    expect(RAW).toContain(`DROP TABLE "${CASES}";`);
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
    for (const table of TABLES) expect(next.tables).toHaveProperty(`public.${table}`);
  });
});
