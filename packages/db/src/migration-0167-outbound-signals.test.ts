/**
 * Migration 0167 — `outbound_signals`, the marks BadaBhai owes another system (#2747 item 8,
 * ADR-0064 §3.6): the RVM selection signal, queued in the stage transaction and sent once.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table and its two indexes. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARIES — each CHECK is exactly its shared constant, so the table cannot hold a
 *      destination, kind, status or failure code the sender does not know.
 *   4. ONCE — the unique `dedupe_key`; the delivered-iff-dated rule.
 *   5. ERASURE — `worker_id` cascades, and the cascade is indexed.
 *   6. THE HEADER — deploy order (before the SWITCH) and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OUTBOUND_SIGNAL_DESTINATIONS,
  OUTBOUND_SIGNAL_FAILURES,
  OUTBOUND_SIGNAL_KINDS,
  OUTBOUND_SIGNAL_STATUSES,
} from "./schema/outbound-signal";

const TAG = "0167_outbound_signals";
const TABLE = "outbound_signals";
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
  const end = FLAT.indexOf("),", start);
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

describe("0167 is additive", () => {
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
    ["outbound_signals_destination_chk", OUTBOUND_SIGNAL_DESTINATIONS],
    ["outbound_signals_status_chk", OUTBOUND_SIGNAL_STATUSES],
  ] as const)("%s admits exactly its shared constant", (constraint, values) => {
    expect(checkValues(constraint)).toEqual([...values]);
  });

  // FROZEN records: 0191 (#2771) widens these two, and its test pins the live constants.
  it("the kind and failure CHECKs close exactly what 0167 was written with", () => {
    expect(checkValues("outbound_signals_kind_chk")).toEqual([
      "applicant_selected",
      "applicant_hired",
    ]);
    expect(checkValues("outbound_signals_failure_chk")).toEqual([
      "not_configured",
      "timeout",
      "network",
      "http_status",
      "contract",
      "not_available",
      "rejected",
      "link_inactive",
      "context_missing",
      "mark_undone",
      "worker_inactive",
      "abandoned",
    ]);
    // …each a prefix of today's constant: a later migration only ever adds.
    expect(OUTBOUND_SIGNAL_KINDS.slice(0, 2)).toEqual(checkValues("outbound_signals_kind_chk"));
    expect(OUTBOUND_SIGNAL_FAILURES.slice(0, 12)).toEqual(
      checkValues("outbound_signals_failure_chk"),
    );
  });

  it("the failure code is nullable (a row that has never failed)", () => {
    expect(FLAT).toContain(`"${TABLE}"."last_failure" IS NULL OR`);
    expect(FLAT).toContain('"last_failure" text,');
  });

  it("payload is a JSON object; attempts never negative; delivered exactly when dated", () => {
    expect(FLAT).toContain(`jsonb_typeof("${TABLE}"."payload") = 'object'`);
    expect(FLAT).toContain(`"${TABLE}"."attempts" >= 0`);
    expect(FLAT).toContain(
      `(("${TABLE}"."status" = 'delivered') = ("${TABLE}"."delivered_at" IS NOT NULL))`,
    );
  });
});

describe("once, and erasure", () => {
  it("one signal per mark: dedupe_key is UNIQUE", () => {
    expect(FLAT).toContain(`CONSTRAINT "outbound_signals_dedupe_key_uq" UNIQUE("dedupe_key")`);
  });

  it("worker_id cascades on worker deletion, and the cascade is indexed", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "outbound_signals_worker_id_idx" ON "${TABLE}" USING btree ("worker_id")`,
    );
  });

  it("the sweep's read is a partial index over pending rows by next_attempt_at", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "outbound_signals_due_idx" ON "${TABLE}" USING btree ("next_attempt_at") WHERE "${TABLE}"."status" = 'pending'`,
    );
  });

  it("stores no name, phone, title or reference column", () => {
    for (const column of ["name", "phone", "title", "company", "student_ref", "body"]) {
      expect(FLAT).not.toMatch(new RegExp(`"[a-z_]*${column}[a-z_]*" (text|jsonb)`));
    }
  });
});

describe("the header", () => {
  it("states the switch, the slot order and the rollback", () => {
    expect(RAW).toContain("OUTBOUND_SIGNALS_ROLLOUT");
    expect(RAW).toContain("Apply 0164, 0165 and 0166 first");
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
  });
});

describe("the journal and the snapshot", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0167 at idx 167, after 0166, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(167);
    expect(previous.tag).toBe("0166_payer_applicant_outcome_stages");
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("0167's snapshot builds on 0166's and records the table", () => {
    const next = snapshot("0167");
    expect(next.prevId).toBe(snapshot("0166").id);
    expect(next.tables).toHaveProperty(`public.${TABLE}`);
  });
});
