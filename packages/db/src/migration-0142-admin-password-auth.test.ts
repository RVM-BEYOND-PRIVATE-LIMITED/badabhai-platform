/**
 * Migration 0142 — `admin_users` password sign-in + the per-admin two-step switch (owner rulings
 * 2026-11-03, incl. Amendment 1: two-step optional, starts OFF for everyone).
 *
 * Registered in the schema contract from day one — the #2506 lesson (0138 shipped without an
 * entry, auto-deployed ahead of its manual apply, and every payer lookup 500'd). `admin_users` is
 * read through bare `select()` on EVERY admin request, so the same miss here would take down the
 * whole Admin Portal.
 *
 * Pinned: the exact statement set (one SET lock_timeout + five ADD COLUMNs — nothing dropped,
 * renamed, constrained or backfilled), each column's nullability/default, the LIVE model agreeing
 * with the file, the operator instructions (apply-before-deploy, rollback, the schema-contract id)
 * and the slot. Nothing here connects to a database.
 *
 * NO BACKFILL, on purpose (owner ruling 2026-11-03): two-step starts OFF for EVERY admin — the one
 * production admin is already `mfa_enrolled`, and an `mfa_enabled = mfa_enrolled` copy would have
 * switched two-step ON for exactly the person who ruled it off. The no-UPDATE assertion below is
 * the guard against that copy creeping back in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { adminUsers } from "./schema/ops";

const TAG = "0142_admin_password_auth";
const CONTRACT_ID = "0142-admin-users-password-hash";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const statements = FLAT.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// String scan, not a dynamic RegExp (semgrep detect-non-literal-regexp; the 0133 precedent).
const statementFor = (needle: string): string => statements.find((s) => s.includes(needle)) ?? "";

const NULLABLE = [
  ['"admin_users" ADD COLUMN "password_hash" text', "password_hash"],
  ['"admin_users" ADD COLUMN "password_set_at" timestamp with time zone', "password_set_at"],
  ['"admin_users" ADD COLUMN "password_pepper_version" integer', "password_pepper_version"],
] as const;
const DEFAULTED = [
  ['"admin_users" ADD COLUMN "must_change_password" boolean', "must_change_password"],
  ['"admin_users" ADD COLUMN "mfa_enabled" boolean', "mfa_enabled"],
] as const;

describe("the fixture is real", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header DISCUSSES the backfill it refuses (`mfa_enabled = mfa_enrolled`) — prose that a
    // naive scan would mistake for the statement itself.
    expect(RAW).toContain("deliberately NO `mfa_enabled = mfa_enrolled` backfill");
    expect(DDL).not.toContain("mfa_enrolled");
  });
});

describe("0142 is additive only", () => {
  it("is SET lock_timeout + five ADD COLUMN — and nothing else", () => {
    expect(statements).toHaveLength(6);
    expect(statements[0]).toBe("SET lock_timeout='3s'");
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(5);
    for (const verb of [
      "DROP ",
      "UPDATE ",
      "INSERT ",
      "DELETE ",
      "TRUNCATE",
      "RENAME",
      "ADD CONSTRAINT",
      "ALTER COLUMN",
      "CREATE INDEX",
    ]) {
      expect(FLAT.toUpperCase(), verb).not.toContain(verb);
    }
  });

  it("the three password columns are nullable with no default", () => {
    for (const [col] of NULLABLE) {
      const line = statementFor(col);
      expect(line, col).not.toHaveLength(0);
      expect(line, col).not.toContain("NOT NULL");
      expect(line, col).not.toContain("DEFAULT");
    }
  });

  it("must_change_password and mfa_enabled are NOT NULL DEFAULT false (catalog-only fast default)", () => {
    for (const [col] of DEFAULTED) {
      expect(statementFor(col), col).toContain("DEFAULT false NOT NULL");
    }
  });

  it("two-step starts OFF for everyone: mfa_enabled is never derived from mfa_enrolled", () => {
    // Owner ruling — an already-enrolled admin is NOT switched on. No statement may read the
    // enrolment flag, whatever verb carries it.
    expect(FLAT).not.toContain("mfa_enrolled");
    expect(statementFor('ADD COLUMN "mfa_enabled"')).toContain("DEFAULT false NOT NULL");
  });
});

describe("the LIVE model carries the same columns", () => {
  const cols = getTableConfig(adminUsers).columns;

  it("models the three password columns as nullable with no default", () => {
    for (const [, name] of NULLABLE) {
      const col = cols.find((c) => c.name === name);
      expect(col, name).toBeDefined();
      expect(col!.notNull, name).toBe(false);
      expect(col!.hasDefault, name).toBe(false);
    }
  });

  it("models must_change_password + mfa_enabled as NOT NULL with a false default", () => {
    for (const [, name] of DEFAULTED) {
      const col = cols.find((c) => c.name === name);
      expect(col, name).toBeDefined();
      expect(col!.notNull, name).toBe(true);
      expect(col!.default, name).toBe(false);
    }
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  it("says manual-apply-BEFORE-the-deploy and names the schema-contract id", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    expect(RAW).toContain("Manual apply by Divyanshu BEFORE the build");
    expect(RAW).toContain(CONTRACT_ID);
  });

  it("is registered in the schema contract against the bare-select readers", () => {
    const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === CONTRACT_ID);
    expect(entry).toMatchObject({
      migration: TAG,
      kind: "column",
      table: "admin_users",
      object: "password_hash",
    });
    for (const reader of ["findByEmailHash", "findById", "validateAndTouch"]) {
      expect(entry?.requiredBy, reader).toContain(reader);
    }
  });

  it("states the lock guidance and the rollback for every added column", () => {
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain("ROLLBACK");
    for (const [, name] of [...NULLABLE, ...DEFAULTED]) {
      expect(RAW, name).toContain(`DROP COLUMN IF EXISTS "${name}"`);
    }
  });

  it("holds the only 0142 slot, after 0141, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(142);
    expect(JOURNAL.entries.filter((e) => e.idx === 142)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(141);
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
