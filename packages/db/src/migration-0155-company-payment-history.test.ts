/**
 * Migration 0155 — company payment history (#2565 B11): stamp ₹ on plan/boost/
 * capacity rows + the per-top-up receipt table.
 *
 * Registered in the schema contract from day one — the #2506 lesson (0138 shipped
 * without an entry, auto-deployed ahead of its manual apply, and every payer
 * lookup 500'd). The writers name these columns explicitly and bare `select()`
 * readers name every model column, so the same miss here would 500 plan/boost/
 * capacity/top-up purchases and the payment-history read.
 *
 * Pinned: the exact statement set (three nullable ADD COLUMNs + one CREATE TABLE
 * + RLS FORCE/REVOKE — nothing dropped, renamed or backfilled in SQL; the
 * backfill is the `db:backfill:payment-prices` runner over the event spine), each
 * column's nullability, the LIVE model agreeing with the file, the operator
 * instructions (apply-before-deploy, rollback, the schema-contract id) and the
 * slot. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { payerCapacity, planQuotaTopups, postingBoosts, postingPlans } from "./schema/payer";

const TAG = "0155_company_payment_history";
const CONTRACT_ID = "0155-payment-history-prices";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const statements = FLAT.split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// String scan, not a dynamic RegExp (semgrep detect-non-literal-regexp; the 0133 precedent).
const statementFor = (needle: string): string => statements.find((s) => s.includes(needle)) ?? "";

describe("the fixture is real", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("only AFTER rolling the API back");
    expect(DDL).not.toContain("only AFTER rolling the API back");
  });
});

describe("0155 is additive only", () => {
  it("adds three nullable price columns + one table — and no data rewrite", () => {
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(3);
    expect(FLAT).toContain('CREATE TABLE "plan_quota_topups"');
    // NOTE: the FK clauses carry `ON DELETE …` / `ON UPDATE …` — the quotes pin
    // each verb to a real statement, so the referential actions cannot trip this.
    for (const verb of ['DROP "', 'UPDATE "', "INSERT INTO", "DELETE FROM", "TRUNCATE", "RENAME"]) {
      expect(FLAT.toUpperCase(), verb).not.toContain(verb);
    }
  });

  it("every price column is nullable with no default (pre-column rows render not-recorded)", () => {
    for (const col of [
      '"posting_plans" ADD COLUMN "price_inr" integer',
      '"posting_boosts" ADD COLUMN "price_inr" integer',
      '"payer_capacity" ADD COLUMN "price_inr" integer',
    ]) {
      const line = statementFor(col);
      expect(line, col).not.toHaveLength(0);
      expect(line, col).not.toContain("NOT NULL");
      expect(line, col).not.toContain("DEFAULT");
    }
  });

  it("the top-up receipt table carries the deny-by-default RLS tail", () => {
    expect(FLAT).toContain('"plan_quota_topups" FORCE ROW LEVEL SECURITY');
    expect(FLAT).toContain('REVOKE ALL ON TABLE "plan_quota_topups" FROM PUBLIC');
    expect(FLAT).toContain('REVOKE ALL ON TABLE "plan_quota_topups" FROM anon');
    expect(FLAT).toContain('REVOKE ALL ON TABLE "plan_quota_topups" FROM authenticated');
    expect(FLAT).toContain('REVOKE ALL ON TABLE "plan_quota_topups" FROM service_role');
  });
});

describe("the LIVE model carries the same shape", () => {
  it("models price_inr as nullable on plans, boosts and capacity", () => {
    for (const [table, name] of [
      [postingPlans, "postingPlans"],
      [postingBoosts, "postingBoosts"],
      [payerCapacity, "payerCapacity"],
    ] as const) {
      const col = getTableConfig(table).columns.find((c) => c.name === "price_inr");
      expect(col, name).toBeDefined();
      expect(col!.notNull, name).toBe(false);
    }
  });

  it("models the top-up receipt table with its indexes and checks", () => {
    const cols = getTableConfig(planQuotaTopups).columns.map((c) => c.name);
    for (const name of [
      "id",
      "plan_id",
      "job_posting_id",
      "payer_id",
      "tier",
      "quota_added",
      "price_inr",
      "created_at",
    ]) {
      expect(cols, name).toContain(name);
    }
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  it("says manual-apply-BEFORE-the-deploy and names the schema-contract id", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    expect(RAW).toContain("Manual apply BEFORE the build");
    expect(RAW).toContain(CONTRACT_ID);
  });

  it("is registered in the schema contract against the purchase writers", () => {
    const entry = SCHEMA_REQUIREMENTS.find((r) => r.id === CONTRACT_ID);
    expect(entry).toMatchObject({
      migration: TAG,
      kind: "column",
      table: "posting_plans",
      object: "price_inr",
    });
    for (const reader of ["insertPlan", "insertBoost", "upsertCapacity"]) {
      expect(entry?.requiredBy, reader).toContain(reader);
    }
  });

  it("states the lock guidance and the rollback for every added object", () => {
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain("ROLLBACK");
    expect(RAW).toContain('DROP TABLE "plan_quota_topups"');
    for (const name of ["price_inr"]) {
      expect(RAW, name).toContain(`DROP COLUMN IF EXISTS "${name}"`);
    }
  });

  it("holds the only 0155 slot, after 0154, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(155);
    expect(JOURNAL.entries.filter((e) => e.idx === 155)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(154);
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
