/**
 * Migration 0168 — `worker_activity`, the days a worker was active (#2753 items 4 and 7): one row
 * per worker per IST day, written by the worker-request interceptor and a Campus application, and
 * the one read of his last-active day.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table, no index of its own. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. ONCE A DAY — the primary key is (worker, day): the write's idempotency and the read's index.
 *   4. ERASURE — `worker_id` cascades, and the PK's `worker_id` prefix backs it.
 *   5. IDS AND DATES ONLY — no route, IP, device or time-of-day column.
 *   6. THE HEADER — deploy order (before the SWITCH), the slot order and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0168_worker_activity";
const TABLE = "worker_activity";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const snapshot = (
  n: string,
): {
  id: string;
  prevId: string;
  tables: Record<string, { columns: Record<string, { type: string; notNull: boolean }> }>;
} =>
  JSON.parse(
    readFileSync(join(__dirname, "..", "migrations", "meta", `${n}_snapshot.json`), "utf8"),
  );

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
  it("creates exactly one table and no index (the primary key is the only one it needs)", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(0);
  });

  it("alters only the new table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([TABLE]));
  });

  it("drops nothing, deletes nothing, writes no rows (no backfill), and never touches the ledger", () => {
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
});

describe("once a day, and erasure", () => {
  it("one row per worker per day: the primary key is (worker_id, active_on)", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "worker_activity_pkey" PRIMARY KEY("worker_id","active_on")`,
    );
  });

  it("the day is a DATE, never a timestamp, and both key columns are NOT NULL", () => {
    expect(FLAT).toContain(`"worker_id" uuid NOT NULL`);
    expect(FLAT).toContain(`"active_on" date NOT NULL`);
  });

  it("worker_id cascades on worker deletion (the PK's worker_id prefix backs it)", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
  });

  it("stores ids and dates only: exactly three columns, no route, ip, device or session", () => {
    const columns = Object.keys(snapshot("0168").tables[`public.${TABLE}`]?.columns ?? {});
    expect(columns.sort()).toEqual(["active_on", "created_at", "worker_id"]);
    for (const column of ["route", "ip", "device", "session", "user_agent", "path"]) {
      expect(FLAT).not.toMatch(new RegExp(`"[a-z_]*${column}[a-z_]*" `));
    }
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the lock and the rollback", () => {
    expect(RAW).toContain("WORKER_ACTIVITY_ENABLED");
    // Switched on early, the reads fall back to the device day (the API catches 42P01).
    expect(RAW).toContain("NOTHING ANSWERS 500");
    expect(RAW).toContain("fall back to the");
    expect(RAW).toContain("Apply 0164, 0165, 0166 and 0167 first");
    expect(RAW).toContain("lock_timeout = '3s'");
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
    expect(RAW).toContain("SAFE TO RE-RUN: no");
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
