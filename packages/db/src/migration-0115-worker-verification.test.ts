/**
 * Migration 0115 — `workers.verification_state` + `verified_at` (Layer A (g)).
 *
 * Pinned beyond the drift check: additive-only on the hottest worker table, two nullable columns
 * with no defaults, the five-value CHECK, the rollback and the slot. Nothing here connects to a
 * database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0115_worker_verification";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real", () => {
  it("reads a migration that adds both columns and the vocabulary CHECK", () => {
    expect(FLAT).toContain('ADD COLUMN "verification_state" text');
    expect(FLAT).toContain('ADD COLUMN "verified_at" timestamp with time zone');
    expect(FLAT).toContain('CONSTRAINT "workers_verification_state_chk"');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("workers.verification_state / verified_at: the verification tier");
    expect(DDL).not.toContain("verification tier");
  });
});

describe("0115 is additive", () => {
  it("touches only workers, adds two columns, and drops nothing", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["workers"]);
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(2);
    for (const verb of ["DROP COLUMN", "DROP TABLE", "TRUNCATE", "UPDATE "]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("both columns are NULLABLE with no default — catalog-only, no rewrite", () => {
    for (const column of ["verification_state", "verified_at"]) {
      const line = FLAT.match(new RegExp(`ADD COLUMN "${column}"[^;]*`))?.[0] ?? "";
      expect(line).not.toContain("NOT NULL");
      expect(line).not.toContain("DEFAULT");
    }
  });

  it("states the rollback and holds the only 0115 slot", () => {
    expect(RAW).toContain('DROP COLUMN "verification_state"');
    expect(RAW).toContain('DROP COLUMN "verified_at"');
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(115);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(114);
  });
});

describe("the vocabulary CHECK", () => {
  it("closes exactly Part 10's five values and allows NULL", () => {
    const chk = FLAT.match(/"workers_verification_state_chk" CHECK[^;]*/)?.[0] ?? "";
    expect(chk).toContain("IS NULL");
    for (const state of [
      "self-declared",
      "RVM-attested",
      "document-verified",
      "EPFO-verified",
      "employer-rated",
    ]) {
      expect(chk).toContain(`'${state}'`);
    }
  });

  it("does NOT encode the printed label — the UI mapping is TypeScript, not SQL", () => {
    // A future two-tier -> three-tier UI change must not require a migration.
    expect(FLAT).not.toContain("BadaBhai Verified");
  });
});
