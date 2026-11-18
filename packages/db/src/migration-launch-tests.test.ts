/**
 * Migration `launch_tests` — launch test A's records (#2755 item 9): `launch_test_cohort` (one row
 * per factory) and `launch_test_shares` (one row per worker sent to it).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — two new tables and their four indexes. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs per table are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARY — the result CHECK is exactly the shared constant; `paid_at` iff `paid`; the
 *      link ref's length; the link time needs the ref; the phone's ciphertext and hash together.
 *   4. ONE ROW PER FACTORY PHONE AND PER PAID ORDER — the two unique indexes.
 *   5. ERASURE — the worker FK cascades (indexed); the payer and order FKs SET NULL (indexed); a
 *      share cascades with its factory.
 *   6. NO PLAINTEXT — only the `_enc` and `_hash` forms of the factory's name and phone.
 *   7. THE HEADER — deploy order (before the SWITCH), the lock and the rollback, and no number.
 *
 * NUMBER-AGNOSTIC ON PURPOSE. The slot can still move before merge (part B of #2755 and #2749 are
 * in flight), so the file is found by its tag SUFFIX in the journal rather than by a number, and
 * this test keeps passing across a regenerate. The hand-written header and tail carry no number for
 * the same reason.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LAUNCH_TEST_RESULTS } from "@badabhai/types";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { LAUNCH_TEST_PAYMENT_LINK_REF_MAX, LAUNCH_TEST_SHARES_MAX } from "./schema/launch-test";

const SUFFIX = "_launch_tests";
const COHORT = "launch_test_cohort";
const SHARES = "launch_test_shares";

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

/** The body of one CHECK, up to the constraint's closing `),` or `)\n);`. */
function checkBody(constraint: string): string {
  const head = `CONSTRAINT "${constraint}" CHECK (`;
  const start = FLAT.indexOf(head);
  if (start < 0) throw new Error(`${constraint} not found`);
  const rest = FLAT.slice(start + head.length);
  const end = rest.search(/\), CONSTRAINT|\) \);/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one journal entry with the tag suffix, and reads its SQL", () => {
    expect(JOURNAL.entries.filter((e) => e.tag.endsWith(SUFFIX))).toHaveLength(1);
    expect(NUMBER).toMatch(/^\d{4}$/);
    expect(FLAT).toContain(`CREATE TABLE "${COHORT}"`);
    expect(FLAT).toContain(`CREATE TABLE "${SHARES}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE SWITCH");
    expect(DDL).not.toContain("APPLY BEFORE THE SWITCH");
  });
});

describe("the migration is additive", () => {
  it("creates exactly two tables and four indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(2);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(4);
  });

  it("alters only the two new tables", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([COHORT, SHARES]));
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
  it.each([COHORT, SHARES])(
    "%s: enables AND forces RLS, and revokes every client role — no policy",
    (table) => {
      expect(FLAT).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(FLAT).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
        expect(FLAT).toContain(`REVOKE ALL ON TABLE "${table}" FROM ${role}`);
      }
    },
  );

  it("grants nothing and creates no policy", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });

  it("both tables are registered for their lock in schema-contract.ts, under this file's tag", () => {
    for (const table of [COHORT, SHARES]) {
      const id = `${NUMBER}-${table.replace(/_/g, "-")}-rls`;
      const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === id);
      expect(entry, id).toMatchObject({ migration: TAG, kind: "rls", table });
    }
  });
});

describe("the factory row's CHECKs", () => {
  it("the result admits exactly the shared constant, and defaults to pending", () => {
    const values = [...checkBody("launch_test_cohort_result_chk").matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(values).toEqual([...LAUNCH_TEST_RESULTS]);
    expect([...LAUNCH_TEST_RESULTS]).toEqual(["pending", "paid", "declined", "no_response"]);
    expect(FLAT).toContain(`"result" text DEFAULT 'pending' NOT NULL,`);
  });

  it("paid_at is set exactly when the result is paid", () => {
    expect(checkBody("launch_test_cohort_paid_chk")).toBe(
      `("${COHORT}"."paid_at" IS NOT NULL) = ("${COHORT}"."result" = 'paid')`,
    );
  });

  it("the link ref is 1 to LAUNCH_TEST_PAYMENT_LINK_REF_MAX characters; its time needs it", () => {
    expect(LAUNCH_TEST_PAYMENT_LINK_REF_MAX).toBe(300);
    expect(checkBody("launch_test_cohort_link_ref_chk")).toBe(
      `"${COHORT}"."payment_link_ref" IS NULL OR char_length("${COHORT}"."payment_link_ref") BETWEEN 1 AND ${LAUNCH_TEST_PAYMENT_LINK_REF_MAX}`,
    );
    expect(checkBody("launch_test_cohort_link_chk")).toBe(
      `"${COHORT}"."link_created_at" IS NULL OR "${COHORT}"."payment_link_ref" IS NOT NULL`,
    );
  });

  it("the phone's ciphertext and its hash are stored together, or neither", () => {
    expect(checkBody("launch_test_cohort_phone_chk")).toBe(
      `("${COHORT}"."factory_phone_enc" IS NULL) = ("${COHORT}"."factory_phone_hash" IS NULL)`,
    );
  });

  it("stores the name and phone ONLY as ciphertext and a keyed hash — never plaintext", () => {
    expect(FLAT).toContain('"factory_name_enc" text NOT NULL,');
    expect(FLAT).toContain('"factory_phone_enc" text,');
    expect(FLAT).toContain('"factory_phone_hash" text,');
    expect(FLAT).not.toMatch(/"(factory_)?(name|phone|phone_e164|org_name)" /);
    for (const column of ["note", "email", "payload", "address"]) {
      expect(FLAT).not.toMatch(new RegExp(`"[a-z_]*${column}[a-z_]*" (text|jsonb)`));
    }
  });

  it("the groups, the sender and the times are required", () => {
    for (const column of [
      '"city_group" text NOT NULL',
      '"trade_group" text NOT NULL',
      '"sent_by_admin_id" uuid NOT NULL',
      '"sent_at" timestamp with time zone NOT NULL',
      '"updated_by_admin_id" uuid NOT NULL',
    ]) {
      expect(FLAT).toContain(column);
    }
  });
});

describe("one row per factory phone and per paid order", () => {
  it("unique on the phone hash and on the payment order", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "launch_test_cohort_phone_hash_uq" ON "${COHORT}" USING btree ("factory_phone_hash")`,
    );
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "launch_test_cohort_payment_order_uq" ON "${COHORT}" USING btree ("payment_order_id")`,
    );
  });

  it("a share is one per factory and worker (the PRIMARY KEY); the five-per-factory cap is the service's", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "launch_test_shares_pk" PRIMARY KEY("cohort_id","worker_id")`,
    );
    expect(LAUNCH_TEST_SHARES_MAX).toBe(5);
  });
});

describe("the foreign keys", () => {
  it("the payer and the paid order SET NULL, each backed by an index", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("payer_id"\) REFERENCES "public"\."payers"\("id"\) ON DELETE set null/,
    );
    expect(FLAT).toMatch(
      /FOREIGN KEY \("payment_order_id"\) REFERENCES "public"\."payment_orders"\("id"\) ON DELETE set null/,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "launch_test_cohort_payer_id_idx" ON "${COHORT}" USING btree ("payer_id")`,
    );
  });

  it("a share cascades with its factory and with its worker (DPDP erasure), the worker indexed", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("cohort_id"\) REFERENCES "public"\."launch_test_cohort"\("id"\) ON DELETE cascade/,
    );
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "launch_test_shares_worker_id_idx" ON "${SHARES}" USING btree ("worker_id")`,
    );
  });

  it("the admin ids carry no FK (the record survives a change to the admin's account)", () => {
    expect(FLAT).not.toMatch(/REFERENCES "public"\."admin_users"/);
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the 42P01 fail-closed answer, the lock and the rollback", () => {
    expect(RAW).toContain("ADMIN_NUMBERS_ENABLED");
    expect(RAW).toContain("Apply every lower-numbered migration first");
    expect(RAW).toContain("42P01");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain(`DROP TABLE "${SHARES}";`);
    expect(RAW).toContain(`DROP TABLE "${COHORT}";`);
  });

  it("names no migration number of its own, so a regenerate keeps it word for word", () => {
    const start = RAW.indexOf(`CREATE TABLE "${COHORT}"`);
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

  it("its snapshot builds on its predecessor's and records both tables", () => {
    const next = snapshot(NUMBER);
    const previous = JOURNAL.entries[AT - 1]!.tag.slice(0, 4);
    expect(next.prevId).toBe(snapshot(previous).id);
    expect(next.tables).toHaveProperty(`public.${COHORT}`);
    expect(next.tables).toHaveProperty(`public.${SHARES}`);
  });
});
