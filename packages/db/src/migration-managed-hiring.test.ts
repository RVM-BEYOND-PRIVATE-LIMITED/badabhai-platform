/**
 * Migration `<slot>_managed_hiring` — Managed Hiring orders, the tracker and callback requests
 * (#2751 items 4 to 13), and the widened `payment_orders_product_kind_chk`. The file is found by its
 * NAME, not its number: the slot is taken at merge time and may be regenerated under another number,
 * and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — three new tables, their indexes and foreign keys, and ONE existing constraint
 *      swapped for a wider one. Nothing else dropped, no column added to an existing table, no row.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs per table are hand-appended; a regenerate drops them.
 *   3. THE RULES AS CONSTRAINTS — one open order per job, one tracker row per order and worker, one
 *      callback request per job, the closed codes spelled from `@badabhai/types`, the cascades.
 *   4. THE HEADER — deploy order (before the switch, not before the deploy), the locks, the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MANAGED_HIRING_CALLBACK_REASONS,
  MANAGED_HIRING_OPEN_STATUSES,
  MANAGED_HIRING_ORDER_STATUSES,
  MANAGED_HIRING_TIERS,
  PAYMENT_ORDER_PRODUCT_KINDS,
  VACANCY_BANDS,
} from "@badabhai/types";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_managed_hiring\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const ORDERS = "managed_hiring_orders";
const INTEREST = "managed_hiring_interest";
const CALLBACKS = "managed_hiring_callback_requests";
const TABLES = [ORDERS, INTEREST, CALLBACKS] as const;
const RAW = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

const snapshot = (n: string): { id: string; prevId: string; tables: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", `${n}_snapshot.json`), "utf8"));

const inList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one managed_hiring migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates the three tables", () => {
    for (const t of TABLES) expect(FLAT).toContain(`CREATE TABLE "${t}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE MANAGED_HIRING_ROLLOUT IS SET");
    expect(DDL).not.toContain("APPLY BEFORE MANAGED_HIRING_ROLLOUT IS SET");
  });
});

describe("the migration is additive", () => {
  it("creates exactly three tables and ten indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(3);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(10);
  });

  it("alters only the new tables, plus payment_orders' product-kind CHECK", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([...TABLES, "payment_orders"]));
    const onPaymentOrders = [...FLAT.matchAll(/ALTER TABLE "payment_orders" ([A-Z ]+?) "/g)].map(
      (m) => m[1],
    );
    expect(onPaymentOrders).toEqual(["DROP CONSTRAINT", "ADD CONSTRAINT"]);
    expect(FLAT).not.toMatch(/ALTER TABLE "payment_orders" ADD COLUMN/);
  });

  it("drops only the constraint it replaces; deletes nothing, writes no rows, seeds nothing", () => {
    expect([...FLAT.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1])).toEqual([
      "payment_orders_product_kind_chk",
    ]);
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
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

  it("the widened CHECK is PAYMENT_ORDER_PRODUCT_KINDS, credit_pack still first", () => {
    expect(PAYMENT_ORDER_PRODUCT_KINDS).toEqual(["credit_pack", "managed_hiring"]);
    expect(FLAT).toContain(
      `ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_product_kind_chk" CHECK ("payment_orders"."product_kind" IN (${inList(PAYMENT_ORDER_PRODUCT_KINDS)}))`,
    );
  });

  it("references what it should, with the right deletion rule", () => {
    const refs = [
      ...FLAT.matchAll(
        /ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "[a-z_]+" FOREIGN KEY \("([a-z_]+)"\) REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+)/g,
      ),
    ].map((m) => `${m[1]}.${m[2]}->${m[3]}:${m[4]}`);
    expect(new Set(refs)).toEqual(
      new Set([
        `${CALLBACKS}.job_posting_id->job_postings:cascade`,
        `${INTEREST}.order_id->${ORDERS}:cascade`,
        `${INTEREST}.worker_id->workers:cascade`,
        `${ORDERS}.job_posting_id->job_postings:cascade`,
        `${ORDERS}.payment_order_id->payment_orders:restrict`,
      ]),
    );
  });
});

describe("deny by default", () => {
  it("enables AND forces RLS on each table, and revokes every client role — no policy", () => {
    for (const t of TABLES) {
      expect(FLAT).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(FLAT).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
        expect(FLAT).toContain(`REVOKE ALL ON TABLE "${t}" FROM ${role}`);
      }
    }
  });

  it("creates no policy and grants nothing", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });
});

describe("the rules as constraints, closed codes from @badabhai/types", () => {
  it("one OPEN order per job, and one order per payment order", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "managed_hiring_orders_open_job_uq" ON "${ORDERS}" USING btree ("job_posting_id") WHERE "${ORDERS}"."status" IN (${inList(["created", ...MANAGED_HIRING_OPEN_STATUSES])})`,
    );
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "managed_hiring_orders_payment_order_uq" ON "${ORDERS}" USING btree ("payment_order_id")`,
    );
  });

  it("the order's status and tier CHECKs spell the shared sets", () => {
    expect(FLAT).toContain(
      `CHECK ("${ORDERS}"."status" IN (${inList(MANAGED_HIRING_ORDER_STATUSES)}))`,
    );
    expect(FLAT).toContain(`CHECK ("${ORDERS}"."tier" IN (${inList(MANAGED_HIRING_TIERS)}))`);
  });

  it("an order past `created` carries its whole clock, deadline before the extension's end", () => {
    expect(FLAT).toContain(`CONSTRAINT "managed_hiring_orders_clock_chk"`);
    expect(FLAT).toContain(`"${ORDERS}"."extended_until" >= "${ORDERS}"."due_at"`);
  });

  it("one tracker row per order and worker; the note is bounded", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "managed_hiring_interest_order_worker_uq" ON "${INTEREST}" USING btree ("order_id","worker_id")`,
    );
    expect(FLAT).toContain(`CHECK (char_length("${INTEREST}"."note") BETWEEN 1 AND 500)`);
  });

  it("the contact-cost read is one index probe (payer, worker)", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "managed_hiring_interest_payer_worker_idx" ON "${INTEREST}" USING btree ("payer_id","worker_id")`,
    );
  });

  it("one callback request per job; reason and band spell the shared sets", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "managed_hiring_callback_requests_job_uq" ON "${CALLBACKS}" USING btree ("job_posting_id")`,
    );
    expect(FLAT).toContain(
      `CHECK ("${CALLBACKS}"."reason" IN (${inList(MANAGED_HIRING_CALLBACK_REASONS)}))`,
    );
    expect(FLAT).toContain(`CHECK ("${CALLBACKS}"."vacancy_band" IN (${inList(VACANCY_BANDS)}))`);
  });

  it("the only free text column is the tracker's staff note", () => {
    const freeText = [
      ...FLAT.matchAll(/"(note|notes|reason_text|comment|label|description)[a-z_]*" text/g),
    ].map((m) => m[1]);
    expect(freeText).toEqual(["note"]);
  });
});

describe("the header", () => {
  it("states the deploy order, the slot order, the locks and the rollback", () => {
    expect(RAW).toContain("NOT BEFORE THE DEPLOY");
    expect(RAW).toContain("Apply every lower-numbered migration first");
    expect(RAW).toContain("lock_timeout");
    for (const t of TABLES) expect(RAW).toContain(`DROP TABLE IF EXISTS "${t}";`);
    expect(RAW).toContain(`CHECK ("payment_orders"."product_kind" IN ('credit_pack'))`);
  });
});

describe("the journal and the snapshot", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records the migration at its slot, after its predecessor, with a later `when`", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(Number(SLOT));
    expect(previous.idx).toBe(Number(SLOT) - 1);
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("its snapshot builds on its predecessor's and records the three tables", () => {
    const previousSlot = String(Number(SLOT) - 1).padStart(4, "0");
    const next = snapshot(SLOT);
    expect(next.prevId).toBe(snapshot(previousSlot).id);
    for (const t of TABLES) expect(next.tables).toHaveProperty(`public.${t}`);
  });
});
