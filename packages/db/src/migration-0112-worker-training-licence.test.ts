/**
 * Migration 0112 — `worker_training` + the private licence columns on `worker_certificate`.
 *
 * Pinned here, beyond the model↔SQL drift check:
 *
 *   1. ADDITIVE — one CREATE TABLE and two nullable ADD COLUMNs; nothing dropped, nothing re-typed.
 *   2. THE RLS TAIL IS PRESENT on the new table (FORCE + four REVOKEs, no policy).
 *   3. THE LICENCE NUMBER IS CIPHERTEXT-SHAPED — the same token CHECK `workers.whatsapp_enc` uses.
 *
 * Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0112_worker_training_licence";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that creates the table and adds both columns", () => {
    expect(FLAT).toContain('CREATE TABLE "worker_training"');
    expect(FLAT).toContain('ADD COLUMN "licence_number_enc" text');
    expect(FLAT).toContain('ADD COLUMN "licence_expiry" date');
    expect(FLAT).toContain("ENABLE ROW LEVEL SECURITY");
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("worker_training + the PRIVATE licence fields");
    expect(DDL).not.toContain("the PRIVATE licence fields");
  });
});

describe("0112 is additive and data-preserving", () => {
  it("alters only the two tables it is about, and adds only the two columns", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)].sort()).toEqual(["worker_certificate", "worker_training"]);
    const addColumns = FLAT.match(/ADD COLUMN "[a-z_]+" [a-z]+/g) ?? [];
    expect(addColumns).toEqual([
      'ADD COLUMN "licence_number_enc" text',
      'ADD COLUMN "licence_expiry" date',
    ]);
    for (const verb of ["DROP TABLE", "DROP COLUMN", "TRUNCATE"]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    // An UPDATE statement can only target a quoted table name; the FK's `ON UPDATE no action`
    // must not read as one.
    expect(FLAT.toUpperCase()).not.toContain('UPDATE "');
  });

  it("states the rollback in the header", () => {
    expect(RAW).toContain('DROP TABLE "worker_training";');
    expect(RAW).toContain('DROP COLUMN "licence_number_enc"');
  });

  it("holds the only 0112 slot in the journal, contiguous with 0111", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(112);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(111);
  });
});

describe("privacy by construction", () => {
  it("the licence number is ciphertext-shaped, and NULL is legal", () => {
    const chk = FLAT.match(/"wc_licence_number_enc_token_chk" CHECK \(([^;]*?)\);/)?.[1] ?? "";
    expect(chk).toContain("IS NULL");
    expect(chk).toContain("v1");
    expect(chk).toContain("v2");
    expect(chk).toContain("~");
  });

  it("the expiry is a plain DATE with a sanity floor", () => {
    const chk = FLAT.match(/"wc_licence_expiry_chk" CHECK \(([^;]*?)\);/)?.[1] ?? "";
    expect(chk).toContain("DATE");
    expect(chk).toContain("1950-01-01");
  });
});

describe("RLS: the new table is locked like every other", () => {
  it("enables, FORCES and REVOKEs — with no policy, so the default is deny", () => {
    expect(FLAT).toContain('ALTER TABLE "worker_training" FORCE ROW LEVEL SECURITY');
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "worker_training" FROM ${role}`);
    }
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
  });
});
