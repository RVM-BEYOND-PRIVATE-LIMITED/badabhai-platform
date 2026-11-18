/**
 * Migration 0173 — `still_looking_checks`, the monthly "still looking?" check (#2753 item 5).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table and its two indexes. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARY — the answer CHECK is exactly the shared constant, and an answer and its time
 *      are set together.
 *   4. ONE OPEN CHECK PER WORKER — the partial unique index the sweep's insert is guarded by.
 *   5. ERASURE — `worker_id` cascades and the cascade is indexed.
 *   6. THE HEADER — deploy order (before the SWITCH), the lock and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { STILL_LOOKING_ANSWERS } from "./schema/still-looking";

const TAG = "0173_still_looking_checks";
const TABLE = "still_looking_checks";
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
  const end = FLAT.indexOf("),", start + head.length);
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

describe("0173 is additive", () => {
  it("creates exactly one table and two indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(2);
  });

  it("alters only the new table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([TABLE]));
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

  it("is registered for its lock in schema-contract.ts", () => {
    const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === "0173-still-looking-checks-rls");
    expect(entry).toMatchObject({ migration: TAG, kind: "rls", table: TABLE });
  });
});

describe("the columns", () => {
  it("the answer admits exactly its shared constant (or nothing, while the check is open)", () => {
    expect(checkValues("still_looking_checks_answer_chk")).toEqual([...STILL_LOOKING_ANSWERS]);
    expect([...STILL_LOOKING_ANSWERS]).toEqual(["yes", "not_now", "hired"]);
    expect(FLAT).toContain(
      `CONSTRAINT "still_looking_checks_answer_chk" CHECK ("${TABLE}"."answer" IS NULL OR "${TABLE}"."answer" IN (`,
    );
  });

  it("an answer and its time are set together, or neither is", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "still_looking_checks_answered_chk" CHECK (("${TABLE}"."answer" IS NULL) = ("${TABLE}"."answered_at" IS NULL))`,
    );
  });

  it("the worker and the prompt time are required; the answer and its time are not", () => {
    expect(FLAT).toContain('"worker_id" uuid NOT NULL,');
    expect(FLAT).toContain('"prompted_at" timestamp with time zone NOT NULL,');
    expect(FLAT).toContain('"answered_at" timestamp with time zone,');
    expect(FLAT).toContain('"answer" text,');
    expect(FLAT).toContain('"created_at" timestamp with time zone DEFAULT now() NOT NULL');
  });

  it("stores no name, phone, device, note or free text column", () => {
    for (const column of ["name", "phone", "device", "note", "reason", "comment", "payload"]) {
      expect(FLAT).not.toMatch(new RegExp(`"[a-z_]*${column}[a-z_]*" (text|jsonb)`));
    }
  });
});

describe("one open check per worker, the per-worker read, and erasure", () => {
  it("at most ONE open (unanswered) check per worker: the sweep's insert target", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "still_looking_checks_open_uq" ON "${TABLE}" USING btree ("worker_id") WHERE "${TABLE}"."answered_at" IS NULL`,
    );
  });

  it("the per-worker read by prompt time is indexed (worker_id, prompted_at)", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "still_looking_checks_worker_prompted_idx" ON "${TABLE}" USING btree ("worker_id","prompted_at")`,
    );
  });

  it("worker_id cascades on worker deletion (the index above backs it)", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the lock and the rollback", () => {
    expect(RAW).toContain("STILL_LOOKING_CHECK_ENABLED");
    expect(RAW).toContain("Apply 0164 to 0172");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
  });
});

describe("the journal and the snapshot", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0173 at idx 173, after 0172, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(173);
    expect(previous.tag).toBe("0172_unlock_outcomes");
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("0173's snapshot builds on 0172's and records the table", () => {
    const next = snapshot("0173");
    expect(next.prevId).toBe(snapshot("0172").id);
    expect(next.tables).toHaveProperty(`public.${TABLE}`);
  });
});
