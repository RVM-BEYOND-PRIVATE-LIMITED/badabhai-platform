/**
 * Migration 0176 — `payment_orders`: the money in paise, the product kind, the credit validity,
 * the purchase origin, and the `held` status (#2749 item 9, the storage half of item 7, hardening 5).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is
 * the half they do not see:
 *
 *   1. ADDITIVE — nine new columns, every one nullable or defaulted; `pack_code` relaxed, two CHECKs
 *      relaxed / widened; nothing dropped, no row rewritten.
 *   2. THE RULES — the CHECK copies of PAYMENT_ORDER_STATUSES / _PRODUCT_KINDS / _ORIGINS; the
 *      money all-or-none and its sum; a credit-pack order still names its pack and grants credits.
 *   3. THE HAND-WRITTEN ORDER — the job_postings FK last (its SHARE ROW EXCLUSIVE held shortest).
 *   4. THE HEADER — apply-before-deploy from the PR branch, the window, the locks, the rollback.
 *   5. THE MANIFEST AND THE SLOT.
 *
 * Nothing here connects to a database — `apps/api/src/unlocks/payment-orders.db.test.ts` does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  PAYMENT_ORDER_ORIGINS,
  PAYMENT_ORDER_PRODUCT_KINDS,
  PAYMENT_ORDER_STATUSES,
} from "@badabhai/types";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { paymentOrders } from "./schema";

const TAG = "0176_payment_order_money";
const T = "payment_orders";
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

const NEW_COLUMNS = [
  "product_kind",
  "taxable_paise",
  "gst_paise",
  "round_off_paise",
  "total_paise",
  "gst_rate_bps",
  "credit_validity_days",
  "origin",
  "origin_job_posting_id",
] as const;

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that alters payment_orders", () => {
    expect(FLAT).toContain(`ALTER TABLE "${T}" ADD COLUMN "total_paise" integer`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header DISCUSSES the rollback DROPs, which a naive scan would read as statements.
    expect(RAW).toContain(`ALTER TABLE "${T}" ALTER COLUMN "pack_code" SET NOT NULL;`);
    expect(FLAT).not.toContain("SET NOT NULL");
    expect(FLAT).not.toContain("DROP COLUMN");
  });
});

describe("0176 is additive only", () => {
  it("adds exactly the nine columns, each nullable except the defaulted product_kind", () => {
    const added = [...FLAT.matchAll(/ADD COLUMN "([a-z_]+)" ([a-z]+)([^;]*)/g)];
    expect(added.map((m) => m[1])).toEqual([...NEW_COLUMNS]);
    for (const m of added) {
      if (m[1] === "product_kind") {
        expect(m[3]?.trim()).toBe("DEFAULT 'credit_pack' NOT NULL");
      } else {
        expect(m[3]?.trim(), m[1]).toBe("");
      }
    }
    expect(added.find((m) => m[1] === "origin_job_posting_id")?.[2]).toBe("uuid");
    expect(added.find((m) => m[1] === "origin")?.[2]).toBe("text");
  });

  it("touches only payment_orders, creates no table and no policy", () => {
    const altered = new Set([...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]));
    expect([...altered]).toEqual([T]);
    expect(FLAT).not.toContain("CREATE TABLE");
    expect(FLAT).not.toContain("CREATE POLICY");
  });

  it("drops only the two CHECKs it re-adds, relaxes only pack_code, writes and renames nothing", () => {
    const dropped = [...FLAT.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
    expect(dropped).toEqual(["payment_orders_credits_pos_chk", "payment_orders_status_chk"]);
    for (const name of dropped) {
      expect(FLAT, name).toContain(`ADD CONSTRAINT "${name}" CHECK`);
    }
    expect(
      [...FLAT.matchAll(/ALTER COLUMN "([a-z_]+)" ([A-Z ]+?)(?:;|$)/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    ).toEqual(["pack_code DROP NOT NULL"]);
    for (const statement of statements) {
      for (const verb of ["DROP ", "UPDATE ", "DELETE ", "TRUNCATE", "INSERT "]) {
        expect(statement.toUpperCase().startsWith(verb), statement).toBe(false);
      }
    }
    expect(FLAT.toUpperCase()).not.toContain("RENAME");
    expect(FLAT).not.toContain("DROP COLUMN");
    expect(FLAT).not.toContain("DROP TABLE");
  });
});

describe("the rules", () => {
  it("the status CHECK is PAYMENT_ORDER_STATUSES — `held` included", () => {
    expect(PAYMENT_ORDER_STATUSES).toContain("held");
    expect(FLAT).toContain(
      `ADD CONSTRAINT "payment_orders_status_chk" CHECK ("${T}"."status" IN (${sqlList(PAYMENT_ORDER_STATUSES)}))`,
    );
  });

  it("the product kind CHECK as 0176 wrote it (credit_pack only; #2751's migration widens it); a credit-pack order names its pack and grants credits", () => {
    // A frozen record: 0176 admitted `credit_pack` alone. PAYMENT_ORDER_PRODUCT_KINDS has grown since
    // (#2751 added `managed_hiring`), and the managed-hiring migration's test pins the widened copy.
    expect(PAYMENT_ORDER_PRODUCT_KINDS[0]).toBe("credit_pack");
    expect(FLAT).toContain(
      `ADD CONSTRAINT "payment_orders_product_kind_chk" CHECK ("${T}"."product_kind" IN ('credit_pack'))`,
    );
    expect(FLAT).toContain(
      `ADD CONSTRAINT "payment_orders_pack_code_chk" CHECK ("${T}"."product_kind" <> 'credit_pack' OR "${T}"."pack_code" IS NOT NULL)`,
    );
    expect(FLAT).toContain(
      `ADD CONSTRAINT "payment_orders_credits_pos_chk" CHECK ("${T}"."credits_granted" > 0 OR "${T}"."product_kind" <> 'credit_pack')`,
    );
  });

  it("the origin CHECK is PAYMENT_ORDER_ORIGINS (or null)", () => {
    expect(FLAT).toContain(
      `ADD CONSTRAINT "payment_orders_origin_chk" CHECK ("${T}"."origin" IS NULL OR "${T}"."origin" IN (${sqlList(PAYMENT_ORDER_ORIGINS)}))`,
    );
  });

  it("the five money columns are all set or all null; set, they sum to a positive whole-rupee total equal to amount_inr", () => {
    const money = ["taxable_paise", "gst_paise", "round_off_paise", "total_paise", "gst_rate_bps"];
    expect(FLAT).toContain(
      `ADD CONSTRAINT "payment_orders_money_set_chk" CHECK ((${money.map((c) => `"${T}"."${c}" IS NULL`).join(" AND ")}) OR (${money.map((c) => `"${T}"."${c}" IS NOT NULL`).join(" AND ")}))`,
    );
    const sum = statements.find((x) => x.includes(`"payment_orders_money_sum_chk"`)) ?? "";
    expect(sum).toContain(`"${T}"."total_paise" IS NULL OR (`);
    expect(sum).toContain(
      `"${T}"."total_paise" = "${T}"."taxable_paise" + "${T}"."gst_paise" + "${T}"."round_off_paise"`,
    );
    expect(sum).toContain(`"${T}"."total_paise" > 0`);
    expect(sum).toContain(`"${T}"."total_paise" % 100 = 0`);
    expect(sum).toContain(`"${T}"."total_paise" = "${T}"."amount_inr" * 100`);
    expect(sum).toContain(`"${T}"."gst_rate_bps" BETWEEN 0 AND 10000`);
  });

  it("the validity is positive or null; the origin posting FK sets null on delete and is indexed", () => {
    expect(FLAT).toContain(
      `ADD CONSTRAINT "payment_orders_validity_pos_chk" CHECK ("${T}"."credit_validity_days" IS NULL OR "${T}"."credit_validity_days" > 0)`,
    );
    expect(FLAT).toContain(
      `ADD CONSTRAINT "payment_orders_origin_job_posting_id_job_postings_id_fk" FOREIGN KEY ("origin_job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null`,
    );
    expect(FLAT).toContain(
      `CREATE INDEX "payment_orders_origin_job_posting_idx" ON "${T}" USING btree ("origin_job_posting_id") WHERE "${T}"."origin_job_posting_id" IS NOT NULL`,
    );
    expect(FLAT).not.toContain("ON DELETE cascade");
  });
});

describe("the hand-written statement order", () => {
  const position = (prefix: string): number => {
    const at = statements.findIndex((x) => x.startsWith(prefix));
    expect(at, prefix).toBeGreaterThanOrEqual(0);
    return at;
  };

  it("columns first, then every CHECK, then the index, and the job_postings FK LAST", () => {
    const lastColumn = position(`ALTER TABLE "${T}" ALTER COLUMN "pack_code" DROP NOT NULL`);
    const firstCheck = position(
      `ALTER TABLE "${T}" DROP CONSTRAINT "payment_orders_credits_pos_chk"`,
    );
    for (const c of NEW_COLUMNS) {
      expect(position(`ALTER TABLE "${T}" ADD COLUMN "${c}"`), c).toBeLessThan(firstCheck);
    }
    expect(lastColumn).toBeLessThan(firstCheck);
    expect(position(`CREATE INDEX "payment_orders_origin_job_posting_idx"`)).toBe(
      statements.length - 2,
    );
    expect(statements.at(-1)).toMatch(
      /^ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_origin_job_posting_id_job_postings_id_fk" FOREIGN KEY/,
    );
    expect(statements.filter((x) => x.includes(`"job_postings"`))).toEqual([statements.at(-1)]);
  });

  it("each relaxed CHECK is re-added straight after its DROP", () => {
    for (const name of ["payment_orders_credits_pos_chk", "payment_orders_status_chk"]) {
      const drop = position(`ALTER TABLE "${T}" DROP CONSTRAINT "${name}"`);
      expect(statements[drop + 1], name).toMatch(
        new RegExp(`^ALTER TABLE "${T}" ADD CONSTRAINT "${name}" CHECK`),
      );
    }
  });

  it("the header names the order, the held locks and the re-apply rule after a regenerate", () => {
    expect(RAW).toContain("LOCKS, AND THE HAND-WRITTEN STATEMENT ORDER");
    expect(RAW).toContain("ACCESS EXCLUSIVE on `payment_orders`");
    expect(RAW).toContain("SHARE ROW EXCLUSIVE on `job_postings`");
    expect(RAW).toContain("VALIDATES EXISTING ROWS");
    expect(RAW).toContain("re-apply this order by hand");
  });
});

describe("the LIVE model carries the same objects", () => {
  it("the columns, their nullability, the checks and the index", () => {
    const config = getTableConfig(paymentOrders);
    const col = (name: string) => config.columns.find((c) => c.name === name);
    for (const c of NEW_COLUMNS) expect(col(c), c).toBeDefined();
    expect(col("product_kind")?.notNull).toBe(true);
    expect(col("product_kind")?.default).toBe("credit_pack");
    for (const c of NEW_COLUMNS.filter((x) => x !== "product_kind")) {
      expect(col(c)?.notNull, c).toBe(false);
    }
    expect(col("pack_code")?.notNull).toBe(false);
    expect(config.checks.map((c) => c.name).sort()).toEqual(
      [
        "payment_orders_amount_pos_chk",
        "payment_orders_credits_pos_chk",
        "payment_orders_money_set_chk",
        "payment_orders_money_sum_chk",
        "payment_orders_origin_chk",
        "payment_orders_pack_code_chk",
        "payment_orders_product_kind_chk",
        "payment_orders_status_chk",
        "payment_orders_validity_pos_chk",
      ].sort(),
    );
    expect(config.indexes.map((i) => i.config.name)).toContain(
      "payment_orders_origin_job_posting_idx",
    );
    expect(config.foreignKeys).toHaveLength(1); // origin_job_posting_id (0176); payer_id has none
  });
});

describe("the operator instructions, the manifest and the slot", () => {
  const entry = JOURNAL.entries.find((e) => e.tag === TAG);

  it("says apply before deploy, from the PR branch before the merge, and why", () => {
    expect(RAW).toContain("APPLY BEFORE DEPLOY, AND FROM THE PR BRANCH BEFORE MERGING IT");
    expect(RAW).toContain("auto-deploys");
    expect(RAW).toContain("bare `.select()`");
    expect(RAW).toContain("42703");
    expect(RAW).toContain("THE WINDOW BETWEEN APPLY AND DEPLOY IS SAFE");
  });

  it("says how to adopt it without lifting the watermark over a pending lower migration", () => {
    expect(RAW).toContain(
      "ADOPTION ORDER - DO NOT LIFT THE WATERMARK OVER A PENDING LOWER MIGRATION",
    );
    expect(RAW).toContain("`db:migrate` then skips it");
    expect(RAW).toContain("--only <this tag>");
    expect(RAW).toContain("the 0135 precedent");
  });

  it("gives the lock guidance and the rollback, with the held-order warning and this ledger row", () => {
    expect(RAW).toContain("SET LOCAL lock_timeout = '3s'");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain("WHERE status = 'held'");
    expect(RAW).toContain(`ALTER TABLE "${T}" ALTER COLUMN "pack_code" SET NOT NULL;`);
    expect(RAW).toContain(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${entry?.when ?? "?"};`,
    );
  });

  it("registers every new column, the new CHECKs and the FK in the schema contract", () => {
    const ours = SCHEMA_REQUIREMENTS.filter((r) => r.migration === TAG);
    expect(ours.map((r) => `${r.kind} ${r.table}.${r.object ?? ""}`)).toEqual([
      ...NEW_COLUMNS.map((c) => `column ${T}.${c}`),
      `constraint ${T}.payment_orders_money_sum_chk`,
      `constraint ${T}.payment_orders_pack_code_chk`,
      `constraint ${T}.payment_orders_origin_job_posting_id_job_postings_id_fk`,
    ]);
  });

  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("holds the only 0176 slot, after 0175, with a later `when`", () => {
    expect(entry?.idx).toBe(176);
    expect(JOURNAL.entries.filter((e) => e.idx === 176)).toHaveLength(1);
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    const previous = JOURNAL.entries[at - 1]!;
    expect(previous.tag).toBe("0175_payer_phone_proofs");
    expect(entry!.when).toBeGreaterThan(previous.when);
  });

  it("0176's snapshot builds on 0175's and records the new columns", () => {
    const next = snapshot("0176");
    expect(next.prevId).toBe(snapshot("0175").id);
    const table = next.tables[`public.${T}`] as { columns: Record<string, unknown> };
    for (const c of NEW_COLUMNS) expect(table.columns, c).toHaveProperty(c);
  });
});
