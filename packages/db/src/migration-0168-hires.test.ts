/**
 * Migration 0168 — `hires`, one hire record per company, worker and posting (#2753 item 9).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table and its one index. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARIES — each CHECK is exactly its shared constant, so the table cannot hold a
 *      status or posting kind the API does not know.
 *   4. ONE ROW — the unique (tenant, worker, posting kind, posting id) every source upserts on.
 *   5. ERASURE — `worker_id` cascades and the cascade is indexed; the tenant FK cascades too.
 *   6. THE HEADER — deploy order (before the SWITCH), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { APPLICANT_POSTING_KINDS, HIRE_STATUSES } from "@badabhai/types";

const TAG = "0168_hires";
const TABLE = "hires";
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
  const end = FLAT.indexOf(")", start + head.length);
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
  it("creates exactly one table and one index", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(1);
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
});

describe("the vocabularies", () => {
  it.each([
    ["hires_status_chk", HIRE_STATUSES],
    ["hires_posting_kind_chk", APPLICANT_POSTING_KINDS],
  ] as const)("%s admits exactly its shared constant", (constraint, values) => {
    expect(checkValues(constraint)).toEqual([...values]);
  });

  it("status is required; every source timestamp and hired_on are nullable", () => {
    expect(FLAT).toContain('"status" text NOT NULL,');
    for (const column of [
      "company_marked_at",
      "company_answered_at",
      "worker_answered_at",
      "desk_confirmed_at",
    ]) {
      expect(FLAT).toContain(`"${column}" timestamp with time zone,`);
    }
    expect(FLAT).toContain('"hired_on" date,');
  });
});

describe("one row per company, worker and posting, and erasure", () => {
  it("the unique key every source upserts on", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "hires_tenant_worker_posting_uq" UNIQUE("tenant_payer_id","worker_id","posting_kind","posting_id")`,
    );
  });

  it("worker_id cascades on worker deletion, and the cascade is indexed", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "hires_worker_id_idx" ON "${TABLE}" USING btree ("worker_id")`,
    );
  });

  it("the tenant key references payers and cascades with it (the tenant-keyed table rule)", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("tenant_payer_id"\) REFERENCES "public"\."payers"\("id"\) ON DELETE cascade/,
    );
  });

  it("posting_id has no foreign key (one column names a jobs or a job_postings row)", () => {
    expect(FLAT).not.toMatch(/FOREIGN KEY \("posting_id"\)/);
  });

  it("stores no name, phone, title, note or reference column", () => {
    for (const column of ["name", "phone", "title", "note", "company", "student_ref", "reason"]) {
      expect(FLAT).not.toMatch(new RegExp(`"[a-z_]*${column}[a-z_]*" (text|jsonb)`));
    }
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the locks and the rollback", () => {
    expect(RAW).toContain("HIRE_RECORDS_ENABLED");
    expect(RAW).toContain("Apply 0164 to 0167 first");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
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
