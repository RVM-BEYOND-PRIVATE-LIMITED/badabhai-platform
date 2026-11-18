/**
 * Migration `<slot>_rvm_applicant_waivers` — the placement team's waiver of the contact cost and
 * the opens each waiver paid for (#2750 item 5). The file is found by its NAME, not its number:
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
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_rvm_applicant_waivers\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const WAIVERS = "rvm_applicant_waivers";
const USES = "rvm_waiver_uses";
const TABLES = [WAIVERS, USES];
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
  it("finds exactly one rvm_applicant_waivers migration", () => {
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
  it("creates exactly two tables and six indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(2);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(6);
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

  it("references only job_postings, unlocks and its own waiver table, each cascading", () => {
    const refs = [...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+)/g)];
    expect(refs.map((m) => m[1]).sort()).toEqual(["job_postings", "rvm_applicant_waivers", "unlocks"]);
    expect(new Set(refs.map((m) => m[2]))).toEqual(new Set(["cascade"]));
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

describe("one active waiver per company and per job, one use per open", () => {
  it("a company has at most one active company waiver", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "rvm_applicant_waivers_company_active_uq" ON "${WAIVERS}" USING btree ("payer_id") WHERE "${WAIVERS}"."active" AND "${WAIVERS}"."scope" = 'company'`,
    );
  });

  it("a job has at most one active job waiver", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "rvm_applicant_waivers_job_active_uq" ON "${WAIVERS}" USING btree ("job_posting_id") WHERE "${WAIVERS}"."active" AND "${WAIVERS}"."scope" = 'job'`,
    );
  });

  it("a job waiver names its posting and a company waiver names none", () => {
    expect(FLAT).toContain(
      `CHECK (("${WAIVERS}"."scope" = 'company' AND "${WAIVERS}"."job_posting_id" IS NULL) OR ("${WAIVERS}"."scope" = 'job' AND "${WAIVERS}"."job_posting_id" IS NOT NULL))`,
    );
  });

  it("active means not cleared, and a clear names who cleared it", () => {
    expect(FLAT).toContain(
      `CHECK ("${WAIVERS}"."active" = ("${WAIVERS}"."cleared_at" IS NULL) AND ("${WAIVERS}"."cleared_at" IS NULL OR "${WAIVERS}"."cleared_by_ref" IS NOT NULL))`,
    );
  });

  it("staff names are stored only as encrypted tokens", () => {
    expect(FLAT).toContain(`"set_by_label_enc" text`);
    expect(FLAT).toContain(`"cleared_by_label_enc" text`);
    expect(FLAT).not.toMatch(/"(set|cleared)_by_label" /);
  });

  it("one open is waived at most once", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "rvm_waiver_uses_unlock_uq" ON "${USES}" USING btree ("unlock_id")`,
    );
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the locks and the rollback", () => {
    expect(RAW).toContain("CREDIT_RULES_ROLLOUT");
    expect(RAW).toContain("Apply every lower-numbered migration first");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain(`DROP TABLE "${USES}";`);
    expect(RAW).toContain(`DROP TABLE "${WAIVERS}";`);
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
