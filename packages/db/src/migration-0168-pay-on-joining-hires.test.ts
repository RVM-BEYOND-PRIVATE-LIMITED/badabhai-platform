/**
 * Migration 0168 — `pay_on_joining_hires`, the pay-on-joining pilot's record (#2753 item 11).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table and its two indexes. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE MONEY — integer paise (bigint), the fee and share never negative, the percent 0..100,
 *      and the share pinned to the server's floor arithmetic.
 *   4. ONE ROW PER HIRE — UNIQUE NULLS NOT DISTINCT (factory, worker, job posting).
 *   5. THE KEYS — factory CASCADE, partner and posting SET NULL, worker CASCADE (indexed).
 *   6. IDS ONLY — no name, phone or company column; `note` is the one free-text column, capped.
 *   7. THE HEADER — deploy order (before the SWITCH) and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { POJ_NOTE_MAX_CHARS } from "./schema/pay-on-joining";

const TAG = "0168_pay_on_joining_hires";
const TABLE = "pay_on_joining_hires";
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

/** The body of one CHECK, as generated: everything inside its balanced outer parentheses. */
function checkBody(constraint: string): string {
  const head = `CONSTRAINT "${constraint}" CHECK (`;
  const start = FLAT.indexOf(head);
  if (start < 0) throw new Error(`${constraint} not found`);
  const from = start + head.length;
  let depth = 1;
  for (let i = from; i < FLAT.length; i += 1) {
    if (FLAT[i] === "(") depth += 1;
    if (FLAT[i] === ")") depth -= 1;
    if (depth === 0) return FLAT.slice(from, i).trim();
  }
  throw new Error(`${constraint} is not closed`);
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

describe("the money", () => {
  it("stores the fee and the share as integer paise (bigint), and the percent as an integer", () => {
    expect(FLAT).toContain('"fee_paise" bigint NOT NULL');
    expect(FLAT).toContain('"partner_share_paise" bigint NOT NULL');
    expect(FLAT).toContain('"partner_share_percent" integer NOT NULL');
    expect(FLAT).not.toMatch(/\b(numeric|real|double precision)\b/i);
  });

  it("refuses a negative fee or share and a percent outside 0..100", () => {
    expect(checkBody("pay_on_joining_hires_fee_chk")).toBe(`"${TABLE}"."fee_paise" >= 0`);
    expect(checkBody("pay_on_joining_hires_share_chk")).toBe(
      `"${TABLE}"."partner_share_paise" >= 0`,
    );
    expect(checkBody("pay_on_joining_hires_percent_chk")).toBe(
      `"${TABLE}"."partner_share_percent" >= 0 AND "${TABLE}"."partner_share_percent" <= 100`,
    );
  });

  it("pins the share to the server's floor: (fee * percent) / 100 in integer arithmetic", () => {
    expect(checkBody("pay_on_joining_hires_share_math_chk")).toBe(
      `"${TABLE}"."partner_share_paise" = ("${TABLE}"."fee_paise" * "${TABLE}"."partner_share_percent") / 100`,
    );
  });

  it("the 30-day check has a date and an outcome, or neither", () => {
    expect(checkBody("pay_on_joining_hires_stay_check_chk")).toBe(
      `("${TABLE}"."stay_checked_on" IS NULL) = ("${TABLE}"."stayed_30_days" IS NULL)`,
    );
  });
});

describe("one row per hire, and the keys", () => {
  it("is UNIQUE NULLS NOT DISTINCT over (factory, worker, job posting)", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "pay_on_joining_hires_hire_uq" UNIQUE NULLS NOT DISTINCT("factory_payer_id","worker_id","job_posting_id")`,
    );
  });

  it.each([
    ["factory_payer_id", "payers", "cascade"],
    ["partner_payer_id", "payers", "set null"],
    ["job_posting_id", "job_postings", "set null"],
    ["worker_id", "workers", "cascade"],
  ])("%s references %s ON DELETE %s", (column, table, action) => {
    expect(FLAT).toContain(
      `FOREIGN KEY ("${column}") REFERENCES "public"."${table}"("id") ON DELETE ${action}`,
    );
  });

  it("the worker cascade and the partner filter are indexed", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "pay_on_joining_hires_worker_id_idx" ON "${TABLE}" USING btree ("worker_id")`,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "pay_on_joining_hires_partner_payer_id_idx" ON "${TABLE}" USING btree ("partner_payer_id")`,
    );
  });

  it("the share and the factory are NOT NULL; the partner, the posting and every later date are nullable", () => {
    for (const column of ["factory_payer_id", "worker_id", "joined_on"]) {
      expect(FLAT).toMatch(new RegExp(`"${column}" (uuid|date) NOT NULL`));
    }
    for (const column of [
      "job_posting_id",
      "partner_payer_id",
      "stay_checked_on",
      "invoiced_on",
      "factory_paid_on",
      "partner_paid_on",
    ]) {
      expect(FLAT).toMatch(new RegExp(`"${column}" (uuid|date),`));
    }
  });
});

describe("ids only, and the one note", () => {
  it("stores no name, phone, email, company or invoice-number column", () => {
    for (const column of ["name", "phone", "email", "company", "gst", "invoice_no", "reference"]) {
      expect(FLAT).not.toMatch(new RegExp(`"[a-z_]*${column}[a-z_]*" (text|jsonb|varchar)`));
    }
  });

  it("`note` is the only text column, capped at the shared limit", () => {
    expect([...FLAT.matchAll(/"([a-z_0-9]+)" text/g)].map((m) => m[1])).toEqual(["note"]);
    expect(POJ_NOTE_MAX_CHARS).toBe(500);
    expect(checkBody("pay_on_joining_hires_note_chk")).toBe(
      `"${TABLE}"."note" IS NULL OR char_length("${TABLE}"."note") BETWEEN 1 AND ${POJ_NOTE_MAX_CHARS}`,
    );
  });

  it("the acting admins are opaque ids with no foreign key", () => {
    expect(FLAT).toContain('"created_by_admin_id" uuid NOT NULL');
    expect(FLAT).toContain('"updated_by_admin_id" uuid NOT NULL');
    expect(FLAT).not.toContain('REFERENCES "public"."admin_users"');
  });
});

describe("the header", () => {
  it("states the switch, the setting, the floor and the rollback", () => {
    expect(RAW).toContain("PAY_ON_JOINING_RECORDS_ENABLED");
    expect(RAW).toContain("POJ_PARTNER_SHARE_PERCENT");
    expect(RAW).toContain("floor(fee_paise * partner_share_percent / 100)");
    expect(RAW).toContain("THIS IS A RECORD ONLY");
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
  });
});

describe("the journal and the snapshot", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0168 after 0167, with a `when` above its predecessor's", () => {
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
