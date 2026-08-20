import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE KEY-ROTATION COVERAGE GUARD.
 *
 * `reencrypt-pii-backfill.ts` is the only thing that moves an at-rest ciphertext onto a new kid,
 * so a column missing from its `TARGETS` list can never be rotated — and an old kid can then
 * never be retired without silently breaking every read of that column. The list was hand-kept
 * and its header only says "keep in sync with schema.ts", which is the instruction that failed:
 * `admin_users.name_enc` sat outside it from the day the column was added.
 *
 * That was INVISIBLE for as long as nothing decrypted the column. The 2026-08-18 identity ruling
 * gave it a read site (`/admins`), where the failure mode is not an error but a WRONG ANSWER —
 * `AdminIdentityService.decryptOrNull` degrades a failed decrypt to `null`, and the console
 * renders `null` as a dash titled "No name on record for this account." So a rotation that
 * skipped the column would tell an operator that every admin is nameless.
 *
 * DERIVED FROM THE SCHEMA, not from a second hand-kept list — the whole point. Every encrypted
 * column the schema declares must either have a target or be named below as a deliberate
 * exception. Adding an `_enc` column and forgetting the backfill is now a build failure.
 */

const SCHEMA_DIR = join(__dirname, "schema");
const BACKFILL = readFileSync(join(__dirname, "reencrypt-pii-backfill.ts"), "utf8");

/**
 * Columns that hold an `encryptPii` token but are NOT spelled `*_enc`, so the suffix rule below
 * cannot find them. Both are on `workers` and both are in TARGETS.
 */
const EXTRA_ENCRYPTED_COLUMNS = ["phone_e164", "full_name"];

/**
 * Encrypted columns deliberately NOT rotated by the backfill, each with the reason.
 *
 * `admin_users.mfa_secret_enc` — the TOTP seed. It is a PRE-EXISTING gap, NOT a decision: it is
 * written by `bootstrap-admin.ts` with `encryptPii` and read by `admin-mfa.store.ts`, so a
 * retired kid would lock every enrolled admin out of their second factor. It is listed here
 * rather than fixed because it is unrelated to the change that added this test, and rotating an
 * authentication secret is an ops procedure that needs its own runbook step (re-enrolment is the
 * recovery, not a re-encrypt). ESCALATED — do not treat this entry as a sign-off.
 */
const KNOWN_EXCEPTIONS: Record<string, string> = {
  "admin_users.mfa_secret_enc": "TOTP seed — pre-existing gap, escalated separately",
};

/** Every `(table, column)` pair the schema declares as an encrypted column. */
function declaredEncryptedColumns(): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  for (const file of readdirSync(SCHEMA_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(SCHEMA_DIR, file), "utf8");
    // `export const adminUsers = pgTable("admin_users", { ... text("name_enc") ... })`
    for (const tbl of src.matchAll(/pgTable\(\s*"([a-z0-9_]+)"\s*,\s*\{/g)) {
      const tableName = tbl[1]!;
      // Scan forward from this pgTable to the next one — good enough for a column-name scan,
      // since a column literal cannot appear between two tables without belonging to the first.
      const start = tbl.index! + tbl[0].length;
      const nextTable = src.slice(start).search(/pgTable\(\s*"[a-z0-9_]+"\s*,\s*\{/);
      const body = src.slice(start, nextTable === -1 ? undefined : start + nextTable);
      for (const col of body.matchAll(/\b(?:text|varchar)\(\s*"([a-z0-9_]+)"/g)) {
        const column = col[1]!;
        if (column.endsWith("_enc") || EXTRA_ENCRYPTED_COLUMNS.includes(column)) {
          out.push({ table: tableName, column });
        }
      }
    }
  }
  return out;
}

describe("PII re-encrypt backfill covers every encrypted column the schema declares", () => {
  it("finds the encrypted columns at all (the derivation is not vacuously empty)", () => {
    const found = declaredEncryptedColumns();
    // A regex over source can go silently empty when the schema's formatting changes, and an
    // empty derivation would make the assertion below pass while proving nothing.
    expect(found.length).toBeGreaterThanOrEqual(13);
    expect(found).toContainEqual({ table: "workers", column: "full_name" });
    expect(found).toContainEqual({ table: "admin_users", column: "name_enc" });
    expect(found).toContainEqual({ table: "payers", column: "org_name_enc" });
  });

  it("every encrypted column has a backfill target, or is a NAMED exception", () => {
    const missing: string[] = [];
    for (const { table, column } of declaredEncryptedColumns()) {
      const key = `${table}.${column}`;
      if (key in KNOWN_EXCEPTIONS) continue;
      // A target is `target(tbl, tbl.id, tbl.col, "<table>", "<column>", "<dataKey>")`, so the
      // table+column string pair appearing together is the signal.
      const hasTarget = new RegExp(`"${table}"\\s*,\\s*"${column}"`).test(BACKFILL);
      if (!hasTarget) missing.push(key);
    }
    expect(
      missing,
      `these encrypted columns can never be rotated onto a new kid, so no old kid can be ` +
        `retired while they exist. Add a target() in reencrypt-pii-backfill.ts, or add a ` +
        `documented entry to KNOWN_EXCEPTIONS. Missing: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("...and that rule is CAPABLE of failing (the exact gap it was written for)", () => {
    // `admin_users.name_enc` was the real miss. Prove the matcher would have seen its absence
    // rather than trusting that it would — a column-name substring match ("name_enc" appears
    // inside "org_name_enc") would have reported it as covered.
    const targetFor = (t: string, c: string, src: string) =>
      new RegExp(`"${t}"\\s*,\\s*"${c}"`).test(src);
    expect(targetFor("admin_users", "name_enc", BACKFILL)).toBe(true);
    expect(targetFor("admin_users", "name_enc", `target(x, x.id, x.o, "payers", "org_name_enc",`)).toBe(
      false,
    );
    expect(targetFor("admin_users", "name_enc", `target(x, x.id, x.e, "admin_users", "email_enc",`)).toBe(
      false,
    );
  });

  it("every KNOWN_EXCEPTION is a column that really exists (no stale suppressions)", () => {
    // An exception naming a dropped column would silently suppress nothing while looking like a
    // considered decision, and would be the first thing to rot.
    const declared = new Set(declaredEncryptedColumns().map((c) => `${c.table}.${c.column}`));
    for (const key of Object.keys(KNOWN_EXCEPTIONS)) {
      expect(declared, `KNOWN_EXCEPTIONS names ${key}, which the schema does not declare`).toContain(
        key,
      );
    }
  });
});
