/**
 * Migration 0164 — `feature_pilot_subjects`, the pilot list for workers and admins (#2820).
 *
 * Pinned: additive only (one new table, nothing else touched); NO foreign key (a pilot row must
 * never block a worker's or an admin's deletion); the deny-by-default lock (ENABLE + hand-appended
 * FORCE + four REVOKEs, the part a regenerate drops); the CHECKs agreeing with the exported kinds
 * and with `feature_pilot_payers`' own; the LIVE model agreeing with the file; the operator
 * instructions (apply-before-PILOT, rollback); the schema-contract entry; and the slot. Nothing
 * here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { FEATURE_PILOT_SUBJECT_KINDS, featurePilotSubjects } from "./schema/feature-pilot";

const TAG = "0164_feature_pilot_subjects";
const TABLE = "feature_pilot_subjects";

const readMigration = (tag: string): string =>
  readFileSync(join(__dirname, "..", "migrations", `${tag}.sql`), "utf8");
const flatDdl = (raw: string): string => raw.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");

const RAW = readMigration(TAG);
const FLAT = flatDdl(RAW);
/** 0162's company pilot list: the same feature, added_by and reason rules hold here. */
const PAYERS_FLAT = flatDdl(readMigration("0162_job_audience_campus_drives"));

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const statements = FLAT.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

describe("the fixture is real", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header DISCUSSES the rollback DROP, which a naive scan would read as a statement.
    expect(RAW).toContain(`DROP TABLE IF EXISTS "${TABLE}"`);
    expect(FLAT).not.toContain("DROP TABLE");
  });
});

describe("0164 is additive only", () => {
  it("creates exactly one table, and it is the new one", () => {
    expect([...FLAT.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1])).toEqual([TABLE]);
  });

  it("alters only the new table, and only to lock it", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)" ([^;]+);/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(altered).toEqual([
      `${TABLE} ENABLE ROW LEVEL SECURITY`,
      `${TABLE} FORCE ROW LEVEL SECURITY`,
    ]);
  });

  it("drops, rewrites and renames nothing, and writes no row", () => {
    for (const statement of statements) {
      for (const verb of ["DROP ", "UPDATE ", "INSERT ", "DELETE ", "TRUNCATE"]) {
        expect(statement.toUpperCase().startsWith(verb), statement).toBe(false);
      }
    }
    for (const clause of [" DROP ", "RENAME", "ALTER COLUMN"]) {
      expect(FLAT.toUpperCase(), clause).not.toContain(clause);
    }
  });

  it("has NO foreign key: deleting a worker or an admin is never blocked by a pilot row", () => {
    expect(FLAT).not.toContain("FOREIGN KEY");
    expect(FLAT).not.toContain("REFERENCES");
    expect(getTableConfig(featurePilotSubjects).foreignKeys).toHaveLength(0);
  });
});

describe("the table is locked (the RLS tail is hand-appended)", () => {
  it("ENABLE + FORCE + the four REVOKEs", () => {
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT, role).toContain(`REVOKE ALL ON TABLE "${TABLE}" FROM ${role}`);
    }
    expect(FLAT).not.toContain("CREATE POLICY");
  });
});

describe("the key and the CHECKs", () => {
  it("one row per (feature, subject_kind, subject_id): the primary key is the read's probe", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "feature_pilot_subjects_pk" PRIMARY KEY("feature","subject_kind","subject_id")`,
    );
    expect(FLAT).toContain(`"subject_id" uuid NOT NULL`);
  });

  it("fps_subject_kind_chk is FEATURE_PILOT_SUBJECT_KINDS, and a company is not a kind", () => {
    const kinds = FEATURE_PILOT_SUBJECT_KINDS.map((k) => `'${k}'`).join(", ");
    expect(FLAT).toContain(`"${TABLE}"."subject_kind" IN (${kinds})`);
    expect(FEATURE_PILOT_SUBJECT_KINDS).not.toContain("payer");
  });

  // The same rule on both pilot lists, so a feature key or an `added_by` one list admits the other
  // admits too. `added_by` is the id charset only: never a person's name.
  it.each([
    ["feature_chk", (t: string) => `"${t}"."feature" ~ '^[a-z][a-z0-9_]{1,63}$'`],
    ["added_by_chk", (t: string) => `"${t}"."added_by" ~ '^[A-Za-z0-9._:-]{1,128}$'`],
    ["reason_chk", (t: string) => `char_length("${t}"."reason") BETWEEN 1 AND 500`],
  ])("fps_%s is feature_pilot_payers' rule, word for word", (suffix, rule) => {
    expect(FLAT).toContain(`CONSTRAINT "fps_${suffix}" CHECK (${rule(TABLE)})`);
    expect(PAYERS_FLAT).toContain(
      `CONSTRAINT "fpp_${suffix}" CHECK (${rule("feature_pilot_payers")})`,
    );
  });
});

describe("the LIVE model carries the same objects", () => {
  it("the table, its columns and RLS", () => {
    const config = getTableConfig(featurePilotSubjects);
    expect(config.name).toBe(TABLE);
    expect(config.enableRLS).toBe(true);
    expect(config.columns.map((c) => c.name).sort()).toEqual(
      ["added_by", "created_at", "feature", "reason", "subject_id", "subject_kind"].sort(),
    );
    expect(config.checks.map((c) => c.name).sort()).toEqual(
      ["fps_added_by_chk", "fps_feature_chk", "fps_reason_chk", "fps_subject_kind_chk"].sort(),
    );
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  const entry = JOURNAL.entries.find((e) => e.tag === TAG);

  it("says apply-before-PILOT (not before merge), and why a missing table fails closed", () => {
    expect(RAW).toContain("APPLY-BEFORE-PILOT, NOT APPLY-BEFORE-MERGE");
    expect(RAW).toContain("42P01");
    expect(RAW).toContain("fails closed");
    expect(RAW).toContain("LEDGER PRE-CHECK");
  });

  it("gives the rollback, with this migration's own ledger row", () => {
    expect(RAW).toContain("ROLLBACK");
    expect(RAW).toContain("THEME_ROLLOUT=off");
    expect(RAW).toContain(`DROP TABLE IF EXISTS "${TABLE}"`);
    expect(RAW).toContain(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${entry?.when ?? "?"};`,
    );
  });

  it("registers the lock in the schema contract, and NOT the table (nothing names it unswitched)", () => {
    const ours = SCHEMA_REQUIREMENTS.filter((r) => r.migration === TAG);
    expect(ours.map((r) => `${r.kind} ${r.table}`)).toEqual([`rls ${TABLE}`]);
  });

  it("holds the only 0164 slot, after 0163, with a later `when`", () => {
    expect(entry?.idx).toBe(164);
    expect(JOURNAL.entries.filter((e) => e.idx === 164)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.tag).toBe("0163_institute_grants_applications");
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
