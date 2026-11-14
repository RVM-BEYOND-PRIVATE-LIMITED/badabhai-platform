/**
 * Migration 0163 — `institute_search_grants` and `institute_applications` (#2752 items 10, 8).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half that lives in the hand-edits and the contract:
 *
 *   1. ADDITIVE — two new tables. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE KEYS — the refs Campus retries with are unique for good, and one live grant per
 *      company and worker.
 *   4. NO PERSONAL DATA — ids, codes and dates only.
 *   5. THE HEADER — apply order and rollback are written down.
 *
 * Nothing here connects to a database — it reads the committed SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INSTITUTE_CODES } from "./schema/institute-link";

const TAG = "0163_institute_grants_applications";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const TABLES = ["institute_search_grants", "institute_applications"] as const;

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that creates both tables", () => {
    for (const table of TABLES) expect(FLAT).toContain(`CREATE TABLE "${table}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    expect(DDL).not.toContain("APPLY-BEFORE-DEPLOY");
  });
});

describe("0163 is additive", () => {
  it("creates exactly two tables", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(2);
  });

  it("alters only the new tables", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)" ([^;]+);/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    // ENABLE + FORCE per table, three FKs on the applications table and two on the grants table.
    expect(altered).toHaveLength(9);
    for (const statement of altered) {
      expect(statement).toMatch(
        /^(institute_search_grants|institute_applications) (ENABLE|FORCE|ADD CONSTRAINT)/,
      );
    }
  });

  it("drops nothing, truncates nothing, deletes nothing, writes no rows", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP CONSTRAINT",
      "TRUNCATE",
      "DELETE FROM",
      "INSERT INTO",
      'UPDATE "',
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("never touches the migration ledger, and sets a lock timeout", () => {
    expect(FLAT).not.toContain("__drizzle_migrations");
    expect(FLAT).toContain("SET lock_timeout='3s'");
  });

  it("states the apply order and the rollback in the header", () => {
    expect(RAW).toContain("AFTER 0162");
    expect(RAW).toContain('DROP TABLE "institute_search_grants";');
    expect(RAW).toContain('DROP TABLE "institute_applications";');
    expect(RAW).toContain("0163 rollback refused: the tables hold rows");
  });
});

describe("the keys", () => {
  it.each(TABLES)("%s admits exactly INSTITUTE_CODES", (table) => {
    expect(FLAT).toContain(
      `CONSTRAINT "${table}_institute_chk" CHECK ("${table}"."institute_code" IN ('${INSTITUTE_CODES.join("', '")}'))`,
    );
  });

  it("a grant_ref is unique per institute, for good (a revoke keeps the row)", () => {
    expect(FLAT).toContain(
      'CREATE UNIQUE INDEX "institute_search_grants_ref_uq" ON "institute_search_grants" USING btree ("institute_code","grant_ref")',
    );
  });

  it("one LIVE grant per company, worker and institute", () => {
    expect(FLAT).toContain(
      'CREATE UNIQUE INDEX "institute_search_grants_live_uq" ON "institute_search_grants" USING btree ("payer_id","worker_id","institute_code") WHERE "institute_search_grants"."revoked_at" IS NULL',
    );
  });

  it("a Campus application id is unique per institute, for good", () => {
    expect(FLAT).toContain(
      'CREATE UNIQUE INDEX "institute_applications_ref_uq" ON "institute_applications" USING btree ("institute_code","external_ref")',
    );
  });

  it("a withdrawn Campus application no longer points at an applications row", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "institute_applications_withdrawn_chk" CHECK ("institute_applications"."withdrawn_at" IS NULL OR "institute_applications"."application_id" IS NULL)`,
    );
  });

  it("refs are codes, never free text", () => {
    for (const [table, column] of [
      ["institute_search_grants", "grant_ref"],
      ["institute_search_grants", "consent_ref"],
      ["institute_applications", "external_ref"],
    ] as const) {
      expect(FLAT).toContain(`"${table}"."${column}" ~ '^[A-Za-z0-9._:-]{8,200}$'`);
    }
  });

  it("cascades on worker deletion (DPDP), and on company deletion for a grant", () => {
    for (const table of TABLES) {
      expect(FLAT).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade`,
      );
    }
    expect(FLAT).toContain(
      `FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade`,
    );
    expect(FLAT).toContain(
      `FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null`,
    );
  });
});

describe("no personal data", () => {
  it.each(["name", "phone", "course", "branch", "score", "note", "text"])(
    "has no column named like %s",
    (word) => {
      const columns = [...FLAT.matchAll(/"([a-z_]+)" (?:uuid|text|timestamp)/g)].map((m) => m[1]!);
      expect(columns.length).toBeGreaterThan(15);
      for (const column of columns) expect(column).not.toContain(word);
    },
  );
});

describe("the tables are locked (RLS tail is hand-appended)", () => {
  it.each(TABLES)("%s enables and FORCES row level security", (table) => {
    expect(FLAT).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  });

  it.each(
    TABLES.flatMap((t) => ["PUBLIC", "anon", "authenticated", "service_role"].map((r) => [t, r])),
  )("%s revokes everything from %s", (table, role) => {
    expect(FLAT).toContain(`REVOKE ALL ON TABLE "${table}" FROM ${role}`);
  });

  it("declares no policy and grants nothing — deny by default", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });
});

describe("the journal", () => {
  it("records 0163 at idx 163, right after 0162, with a `when` above it", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(163);
    expect(previous.tag).toBe("0162_job_audience_campus_drives");
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
