/**
 * Migration 0138 — `payers` password-auth columns + email relaxations (#2497, #2506).
 *
 * The #2506 outage: #2501 merged code whose `PayersRepository` bare `select()` names the four
 * new `payers` columns, auto-deployed, while the database still lacked them — so EVERY payer
 * lookup (password AND OTP) threw `column ... does not exist` → 500. The migration was correctly
 * marked manual-apply-before-build, but unlike every apply-before-deploy migration since 0080 it
 * had NO schema-contract registration, so `db:audit:schema-contract` could not have caught the
 * drift. This test + the `0138-payers-password-hash` manifest entry close that hole.
 *
 * Pinned beyond the drift check: the exact statement set (four nullable ADD COLUMNs, four
 * DROP NOT NULL relaxations, two CREATE INDEXes, nothing dropped/rewritten/backfilled), each new
 * column's nullability, the LIVE model agreeing with the frozen file, the manual-apply-before-
 * build instruction + schema-contract registration, and the slot. Nothing here connects to a
 * database.
 *
 * FROZEN FILE (the 0089/0130 precedent): the `.sql` header predates the registration and names
 * no schema-contract id. Editing it now would change the ledger hash on a migration already
 * applied to production — so the header stays as-is and the registration lives in
 * `schema-contract.ts` + here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { payerMembers, payers } from "./schema/payer";

const TAG = "0138_payer_password_auth";
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

describe("the fixture is real", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("phone-only signup");
    expect(DDL).not.toContain("phone-only");
  });
});

describe("0138 is additive + relaxations only", () => {
  it("is four ADD COLUMN, four ALTER COLUMN relaxations and two CREATE INDEX — and nothing else", () => {
    // One leading SET lock_timeout + 4 ADD COLUMN + 4 ALTER COLUMN + 2 CREATE INDEX.
    expect(statements).toHaveLength(11);
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(4);
    expect((FLAT.match(/ALTER COLUMN/g) ?? []).length).toBe(4);
    expect((FLAT.match(/CREATE INDEX/g) ?? []).length).toBe(2);
    const upper = FLAT.toUpperCase();
    // `DROP NOT NULL` relaxations are the only DROP; no rewrite, no backfill, no CHECK/UNIQUE.
    const statementsOnly = upper.replace(/DROP NOT NULL/g, "");
    for (const verb of [
      "DROP ",
      "UPDATE ",
      "INSERT ",
      "DELETE ",
      "TRUNCATE",
      "RENAME",
      "ADD CONSTRAINT",
    ]) {
      expect(statementsOnly, verb).not.toContain(verb);
    }
  });

  it("the four new payers columns are nullable with no default", () => {
    for (const col of [
      '"payers" ADD COLUMN "org_name_lookup_hash" text',
      '"payers" ADD COLUMN "password_hash" text',
      '"payers" ADD COLUMN "password_set_at" timestamp with time zone',
      '"payers" ADD COLUMN "password_pepper_version" integer',
    ]) {
      const line = statementFor(col);
      expect(line, col).not.toContain("NOT NULL");
      expect(line, col).not.toContain("DEFAULT");
    }
  });

  it("the four relaxations drop NOT NULL on the email columns only", () => {
    for (const col of [
      '"payer_members" ALTER COLUMN "email_enc" DROP NOT NULL',
      '"payer_members" ALTER COLUMN "email_hash" DROP NOT NULL',
      '"payers" ALTER COLUMN "email_enc" DROP NOT NULL',
      '"payers" ALTER COLUMN "email_hash" DROP NOT NULL',
    ]) {
      expect(statementFor(col), col).not.toHaveLength(0);
    }
  });

  it("adds the org-lookup and phone lookup indexes", () => {
    expect(statementFor('"payers_org_lookup_hash_idx"')).toContain(
      'ON "payers" USING btree ("org_name_lookup_hash")',
    );
    expect(statementFor('"payers_phone_hash_idx"')).toContain(
      'ON "payers" USING btree ("phone_hash")',
    );
  });
});

describe("the LIVE model carries the same columns", () => {
  it("models the four new payers columns as nullable with no default", () => {
    for (const name of [
      "org_name_lookup_hash",
      "password_hash",
      "password_set_at",
      "password_pepper_version",
    ]) {
      const col = getTableConfig(payers).columns.find((c) => c.name === name);
      expect(col, name).toBeDefined();
      expect(col!.notNull, name).toBe(false);
      expect(col!.hasDefault, name).toBe(false);
    }
  });

  it("models the relaxed email columns as nullable (phone-only signup, #2497)", () => {
    for (const [table, name] of [
      [payers, "email_enc"],
      [payers, "email_hash"],
      [payerMembers, "email_enc"],
      [payerMembers, "email_hash"],
    ] as const) {
      const col = getTableConfig(table).columns.find((c) => c.name === name);
      expect(col, `${getTableConfig(table).name}.${name}`).toBeDefined();
      expect(col!.notNull, name).toBe(false);
    }
  });

  it("models both lookup indexes", () => {
    const names = getTableConfig(payers).indexes.map((i) => i.config.name);
    expect(names).toContain("payers_org_lookup_hash_idx");
    expect(names).toContain("payers_phone_hash_idx");
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  it("says manual-apply-BEFORE-the-build; the manifest names the bare-select readers", () => {
    expect(RAW).toContain("Manual apply by Divyanshu BEFORE the build");
    // The frozen header names no reader — the pin is the manifest entry's requiredBy.
    const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === "0138-payers-password-hash");
    for (const reader of ["findByEmail", "findByPhone", "findByOrgName"]) {
      expect(entry?.requiredBy, reader).toContain(reader);
    }
  });

  it("is registered in the schema contract (registration lives outside the frozen file)", () => {
    // The 0089/0130 precedent: the applied file's header is frozen (ledger hash), so — unlike
    // 0131–0133 — RAW names no schema-contract id. The pin is the manifest entry itself.
    expect(RAW).not.toContain("0138-payers-password-hash");
    const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === "0138-payers-password-hash");
    expect(entry).toMatchObject({
      migration: TAG,
      kind: "column",
      table: "payers",
      object: "password_hash",
    });
  });

  it("states the lock guidance and the rollback", () => {
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain("ROLLBACK");
    expect(RAW).toContain("drop the added columns/indexes");
  });

  it("holds the only 0138 slot, after 0137, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(138);
    expect(JOURNAL.entries.filter((e) => e.idx === 138)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(137);
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
