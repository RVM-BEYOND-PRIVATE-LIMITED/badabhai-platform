/**
 * Migration 0161 — `worker_institute_links` and `worker_origins` (#2752 part B).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half that lives in the hand-edits and the contract:
 *
 *   1. ADDITIVE — two new tables. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARIES — each CHECK is exactly its TypeScript list, so the database cannot hold a
 *      value the code does not know.
 *   4. NO INSTITUTE RECORD BEYOND THE AGREED FIELDS — the never-stored list (brief 4D.6/4D.7).
 *   5. THE HEADER — deploy order and rollback are written down.
 *
 * Nothing here connects to a database — it reads the committed SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INSTITUTE_CODES,
  INSTITUTE_LINK_STATUSES,
  INSTITUTE_STUDENT_STATUSES,
  WORKER_ORIGIN_KINDS,
} from "./schema/institute-link";

const TAG = "0161_institute_link";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const TABLES = ["worker_institute_links", "worker_origins"] as const;

/** The values a CHECK `IN (...)` admits, in order. */
function checkValues(constraint: string, column: string, table: string): string[] {
  const match = new RegExp(
    `CONSTRAINT "${constraint}" CHECK \\([^)]*"${table}"\\."${column}" IN \\(([^)]*)\\)`,
  ).exec(FLAT);
  expect(match, constraint).not.toBeNull();
  return match![1]!.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that creates both tables", () => {
    for (const table of TABLES) expect(FLAT).toContain(`CREATE TABLE "${table}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE CAMPUS LINK IS SWITCHED ON");
    expect(DDL).not.toContain("APPLY BEFORE THE CAMPUS LINK IS SWITCHED ON");
  });
});

describe("0161 is additive", () => {
  it("creates exactly two tables", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(2);
  });

  it("alters only the new tables", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)" ([^;]+);/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(altered).toHaveLength(6); // per table: ENABLE, the FK, FORCE
    for (const statement of altered) {
      expect(statement).toMatch(
        /^(worker_institute_links|worker_origins) (ENABLE|FORCE|ADD CONSTRAINT)/,
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
      'UPDATE "', // an UPDATE statement, not the FK's `ON UPDATE no action`
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("never touches the migration ledger, and sets a lock timeout", () => {
    expect(FLAT).not.toContain("__drizzle_migrations");
    expect(FLAT).toContain("SET lock_timeout='3s'");
  });

  it("states the deploy order and the rollback in the header", () => {
    expect(RAW).toContain("CAMPUS_LINK_ENABLED");
    expect(RAW).toContain('DROP TABLE "worker_institute_links";');
    expect(RAW).toContain('DROP TABLE "worker_origins";');
  });
});

describe("the vocabularies match the code", () => {
  it("institute_code admits exactly INSTITUTE_CODES", () => {
    expect(
      checkValues(
        "worker_institute_links_institute_chk",
        "institute_code",
        "worker_institute_links",
      ),
    ).toEqual([...INSTITUTE_CODES]);
  });

  it("status admits exactly INSTITUTE_LINK_STATUSES", () => {
    expect(
      checkValues("worker_institute_links_status_chk", "status", "worker_institute_links"),
    ).toEqual([...INSTITUTE_LINK_STATUSES]);
  });

  it("student_status admits exactly INSTITUTE_STUDENT_STATUSES, as RVM sends them", () => {
    expect(
      checkValues(
        "worker_institute_links_student_status_chk",
        "student_status",
        "worker_institute_links",
      ),
    ).toEqual([...INSTITUTE_STUDENT_STATUSES]);
  });

  it("kind admits exactly WORKER_ORIGIN_KINDS", () => {
    expect(checkValues("worker_origins_kind_chk", "kind", "worker_origins")).toEqual([
      ...WORKER_ORIGIN_KINDS,
    ]);
  });

  it("one link per institute student: unique on (institute_code, student_ref)", () => {
    expect(FLAT).toContain(
      'CREATE UNIQUE INDEX "worker_institute_links_ref_uq" ON "worker_institute_links" USING btree ("institute_code","student_ref")',
    );
  });
});

describe("no institute record beyond the agreed fields (brief 4D.6, 4D.7)", () => {
  // The never-stored list. Name and phone are agreed but live encrypted on `workers`, not here.
  it.each([
    "fee",
    "dues",
    "instalment",
    "installment",
    "attendance",
    "document",
    "aadhaar",
    "date_of_birth",
    "dob",
    "batch",
    "placement_proof",
    "reward",
    "referral",
    "full_name",
    "phone",
  ])("has no column named like %s", (word) => {
    const columns = [...FLAT.matchAll(/"([a-z_]+)" (?:uuid|text|numeric|boolean|timestamp)/g)].map(
      (m) => m[1]!,
    );
    expect(columns.length).toBeGreaterThan(10);
    for (const column of columns) expect(column).not.toContain(word);
  });
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

  it.each(TABLES)("%s keys one row per worker and cascades on worker delete", (table) => {
    expect(FLAT).toMatch(
      new RegExp(
        `ALTER TABLE "${table}" ADD CONSTRAINT "[a-z_]+" FOREIGN KEY \\("worker_id"\\) REFERENCES "public"\\."workers"\\("id"\\) ON DELETE cascade`,
      ),
    );
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0161 at idx 161, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(161);
    expect(previous.tag).toBe("0160_admin_corrections");
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
