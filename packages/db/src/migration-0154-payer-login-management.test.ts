/**
 * Migration 0154 — payer login management (#2563): temporary password, revoke, session
 * invalidation and last sign-in.
 *
 * Registered in the schema contract from day one — the #2506 lesson (0138 shipped without an
 * entry, auto-deployed ahead of its manual apply, and every payer lookup 500'd). `payers` is
 * read through bare `select()` and `PayerAuthGuard` resolves auth facts on EVERY payer
 * request, so the same miss here would take down payer authentication.
 *
 * Pinned: the exact statement set (one SET lock_timeout + four ADD COLUMNs — nothing dropped,
 * renamed, constrained or backfilled), each column's nullability/default, the LIVE model
 * agreeing with the file, the operator instructions (apply-before-deploy, rollback, the
 * schema-contract id) and the slot. Nothing here connects to a database.
 *
 * NO BACKFILL, on purpose: every existing payer keeps `must_change_password = false`,
 * `password_revoked_at = NULL` and `sessions_valid_after = NULL`, so the deploy changes no
 * existing sign-in or session.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { payers } from "./schema/payer";

const TAG = "0154_payer_login_management";
const CONTRACT_ID = "0154-payers-sessions-valid-after";
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
  ['"payers" ADD COLUMN "password_revoked_at" timestamp with time zone', "password_revoked_at"],
  ['"payers" ADD COLUMN "sessions_valid_after" timestamp with time zone', "sessions_valid_after"],
  ['"payers" ADD COLUMN "last_login_at" timestamp with time zone', "last_login_at"],
] as const;
const DEFAULTED = [
  ['"payers" ADD COLUMN "must_change_password" boolean', "must_change_password"],
] as const;

describe("the fixture is real", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header DISCUSSES the rollback DROPs and the pre-deploy build — prose that a naive
    // scan would mistake for statements.
    expect(RAW).toContain("only AFTER rolling the API back");
    expect(DDL).not.toContain("only AFTER rolling the API back");
  });
});

describe("0154 is additive only", () => {
  it("is SET lock_timeout + four ADD COLUMN — and nothing else", () => {
    expect(statements).toHaveLength(5);
    expect(statements[0]).toBe("SET lock_timeout='3s'");
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(4);
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

  it("the three session/login columns are nullable with no default", () => {
    for (const [col] of NULLABLE) {
      const line = statementFor(col);
      expect(line, col).not.toHaveLength(0);
      expect(line, col).not.toContain("NOT NULL");
      expect(line, col).not.toContain("DEFAULT");
    }
  });

  it("must_change_password is NOT NULL DEFAULT false (catalog-only fast default)", () => {
    for (const [col] of DEFAULTED) {
      expect(statementFor(col), col).toContain("DEFAULT false NOT NULL");
    }
  });
});

describe("the LIVE model carries the same columns", () => {
  const cols = getTableConfig(payers).columns;

  it("models the three session/login columns as nullable with no default", () => {
    for (const [, name] of NULLABLE) {
      const col = cols.find((c) => c.name === name);
      expect(col, name).toBeDefined();
      expect(col!.notNull, name).toBe(false);
      expect(col!.hasDefault, name).toBe(false);
    }
  });

  it("models must_change_password as NOT NULL with a false default", () => {
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
    expect(RAW).toContain("Manual apply BEFORE the build");
    expect(RAW).toContain(CONTRACT_ID);
  });

  it("is registered in the schema contract against the bare-select readers", () => {
    const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === CONTRACT_ID);
    expect(entry).toMatchObject({
      migration: TAG,
      kind: "column",
      table: "payers",
      object: "sessions_valid_after",
    });
    for (const reader of ["PayersRepository", "findAuthFacts", "PayerAuthGuard"]) {
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

  it("holds the only 0154 slot, after 0153, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(154);
    expect(JOURNAL.entries.filter((e) => e.idx === 154)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(153);
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
