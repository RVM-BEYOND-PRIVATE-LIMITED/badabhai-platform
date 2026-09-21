/**
 * Migration 0114 — `worker_occupation` (Layer A (f), ADR-0042 D9).
 *
 * Pinned beyond the drift check: additive-only, the shape-only role CHECK, the RLS tail, the
 * rollback and the slot. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0114_worker_occupation";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real", () => {
  it("reads a migration that creates the table with the shape checks", () => {
    expect(FLAT).toContain('CREATE TABLE "worker_occupation"');
    expect(FLAT).toContain('CONSTRAINT "wo_role_id_chk"');
    expect(FLAT).toContain('CONSTRAINT "wo_sort_order_chk"');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("worker_occupation: the worker's declared SECONDARY occupations");
    expect(DDL).not.toContain("SECONDARY occupations");
  });
});

describe("0114 is additive", () => {
  it("alters only the new table and drops nothing", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["worker_occupation"]);
    for (const verb of ["DROP TABLE", "DROP COLUMN", "TRUNCATE"]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    expect(FLAT.toUpperCase()).not.toContain('UPDATE "');
  });

  it("states the rollback and holds the only 0114 slot", () => {
    expect(RAW).toContain('DROP TABLE "worker_occupation"');
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(114);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(113);
  });
});

describe("the role CHECK is shape, not membership", () => {
  it("accepts any role_* slug and never enumerates the 13 ids", () => {
    // The vocabulary lives in @badabhai/taxonomy; a CHECK duplicating it here would be a second
    // list to forget (the `wl_language_chk` split, restated). A baked-in id would read as a
    // membership check and drift the moment a role is appended.
    expect(FLAT).toMatch(/"wo_role_id_chk" CHECK[^;]*\^role_\[a-z_\]\+/);
    expect(FLAT).not.toContain("role_cnc_operator");
  });

  it("one row per role and one row per position, both unique per worker", () => {
    expect(FLAT).toContain(
      'CREATE UNIQUE INDEX "wo_worker_role_uq" ON "worker_occupation" USING btree ("worker_id","role_id")',
    );
    expect(FLAT).toContain(
      'CREATE UNIQUE INDEX "wo_worker_sort_uq" ON "worker_occupation" USING btree ("worker_id","sort_order")',
    );
  });

  it("cascades with the worker (DPDP erasure is the cascade)", () => {
    expect(FLAT).toContain('FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id")');
    expect(FLAT).toContain("ON DELETE cascade");
  });

  it("RLS is forced and every role revoked, with no policy", () => {
    expect(FLAT).toContain('ALTER TABLE "worker_occupation" FORCE ROW LEVEL SECURITY');
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "worker_occupation" FROM ${role}`);
    }
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
  });
});
