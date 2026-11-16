/**
 * Migration 0169 — `unlock_outcomes`, what became of one opened contact (#2753 item 10).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table and its two indexes. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARIES — each CHECK is exactly its shared constant, so the table cannot hold an
 *      outcome or an answerer the API does not know.
 *   4. ONE ROW PER UNLOCK — `unlock_id` is the primary key and cascades with the unlock.
 *   5. ERASURE — `worker_id` cascades and the cascade is indexed.
 *   6. THE HEADER — deploy order (before the SWITCH), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { UNLOCK_OUTCOME_ANSWERERS, UNLOCK_OUTCOMES } from "@badabhai/types";

const TAG = "0169_unlock_outcomes";
const TABLE = "unlock_outcomes";
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

describe("0169 is additive", () => {
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
});

describe("the vocabularies", () => {
  it.each([
    ["unlock_outcomes_outcome_chk", UNLOCK_OUTCOMES],
    ["unlock_outcomes_answered_by_chk", UNLOCK_OUTCOME_ANSWERERS],
  ] as const)("%s admits exactly its shared constant", (constraint, values) => {
    expect(checkValues(constraint)).toEqual([...values]);
  });

  it("every column is required; updated_at defaults to now()", () => {
    for (const column of ["tenant_payer_id", "worker_id"]) {
      expect(FLAT).toContain(`"${column}" uuid NOT NULL,`);
    }
    for (const column of ["outcome", "answered_by"]) {
      expect(FLAT).toContain(`"${column}" text NOT NULL,`);
    }
    expect(FLAT).toContain('"answered_at" timestamp with time zone NOT NULL,');
    expect(FLAT).toContain('"updated_at" timestamp with time zone DEFAULT now() NOT NULL,');
  });
});

describe("one row per unlock, the weekly read, and erasure", () => {
  it("unlock_id is the primary key and cascades with the unlock", () => {
    expect(FLAT).toContain('"unlock_id" uuid PRIMARY KEY NOT NULL,');
    expect(FLAT).toMatch(
      /FOREIGN KEY \("unlock_id"\) REFERENCES "public"\."unlocks"\("id"\) ON DELETE cascade/,
    );
  });

  it("the per-company read by answer time is indexed (tenant_payer_id, answered_at)", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "unlock_outcomes_tenant_answered_idx" ON "${TABLE}" USING btree ("tenant_payer_id","answered_at")`,
    );
  });

  it("worker_id cascades on worker deletion, and the cascade is indexed", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "unlock_outcomes_worker_id_idx" ON "${TABLE}" USING btree ("worker_id")`,
    );
  });

  it("the tenant key has no foreign key (as on unlocks.payer_id)", () => {
    expect(FLAT).not.toMatch(/FOREIGN KEY \("tenant_payer_id"\)/);
  });

  it("stores no name, phone, title, note or free text column", () => {
    for (const column of ["name", "phone", "title", "note", "company", "reason", "comment"]) {
      expect(FLAT).not.toMatch(new RegExp(`"[a-z_]*${column}[a-z_]*" (text|jsonb)`));
    }
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the locks and the rollback", () => {
    expect(RAW).toContain("UNLOCK_FOLLOWUP_ENABLED");
    expect(RAW).toContain("Apply 0164 to 0168 first");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
  });
});

describe("the journal and the snapshot", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0169 at idx 169, after 0168, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(169);
    expect(previous.tag).toBe("0168_hires");
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("0169's snapshot builds on 0168's and records the table", () => {
    const next = snapshot("0169");
    expect(next.prevId).toBe(snapshot("0168").id);
    expect(next.tables).toHaveProperty(`public.${TABLE}`);
  });
});
