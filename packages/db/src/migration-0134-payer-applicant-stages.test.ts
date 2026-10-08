/**
 * Migration 0134 — `payer_applicant_stages`, the payer applicant pipeline board (owner ruling
 * 2026-10-07: New / Shortlist / Passed saved server-side).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What they do NOT see, and
 * what this file pins, is the half that lives in the hand-edits and the contract:
 *
 *   1. ADDITIVE — one new table. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARIES — the two CHECKs are exactly `APPLICANT_POSTING_KINDS` and
 *      `APPLICANT_STAGES`, so the DB cannot hold a value the route, the DTO and the event do not know.
 *   4. THE KEY — one row per (posting kind, posting id, worker): the upsert target.
 *   5. THE HEADER — deploy order (apply before the FLAG) and rollback are written down.
 *
 * Nothing here connects to a database — it reads the committed SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { APPLICANT_POSTING_KINDS, APPLICANT_STAGES } from "@badabhai/types";

const TAG = "0134_payer_applicant_stages";
const TABLE = "payer_applicant_stages";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

/**
 * The values an `IN (...)` CHECK on `column` admits, in order — located by plain string search
 * (no regex built from input), from the constraint's opening to the first `))` after it.
 */
function checkValues(constraint: string, column: string): string[] | null {
  const head = `CONSTRAINT "${constraint}" CHECK ("${TABLE}"."${column}" IN (`;
  const start = FLAT.indexOf(head);
  if (start < 0) return null;
  const end = FLAT.indexOf("))", start + head.length);
  if (end < 0) return null;
  return FLAT.slice(start + head.length, end)
    .split(",")
    .map((v) => v.trim().replace(/^'|'$/g, ""));
}

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${TABLE}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE FLAG");
    expect(DDL).not.toContain("APPLY BEFORE THE FLAG");
  });
});

describe("0134 is additive", () => {
  it("creates exactly one table and one index", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(1);
  });

  it("alters only the new table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)" ([^;]+);/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(altered).toHaveLength(3); // ENABLE, the FK, FORCE
    for (const statement of altered) {
      expect(statement).toMatch(/^payer_applicant_stages (ENABLE|FORCE|ADD CONSTRAINT)/);
    }
  });

  it("drops nothing, truncates nothing, deletes nothing, writes no rows", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP CONSTRAINT",
      "DROP INDEX",
      "TRUNCATE",
      "DELETE FROM",
      "INSERT INTO",
      'UPDATE "', // an UPDATE statement — not the FK's `ON UPDATE no action`
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("never touches the migration ledger", () => {
    expect(FLAT).not.toContain("__drizzle_migrations");
  });

  it("states the deploy order and the rollback in the header", () => {
    expect(RAW).toContain("PAYER_APPLICANT_STAGES_ENABLED");
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
  });
});

describe("the vocabularies", () => {
  it("posting_kind admits exactly APPLICANT_POSTING_KINDS — no more, no fewer", () => {
    expect(checkValues("payer_applicant_stages_posting_kind_chk", "posting_kind")).toEqual([
      ...APPLICANT_POSTING_KINDS,
    ]);
  });

  it("stage admits exactly APPLICANT_STAGES — `new` included, for a row moved back", () => {
    expect(checkValues("payer_applicant_stages_stage_chk", "stage")).toEqual([...APPLICANT_STAGES]);
    expect(APPLICANT_STAGES).toContain("new");
  });

  it("every column is NOT NULL — a row always names its posting, worker, stage and author", () => {
    for (const column of [
      '"posting_kind" text NOT NULL',
      '"posting_id" uuid NOT NULL',
      '"worker_id" uuid NOT NULL',
      '"stage" text NOT NULL',
      '"updated_by_payer_id" uuid NOT NULL',
    ]) {
      expect(FLAT).toContain(column);
    }
  });
});

describe("the key and the indexes", () => {
  it("one row per (posting kind, posting id, worker) — the composite primary key", () => {
    expect(FLAT).toContain(
      'CONSTRAINT "payer_applicant_stages_pkey" PRIMARY KEY("posting_kind","posting_id","worker_id")',
    );
  });

  it("cascades on worker delete (erasure needs no extra step) and indexes that FK", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "payer_applicant_stages_worker_id_idx" ON "${TABLE}" USING btree ("worker_id")`,
    );
  });

  it("posting_id and updated_by_payer_id reference nothing (polymorphic / faceless rails)", () => {
    expect([...FLAT.matchAll(/FOREIGN KEY/g)]).toHaveLength(1);
  });
});

describe("the table is locked (RLS tail is hand-appended)", () => {
  it("enables and FORCES row level security", () => {
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
  });

  it.each(["PUBLIC", "anon", "authenticated", "service_role"])(
    "revokes everything from %s",
    (role) => {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "${TABLE}" FROM ${role}`);
    },
  );

  it("declares no policy — deny by default", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0134 at idx 134, with a `when` above its predecessor's (the skip watermark)", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(134);
    expect(previous.tag).toBe("0133_agency_twin_match_skills");
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
