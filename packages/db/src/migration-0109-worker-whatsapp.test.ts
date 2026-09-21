/**
 * Migration 0109 — `workers.whatsapp_enc`, one nullable encrypted column.
 *
 * WHAT THIS FILE IS FOR, given that the drizzle model and `db:generate` already guarantee the
 * column exists and CI's drift check compares model to SQL. Two properties are NOT visible to
 * that comparison and are exactly the ones a merge can quietly break:
 *
 *   1. THE MIGRATION IS ADDITIVE. One `ADD COLUMN` and one `ADD CONSTRAINT`; no DROP, no
 *      re-type, no data movement. The column is nullable with no default, so the DDL is
 *      catalog-only and an app deployed ahead of it loses nothing but the feature.
 *   2. THE CHECK IS A CIPHERTEXT SHAPE CHECK. It refuses prose (a plaintext number written by
 *      a future writer that forgot `PiiCryptoService`), which is the whole privacy argument
 *      for this column and the `ai_call_traces` precedent applied verbatim.
 *
 * Nothing here connects to a database — it reads the committed SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0109_worker_whatsapp_enc";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that exists and carries both statements", () => {
    expect(FLAT).toContain('ALTER TABLE "workers" ADD COLUMN "whatsapp_enc" text');
    expect(FLAT).toContain('ADD CONSTRAINT "workers_whatsapp_enc_token_chk"');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("whatsapp_enc: the worker's own WhatsApp number");
    expect(DDL).not.toContain("the worker's own WhatsApp number");
  });
});

describe("0109 is additive and reversible", () => {
  it("adds exactly one nullable column and one constraint, and alters no other table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["workers"]);
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(1);
    expect(FLAT).not.toContain("NOT NULL");
    expect(FLAT).not.toContain("DEFAULT");
  });

  it("drops nothing and truncates nothing", () => {
    for (const verb of ["DROP TABLE", "DROP COLUMN", "DROP CONSTRAINT", "TRUNCATE", "UPDATE "]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("states the exact rollback in the header", () => {
    expect(RAW).toContain('DROP CONSTRAINT "workers_whatsapp_enc_token_chk"');
    expect(RAW).toContain('DROP COLUMN "whatsapp_enc"');
  });

  it("holds the only 0109 slot in the journal, contiguous with 0108", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(109);
    expect(JOURNAL.entries.filter((e) => e.idx === 109)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(108);
  });
});

describe("the column is ciphertext by construction", () => {
  it("the CHECK refuses anything that is not a v1/v2 encryptPii token", () => {
    // NULL is legal (no number on file IS the ordinary state); a non-NULL value must match the
    // token shape. Both halves are asserted because either one alone is the wrong constraint:
    // without IS NULL the column could not be empty, without the regex it accepts prose.
    const chk = FLAT.match(/"workers_whatsapp_enc_token_chk" CHECK \(([^;]*?)\)\s*;/)?.[1] ?? "";
    expect(chk).toContain("IS NULL");
    expect(chk).toContain("v1");
    expect(chk).toContain("v2");
    expect(chk).toContain("~");
  });
});

describe("the migration advertises its ordering", () => {
  it("says APPLY-BEFORE-DEPLOY, because a bare workers select() names every model column", () => {
    // `WorkersRepository.findById` is `select()` over the model, so a build carrying the
    // column against a database without it fails EVERY workers read, not just the new routes.
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
  });
});
