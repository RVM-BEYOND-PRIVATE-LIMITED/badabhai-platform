/**
 * Migration 0165 — `display_prefs`, one login's theme (#2819).
 *
 * Pinned: additive only (one new table, nothing else touched); NO foreign key (`subject_id` names a
 * row in one of three tables); the deny-by-default lock (ENABLE + hand-appended FORCE + four
 * REVOKEs, the part a regenerate drops); the CHECKs agreeing with `@badabhai/types`' sets and the
 * default with `DEFAULT_DISPLAY_THEME`; the LIVE model agreeing with the file; the operator
 * instructions (apply-before-PILOT, the deferred erasure, rollback); the schema-contract entry; and
 * the slot. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISPLAY_THEME,
  DISPLAY_PREFS_SUBJECT_KINDS,
  DISPLAY_THEMES,
} from "@badabhai/types";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { displayPrefs } from "./schema/display-prefs";
import { schema } from "./schema";

const TAG = "0165_display_prefs";
const TABLE = "display_prefs";

const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const FLAT = RAW.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const statements = FLAT.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

describe("the fixture is real", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header DISCUSSES the rollback DROP, which a naive scan would read as a statement.
    expect(RAW).toContain(`DROP TABLE IF EXISTS "${TABLE}"`);
    expect(FLAT).not.toContain("DROP TABLE");
  });
});

describe("0165 is additive only", () => {
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

  it("has NO foreign key: subject_id names a row in one of three tables", () => {
    expect(FLAT).not.toContain("FOREIGN KEY");
    expect(FLAT).not.toContain("REFERENCES");
    expect(getTableConfig(displayPrefs).foreignKeys).toHaveLength(0);
  });
});

describe("the table is locked (the RLS tail is hand-appended)", () => {
  it("ENABLE + FORCE + the four REVOKEs, and no policy", () => {
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT, role).toContain(`REVOKE ALL ON TABLE "${TABLE}" FROM ${role}`);
    }
    expect(FLAT).not.toContain("CREATE POLICY");
  });
});

describe("the key, the CHECKs and the default", () => {
  it("one row per (subject_kind, subject_id): the primary key is every read's probe", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "display_prefs_pk" PRIMARY KEY("subject_kind","subject_id")`,
    );
    expect(FLAT).toContain(`"subject_id" uuid NOT NULL`);
  });

  it("display_prefs_subject_kind_chk is DISPLAY_PREFS_SUBJECT_KINDS: a login, never a tenant", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "display_prefs_subject_kind_chk" CHECK ("${TABLE}"."subject_kind" IN (${sqlList(DISPLAY_PREFS_SUBJECT_KINDS)}))`,
    );
  });

  it("display_prefs_theme_chk is DISPLAY_THEMES, and the column default is DEFAULT_DISPLAY_THEME", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "display_prefs_theme_chk" CHECK ("${TABLE}"."theme" IN (${sqlList(DISPLAY_THEMES)}))`,
    );
    expect(FLAT).toContain(`"theme" text DEFAULT '${DEFAULT_DISPLAY_THEME}' NOT NULL`);
  });
});

describe("the LIVE model carries the same objects", () => {
  it("the table, its columns, its checks and RLS, and it is in the schema object", () => {
    const config = getTableConfig(displayPrefs);
    expect(config.name).toBe(TABLE);
    expect(config.enableRLS).toBe(true);
    expect(config.columns.map((c) => c.name).sort()).toEqual(
      ["created_at", "subject_id", "subject_kind", "theme", "updated_at"].sort(),
    );
    expect(config.checks.map((c) => c.name).sort()).toEqual(
      ["display_prefs_subject_kind_chk", "display_prefs_theme_chk"].sort(),
    );
    expect(config.columns.find((c) => c.name === "theme")?.default).toBe(DEFAULT_DISPLAY_THEME);
    // rls-spine reconciles the live public tables against this object's size.
    expect(Object.values(schema)).toContain(displayPrefs);
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  const entry = JOURNAL.entries.find((e) => e.tag === TAG);

  it("says apply-before-PILOT (not before merge), and why a missing table fails closed", () => {
    expect(RAW).toContain("APPLY-BEFORE-PILOT, NOT APPLY-BEFORE-MERGE");
    expect(RAW).toContain("42P01");
    expect(RAW).toContain("42703");
    expect(RAW).toContain("fails closed");
    expect(RAW).toContain("LEDGER PRE-CHECK");
  });

  it("says no erasure path names the table yet, and where that is tracked", () => {
    expect(RAW).toContain("NO ERASURE PATH NAMES THE TABLE YET (#2837, risk R88)");
  });

  it("gives the rollback, with this migration's own ledger row", () => {
    expect(RAW).toContain("ROLLBACK");
    expect(RAW).toContain("THEME_ROLLOUT=off");
    expect(RAW).toContain(`DROP TABLE IF EXISTS "${TABLE}"`);
    expect(RAW).toContain(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${entry?.when ?? "?"};`,
    );
  });

  it("registers the table (every erasure names it since #2837) and the lock in the schema contract", () => {
    const ours = SCHEMA_REQUIREMENTS.filter((r) => r.migration === TAG);
    expect(ours.map((r) => `${r.kind} ${r.table}`)).toEqual([`table ${TABLE}`, `rls ${TABLE}`]);
  });

  it("holds the only 0165 slot, after 0164, with a later `when`", () => {
    expect(entry?.idx).toBe(165);
    expect(JOURNAL.entries.filter((e) => e.idx === 165)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.tag).toBe("0164_feature_pilot_subjects");
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
