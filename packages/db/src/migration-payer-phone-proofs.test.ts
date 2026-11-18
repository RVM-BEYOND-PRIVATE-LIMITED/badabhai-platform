/**
 * Migration `payer_phone_proofs` — a company proved the phone on its account (#2754 item 3).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table and its one index. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARY — the method CHECK is exactly the shared constant.
 *   4. ONE ACCOUNT PER PROVEN PHONE — the unique index on `phone_hash`, and one proof per account
 *      (`payer_id` is the PRIMARY KEY).
 *   5. ERASURE — `payer_id` cascades on the account's hard delete.
 *   6. THE HEADER — deploy order (before the SWITCH), the lock and the rollback.
 *
 * NUMBER-AGNOSTIC ON PURPOSE. The slot is still moving (it is regenerated above #2749's 0175
 * before merge), so the file is found by its tag SUFFIX in the journal rather than by a number,
 * and this test keeps passing across that regenerate. The hand-written header and tail carry no
 * number for the same reason.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { PAYER_PHONE_PROOF_METHODS } from "./schema/payer-phone-proof";

const SUFFIX = "_payer_phone_proofs";
const TABLE = "payer_phone_proofs";

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const AT = JOURNAL.entries.findIndex((e) => e.tag.endsWith(SUFFIX));
const ENTRY = JOURNAL.entries[AT];
const TAG = ENTRY?.tag ?? "";
const NUMBER = TAG.slice(0, 4);
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

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
  it("finds exactly one journal entry with the tag suffix, and reads its SQL", () => {
    expect(JOURNAL.entries.filter((e) => e.tag.endsWith(SUFFIX))).toHaveLength(1);
    expect(NUMBER).toMatch(/^\d{4}$/);
    expect(FLAT).toContain(`CREATE TABLE "${TABLE}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE SWITCH");
    expect(DDL).not.toContain("APPLY BEFORE THE SWITCH");
  });
});

describe("the migration is additive", () => {
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

  it("puts no unique index on payers.phone_hash (that stays an owner step after the hand resolution)", () => {
    expect(FLAT).not.toMatch(/ON "payers"/);
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

  it("is registered for its lock in schema-contract.ts, under this file's tag", () => {
    const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === `${NUMBER}-payer-phone-proofs-rls`);
    expect(entry).toMatchObject({ migration: TAG, kind: "rls", table: TABLE });
  });
});

describe("the columns", () => {
  it("the method admits exactly its shared constant", () => {
    expect(checkValues("payer_phone_proofs_method_chk")).toEqual([...PAYER_PHONE_PROOF_METHODS]);
    expect([...PAYER_PHONE_PROOF_METHODS]).toEqual(["sms_code", "campus_import"]);
  });

  it("one proof per account: payer_id is the PRIMARY KEY; every column is required", () => {
    expect(FLAT).toContain('"payer_id" uuid PRIMARY KEY NOT NULL,');
    expect(FLAT).toContain('"phone_hash" text NOT NULL,');
    expect(FLAT).toContain('"method" text NOT NULL,');
    expect(FLAT).toContain('"proven_at" timestamp with time zone DEFAULT now() NOT NULL');
  });

  it("stores no phone number, name, code or free text column", () => {
    expect(FLAT).not.toMatch(/"phone(_e164|_enc)?" /);
    for (const column of ["name", "code", "note", "reason", "payload", "email"]) {
      expect(FLAT).not.toMatch(new RegExp(`"[a-z_]*${column}[a-z_]*" (text|jsonb)`));
    }
  });
});

describe("one account per proven phone, and erasure", () => {
  it("only ONE account can ever hold the proof of a phone", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "payer_phone_proofs_phone_hash_uq" ON "${TABLE}" USING btree ("phone_hash")`,
    );
  });

  it("payer_id cascades on the account's hard delete", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("payer_id"\) REFERENCES "public"\."payers"\("id"\) ON DELETE cascade/,
    );
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the 42P01 fail-closed reads, the lock and the rollback", () => {
    expect(RAW).toContain("PAYER_SMS_OTP_ENABLED");
    expect(RAW).toContain("Apply every lower-numbered migration first");
    expect(RAW).toContain("42P01");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
  });

  it("names no migration number of its own, so a regenerate keeps it word for word", () => {
    const start = RAW.indexOf(`CREATE TABLE "${TABLE}"`);
    expect(start).toBeGreaterThan(0);
    expect(RAW.slice(0, start)).not.toContain(NUMBER);
    // …and neither does the hand-written tail.
    expect(RAW.slice(RAW.indexOf("DENY BY DEFAULT"))).not.toContain(NUMBER);
  });
});

describe("the journal and the snapshot", () => {
  it("records the entry after its predecessor, at its own idx, with a `when` above it", () => {
    expect(AT).toBeGreaterThan(0);
    const previous = JOURNAL.entries[AT - 1]!;
    expect(ENTRY!.idx).toBe(Number(NUMBER));
    expect(ENTRY!.idx).toBe(previous.idx + 1);
    expect(ENTRY!.when).toBeGreaterThan(previous.when);
  });

  it("its snapshot builds on its predecessor's and records the table", () => {
    const next = snapshot(NUMBER);
    const previous = JOURNAL.entries[AT - 1]!.tag.slice(0, 4);
    expect(next.prevId).toBe(snapshot(previous).id);
    expect(next.tables).toHaveProperty(`public.${TABLE}`);
  });
});
