/**
 * Migration 0110 — `worker_language`: one new, empty, locked table.
 *
 * The drizzle model and CI's drift check already guarantee the columns exist and match. What
 * they do NOT see, and what this file pins, is the half that lives in the hand-edits:
 *
 *   1. THE MIGRATION IS ADDITIVE — one CREATE TABLE and the objects that belong to it. Not one
 *      shipped table is altered, and nothing is dropped.
 *   2. THE RLS TAIL IS PRESENT. `drizzle-kit generate` emits only `ENABLE`; FORCE and the four
 *      REVOKEs are hand-appended and a regenerate drops them silently. With no policy and FORCE
 *      on, the table is closed to every role but the backend connection — including its owner.
 *   3. THE COHERENCE CHECKS EXIST, because those are the guarantees a hand-written row meets
 *      even when no service is in the path.
 *
 * Nothing here connects to a database — it reads the committed SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0110_worker_language";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that exists and creates the table", () => {
    expect(FLAT).toContain('CREATE TABLE "worker_language"');
    expect(FLAT).toContain("ENABLE ROW LEVEL SECURITY");
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("worker_language: which languages a worker speaks, reads and writes");
    expect(DDL).not.toContain("which languages a worker speaks");
  });
});

describe("0110 is additive", () => {
  it("creates one table and alters no shipped one", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(altered.length).toBeGreaterThan(0);
    expect([...new Set(altered)]).toEqual(["worker_language"]);
  });

  it("drops nothing and truncates nothing", () => {
    for (const verb of ["DROP TABLE", "DROP COLUMN", "DROP CONSTRAINT", "TRUNCATE"]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("states the rollback in the header", () => {
    expect(RAW).toContain('DROP TABLE "worker_language";');
  });

  it("holds the only 0110 slot in the journal, contiguous with 0109", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(110);
    expect(JOURNAL.entries.filter((e) => e.idx === 110)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(109);
  });
});

describe("the coherence checks a hand-written row still meets", () => {
  it("ticks-or-nothing: a row with no ability is refused", () => {
    expect(FLAT).toContain('CONSTRAINT "wl_ability_chk"');
    const chk = FLAT.match(/"wl_ability_chk" CHECK \(([^;]*?)\)/)?.[1] ?? "";
    for (const col of ["can_speak", "can_read", "can_write"]) expect(chk).toContain(col);
  });

  it("the slug is shape-checked, never a free sentence", () => {
    expect(FLAT).toMatch(/"wl_language_chk" CHECK[^;]*\^\[a-z_\]\+\$/);
  });

  it("one row per language and per position", () => {
    expect(FLAT).toMatch(
      /CREATE UNIQUE INDEX "wl_worker_language_uq" ON "worker_language"[^;]*"worker_id","language"/,
    );
    expect(FLAT).toMatch(
      /CREATE UNIQUE INDEX "wl_worker_sort_uq" ON "worker_language"[^;]*"worker_id","sort_order"/,
    );
  });
});

describe("RLS: locked like every other table in this database", () => {
  it("enables, FORCES and REVOKEs — with no policy, so the default is deny", () => {
    expect(FLAT).toContain('ALTER TABLE "worker_language" ENABLE ROW LEVEL SECURITY');
    expect(FLAT).toContain('ALTER TABLE "worker_language" FORCE ROW LEVEL SECURITY');
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "worker_language" FROM ${role}`);
    }
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
  });
});
