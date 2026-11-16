/**
 * Migration 0168 — `worker_search_exits`, a worker who left company search (#2753 item 6).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table, no index of its own (the primary key backs the cascade). Nothing
 *      dropped, no existing table altered: a side table, not a column on the hot `workers` table.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARY — the `via` CHECK is exactly its shared constant.
 *   4. ONE EXIT PER WORKER — `worker_id` is the primary key; erasure cascades.
 *   5. IDS ONLY — no name, phone or free-text column.
 *   6. THE HEADER — deploy order (before the SWITCH), the lock note and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { WORKER_SEARCH_EXIT_VIAS } from "./schema/worker-search-exit";

const TAG = "0168_worker_search_exits";
const TABLE = "worker_search_exits";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const snapshot = (n: string): { id: string; prevId: string; tables: Record<string, unknown> } =>
  JSON.parse(
    readFileSync(join(__dirname, "..", "migrations", "meta", `${n}_snapshot.json`), "utf8"),
  );

/** The quoted values of one CHECK, in order. */
function checkValues(constraint: string): string[] {
  const head = `CONSTRAINT "${constraint}" CHECK (`;
  const start = FLAT.indexOf(head);
  if (start < 0) throw new Error(`${constraint} not found`);
  const end = FLAT.indexOf(")", FLAT.indexOf("IN (", start));
  const body = FLAT.slice(start + head.length, end < 0 ? undefined : end);
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${TABLE}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE SWITCH");
    expect(DDL).not.toContain("APPLY BEFORE THE SWITCH");
  });
});

describe("0168 is additive", () => {
  it("creates exactly one table and no index of its own", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(0);
  });

  it("alters only the new table — never `workers`, the hot table the design kept a column off", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([TABLE]));
    expect(FLAT).not.toContain('ALTER TABLE "workers"');
    expect(FLAT).not.toContain("search_hidden_at");
  });

  it("drops nothing, deletes nothing, writes no rows, and never touches the ledger", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP CONSTRAINT",
      "DROP INDEX",
      "TRUNCATE",
      "DELETE FROM",
      "INSERT INTO",
      'UPDATE "',
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    expect(FLAT).not.toContain("__drizzle_migrations");
  });
});

describe("deny by default", () => {
  it("enables AND forces RLS, and revokes every client role — no policy", () => {
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "${TABLE}" FROM ${role}`);
    }
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });

  it("is registered for its lock in the schema contract", () => {
    const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === "0168-worker-search-exits-rls");
    expect(entry).toMatchObject({ migration: TAG, kind: "rls", table: TABLE });
  });
});

describe("the columns", () => {
  it("`via` admits exactly its shared constant", () => {
    expect(checkValues("worker_search_exits_via_chk")).toEqual([...WORKER_SEARCH_EXIT_VIAS]);
  });

  it("one exit per worker: worker_id is the primary key, and every column is NOT NULL", () => {
    expect(FLAT).toContain('"worker_id" uuid PRIMARY KEY NOT NULL');
    expect(FLAT).toContain('"hidden_at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(FLAT).toContain('"via" text NOT NULL');
  });

  it("worker_id cascades on worker deletion (erasure)", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
  });

  it("stores ids, a time and a closed code only — three columns, no name, phone or text", () => {
    const columns = [...FLAT.matchAll(/"([a-z_]+)" (uuid|text|timestamp|jsonb|integer|boolean)/g)]
      .map((m) => m[1])
      .filter((c) => c !== TABLE);
    expect(columns.sort()).toEqual(["hidden_at", "via", "worker_id"]);
    expect(FLAT).not.toMatch(/jsonb/);
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the lock and the rollback", () => {
    expect(RAW).toContain("SEARCH_EXIT_ENABLED");
    expect(RAW).toContain("Apply 0164, 0165, 0166 and 0167 first");
    expect(RAW).toContain("SET LOCAL lock_timeout = '3s'");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
    expect(RAW).toContain("SAFE TO RE-RUN: no");
  });

  it("says what the switch does before 0168: the readers fail open, the worker routes 503", () => {
    expect(RAW).toContain("READERS FAIL OPEN");
    expect(RAW).toContain("answer\n-- 503");
    expect(RAW).not.toMatch(/answer 500/);
  });

  it("says consent is untouched (the design note: leaving search writes no consent row)", () => {
    expect(RAW).toContain("CONSENT IS UNTOUCHED");
    expect(FLAT).not.toContain("worker_consents");
  });
});

describe("the journal and the snapshot", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0168 at idx 168, after 0167, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(168);
    expect(previous.tag).toBe("0167_outbound_signals");
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("0168's snapshot builds on 0167's and records the table", () => {
    const next = snapshot("0168");
    expect(next.prevId).toBe(snapshot("0167").id);
    expect(next.tables).toHaveProperty(`public.${TABLE}`);
  });
});
