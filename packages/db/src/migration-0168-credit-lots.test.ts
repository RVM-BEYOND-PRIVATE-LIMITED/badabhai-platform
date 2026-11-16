/**
 * Migration 0168 — `credit_lots` and `credit_ledger.lot_id` (#2749 items 2-4): a company's
 * balance as lots that may expire, spent soonest-expiring first.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is
 * the half they do not see:
 *
 *   1. ADDITIVE — one new table, one new nullable column on `credit_ledger`; nothing dropped.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE RULES — the source CHECK is `CREDIT_LOT_SOURCES`; granted > 0; 0 ≤ remaining ≤
 *      granted; an expired lot holds nothing; one lot per paid order.
 *   4. THE BACKFILL — one `legacy`, never-expiring lot per positive balance, no ledger line,
 *      re-runnable on its own.
 *   5. THE HEADER — apply-before-deploy from the PR branch, the lock guidance, the rollback.
 *   6. THE MANIFEST AND THE SLOT.
 *
 * Nothing here connects to a database — `apps/api/src/unlocks/credit-lots.db.test.ts` does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { CREDIT_LOT_SOURCES } from "@badabhai/types";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { creditLedger, creditLots, schema } from "./schema";

const TAG = "0168_credit_lots";
const TABLE = "credit_lots";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const FLAT = RAW.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
const statements = FLAT.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const snapshot = (n: string): { id: string; prevId: string; tables: Record<string, unknown> } =>
  JSON.parse(
    readFileSync(join(__dirname, "..", "migrations", "meta", `${n}_snapshot.json`), "utf8"),
  );

const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${TABLE}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header DISCUSSES the rollback DROPs, which a naive scan would read as statements.
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
    expect(FLAT).not.toContain("DROP TABLE");
  });
});

describe("0168 is additive only", () => {
  it("creates exactly one table, and it is the new one", () => {
    expect([...FLAT.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1])).toEqual([TABLE]);
  });

  it("alters credit_ledger only to ADD the nullable lot_id and its FK, and locks the new table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)" ([A-Z ]+?)(?: "|$| ROW| \()/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(altered.sort()).toEqual(
      [
        `${TABLE} ENABLE`,
        `${TABLE} FORCE`,
        `${TABLE} ADD CONSTRAINT`,
        "credit_ledger ADD COLUMN",
        "credit_ledger ADD CONSTRAINT",
      ].sort(),
    );
    expect(FLAT).toContain(`ALTER TABLE "credit_ledger" ADD COLUMN "lot_id" uuid`);
    // Nullable, no default: catalog-only, and every pre-0168 line reads null.
    expect(FLAT).not.toMatch(/"lot_id" uuid (NOT NULL|DEFAULT)/);
  });

  it("drops, rewrites and renames nothing, and its only row write is the backfill INSERT", () => {
    for (const statement of statements) {
      for (const verb of ["DROP ", "UPDATE ", "DELETE ", "TRUNCATE"]) {
        expect(statement.toUpperCase().startsWith(verb), statement).toBe(false);
      }
    }
    for (const clause of [" DROP ", "RENAME", "ALTER COLUMN"]) {
      expect(FLAT.toUpperCase(), clause).not.toContain(clause);
    }
    const inserts = statements.filter((s) => s.toUpperCase().startsWith("INSERT "));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain(`INSERT INTO "${TABLE}"`);
    // No ledger line: the ledger already holds the grants the balances came from.
    expect(FLAT).not.toContain('INSERT INTO "credit_ledger"');
  });
});

describe("the table is locked (the RLS tail is hand-appended)", () => {
  it("ENABLE + FORCE + the four REVOKEs, and no policy", () => {
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT, role).toContain(`REVOKE ALL ON TABLE "${TABLE}" FROM ${role}`);
    }
    expect(FLAT).not.toContain("CREATE POLICY");
  });
});

describe("the rules", () => {
  it("credit_lots_source_chk is CREDIT_LOT_SOURCES", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "credit_lots_source_chk" CHECK ("${TABLE}"."source" IN (${sqlList(CREDIT_LOT_SOURCES)}))`,
    );
  });

  it("a lot grants something, holds between 0 and what it granted, and holds 0 once expired", () => {
    expect(FLAT).toContain(
      `CONSTRAINT "credit_lots_granted_pos_chk" CHECK ("${TABLE}"."credits_granted" > 0)`,
    );
    expect(FLAT).toContain(
      `CONSTRAINT "credit_lots_remaining_range_chk" CHECK ("${TABLE}"."credits_remaining" >= 0 AND "${TABLE}"."credits_remaining" <= "${TABLE}"."credits_granted")`,
    );
    expect(FLAT).toContain(
      `CONSTRAINT "credit_lots_expired_empty_chk" CHECK ("${TABLE}"."expired_at" IS NULL OR "${TABLE}"."credits_remaining" = 0)`,
    );
  });

  it("expires_at is nullable (never expires); is_test defaults to false", () => {
    expect(FLAT).toContain(`"expires_at" timestamp with time zone,`);
    expect(FLAT).toContain(`"is_test" boolean DEFAULT false NOT NULL`);
    expect(FLAT).toContain(`"payer_id" uuid NOT NULL`);
  });

  it("one lot per paid order: a partial UNIQUE index on payment_order_id", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "credit_lots_payment_order_uq" ON "${TABLE}" USING btree ("payment_order_id") WHERE "${TABLE}"."payment_order_id" IS NOT NULL`,
    );
  });

  it("the spend read and the sweep read are partial indexes over OPEN lots", () => {
    expect(FLAT).toContain(
      `CREATE INDEX "credit_lots_open_spend_idx" ON "${TABLE}" USING btree ("payer_id","expires_at","created_at","id") WHERE "${TABLE}"."credits_remaining" > 0`,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "credit_lots_due_idx" ON "${TABLE}" USING btree ("expires_at") WHERE "${TABLE}"."credits_remaining" > 0 AND "${TABLE}"."expires_at" IS NOT NULL`,
    );
  });

  it("the two foreign keys never cascade (billing records are never deleted)", () => {
    expect(FLAT).toContain(
      `ALTER TABLE "${TABLE}" ADD CONSTRAINT "credit_lots_payment_order_id_payment_orders_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."payment_orders"("id") ON DELETE no action`,
    );
    expect(FLAT).toContain(
      `ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_lot_id_credit_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."${TABLE}"("id") ON DELETE no action`,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "credit_ledger_lot_id_idx" ON "credit_ledger" USING btree ("lot_id")`,
    );
    expect(FLAT).not.toContain("ON DELETE cascade");
    expect(FLAT).not.toContain('REFERENCES "public"."payers"');
  });
});

describe("the backfill", () => {
  const backfill = statements.find((s) => s.startsWith(`INSERT INTO "${TABLE}"`)) ?? "";

  it("writes one legacy, never-expiring, non-test lot per positive balance (granted = remaining)", () => {
    expect(backfill).toContain(
      `("payer_id", "source", "credits_granted", "credits_remaining", "expires_at", "is_test")`,
    );
    expect(backfill).toContain(
      `SELECT pc."payer_id", 'legacy', pc."balance", pc."balance", NULL, false`,
    );
    expect(backfill).toContain(`FROM "payer_credits" pc WHERE pc."balance" > 0`);
  });

  it("is re-runnable on its own: a wallet that already has a lot is skipped", () => {
    expect(backfill).toContain(
      `NOT EXISTS (SELECT 1 FROM "${TABLE}" l WHERE l."payer_id" = pc."payer_id")`,
    );
  });

  it("runs after the table and its lock exist (it is the last statement)", () => {
    expect(statements.at(-1)).toBe(backfill);
  });
});

describe("the LIVE model carries the same objects", () => {
  it("the table, its columns, checks, indexes and RLS, and it is in the schema object", () => {
    const config = getTableConfig(creditLots);
    expect(config.name).toBe(TABLE);
    expect(config.enableRLS).toBe(true);
    expect(config.columns.map((c) => c.name).sort()).toEqual(
      [
        "id",
        "payer_id",
        "source",
        "pack_code",
        "payment_order_id",
        "credits_granted",
        "credits_remaining",
        "expires_at",
        "expired_at",
        "is_test",
        "created_at",
        "updated_at",
      ].sort(),
    );
    expect(config.checks.map((c) => c.name).sort()).toEqual(
      [
        "credit_lots_expired_empty_chk",
        "credit_lots_granted_pos_chk",
        "credit_lots_remaining_range_chk",
        "credit_lots_source_chk",
      ].sort(),
    );
    expect(config.indexes.map((i) => i.config.name).sort()).toEqual(
      ["credit_lots_due_idx", "credit_lots_open_spend_idx", "credit_lots_payment_order_uq"].sort(),
    );
    // rls-spine reconciles the live public tables against this object's size.
    expect(Object.values(schema)).toContain(creditLots);
  });

  it("credit_ledger models lot_id, nullable, with its index", () => {
    const config = getTableConfig(creditLedger);
    const lotId = config.columns.find((c) => c.name === "lot_id");
    expect(lotId?.notNull).toBe(false);
    expect(config.indexes.map((i) => i.config.name)).toContain("credit_ledger_lot_id_idx");
    expect(config.foreignKeys).toHaveLength(2); // unlock_id (0010) and lot_id (0168)
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  const entry = JOURNAL.entries.find((e) => e.tag === TAG);

  it("says apply before deploy, from the PR branch before the merge, and why", () => {
    expect(RAW).toContain("APPLY BEFORE DEPLOY, AND FROM THE PR BRANCH BEFORE MERGING IT");
    expect(RAW).toContain("auto-deploys");
    expect(RAW).toContain("42703");
    expect(RAW).toContain("42P01");
    expect(RAW).toContain("alignLotsWithBalance");
  });

  it("gives the lock guidance and the rollback, with this migration's own ledger row", () => {
    expect(RAW).toContain("SET LOCAL lock_timeout = '3s'");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain(`ALTER TABLE "credit_ledger" DROP COLUMN "lot_id";`);
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
    expect(RAW).toContain(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${entry?.when ?? "?"};`,
    );
  });

  it("registers the table, the column, the FK and the lock in the schema contract", () => {
    const ours = SCHEMA_REQUIREMENTS.filter((r) => r.migration === TAG);
    expect(ours.map((r) => `${r.kind} ${r.table}${r.object ? `.${r.object}` : ""}`)).toEqual([
      `table ${TABLE}`,
      "column credit_ledger.lot_id",
      "constraint credit_ledger.credit_ledger_lot_id_credit_lots_id_fk",
      `rls ${TABLE}`,
    ]);
  });

  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("holds the only 0168 slot, after 0167, with a later `when`", () => {
    expect(entry?.idx).toBe(168);
    expect(JOURNAL.entries.filter((e) => e.idx === 168)).toHaveLength(1);
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    const previous = JOURNAL.entries[at - 1]!;
    expect(previous.tag).toBe("0167_outbound_signals");
    expect(entry!.when).toBeGreaterThan(previous.when);
  });

  it("0168's snapshot builds on 0167's and records the table", () => {
    const next = snapshot("0168");
    expect(next.prevId).toBe(snapshot("0167").id);
    expect(next.tables).toHaveProperty(`public.${TABLE}`);
  });
});
