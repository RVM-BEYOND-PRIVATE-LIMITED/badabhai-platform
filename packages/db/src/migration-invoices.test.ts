/**
 * Migration `<slot>_invoices` — GST invoices and credit notes (#2749 part 4). The file is found by
 * its NAME, not its number: the slot is taken at merge time and may be regenerated under another
 * number, and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — five new tables, their indexes and foreign keys. Nothing dropped, no existing
 *      table altered beyond being referenced, no row written (the seller row is a hand step).
 *   2. THE RLS TAIL — FORCE and the four REVOKEs on every one of the five; a regenerate drops them.
 *   3. THE MONEY CHECKS — paise never negative, taxable + CGST + SGST + IGST = total, intra-state
 *      has no IGST and inter-state no CGST/SGST; one invoice per order, one credit note per refund,
 *      unique numbers no longer than 16 characters; one active seller row.
 *   4. THE HEADER — deploy order (before the deploy), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_invoices\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const TABLES = [
  "seller_tax_config",
  "payer_billing_details",
  "invoice_number_series",
  "invoices",
  "credit_notes",
] as const;
const RAW = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

const snapshot = (n: string): { id: string; prevId: string; tables: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", `${n}_snapshot.json`), "utf8"));

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one invoices migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates every table", () => {
    for (const t of TABLES) expect(FLAT).toContain(`CREATE TABLE "${t}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE DEPLOY");
    expect(DDL).not.toContain("APPLY BEFORE DEPLOY");
  });
});

describe("the migration is additive", () => {
  it("creates exactly five tables and seven indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(5);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(7);
  });

  it("alters only the new tables", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(TABLES));
  });

  it("drops nothing, deletes nothing, writes no rows and seeds nothing", () => {
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

  it("references payment_orders, payment_refunds and invoices, never cascading (tax records are kept)", () => {
    const refs = [
      ...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+ ?\w*)/g),
    ];
    expect(refs.map((m) => `${m[1]}:${m[2]!.replace(/ ON$/, "")}`).sort()).toEqual([
      "invoices:no action",
      "payment_orders:no action",
      "payment_refunds:no action",
    ]);
  });
});

describe("deny by default", () => {
  it.each(TABLES)("%s: enables AND forces RLS, and revokes every client role", (t) => {
    expect(FLAT).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "${t}" FROM ${role}`);
    }
  });

  it("creates no policy and grants nothing", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });
});

describe("the money and numbering checks", () => {
  it("one invoice per order, one credit note per refund, unique numbers", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "invoices_order_uq" ON "invoices" USING btree ("payment_order_id")`,
    );
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("invoice_number")`,
    );
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "credit_notes_refund_uq" ON "credit_notes" USING btree ("payment_refund_id")`,
    );
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "credit_notes_number_uq" ON "credit_notes" USING btree ("credit_note_number")`,
    );
  });

  it.each(["invoices", "credit_notes"])("%s: paise never negative and the lines sum to the total", (t) => {
    expect(FLAT).toContain(
      `CHECK ("${t}"."taxable_paise" >= 0 AND "${t}"."cgst_paise" >= 0 AND "${t}"."sgst_paise" >= 0 AND "${t}"."igst_paise" >= 0 AND "${t}"."total_paise" >= 0)`,
    );
    expect(FLAT).toContain(
      `CHECK ("${t}"."taxable_paise" + "${t}"."cgst_paise" + "${t}"."sgst_paise" + "${t}"."igst_paise" = "${t}"."total_paise")`,
    );
  });

  it("an invoice inside the state has no IGST; across states, no CGST/SGST; the place decides which", () => {
    expect(FLAT).toContain(
      `CHECK (("invoices"."supply_type" = 'intra' AND "invoices"."igst_paise" = 0) OR ("invoices"."supply_type" = 'inter' AND "invoices"."cgst_paise" = 0 AND "invoices"."sgst_paise" = 0))`,
    );
    expect(FLAT).toContain(
      `("invoices"."supply_type" = 'intra') = ("invoices"."buyer_state_code" = "invoices"."seller_state_code")`,
    );
    expect(FLAT).toContain(`CHECK ("invoices"."supply_type" IN ('intra', 'inter'))`);
  });

  it("numbers fit Rule 46(b)'s 16 characters; the financial year is YYYY-YY", () => {
    expect(FLAT).toContain(`char_length("invoices"."invoice_number") <= 16`);
    expect(FLAT).toContain(`char_length("credit_notes"."credit_note_number") <= 16`);
    expect(FLAT).toContain(`"invoice_number_series"."financial_year" ~ '^[0-9]{4}-[0-9]{2}$'`);
  });

  it("the series: two names, one row per (series, year), never below zero", () => {
    expect(FLAT).toContain(`PRIMARY KEY("series","financial_year")`);
    expect(FLAT).toContain(`CHECK ("invoice_number_series"."series" IN ('invoice', 'credit_note'))`);
    expect(FLAT).toContain(`CHECK ("invoice_number_series"."last_number" >= 0)`);
  });

  it("one active seller row; prefixes of at most three characters that differ", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "seller_tax_config_one_active_uq" ON "seller_tax_config" USING btree ("is_active") WHERE "seller_tax_config"."is_active"`,
    );
    expect(FLAT).toContain(`"seller_tax_config"."invoice_prefix" ~ '^[A-Z][A-Z0-9]{0,2}$'`);
    expect(FLAT).toContain(
      `"seller_tax_config"."invoice_prefix" <> "seller_tax_config"."credit_note_prefix"`,
    );
  });

  it("a buyer GSTIN needs its legal name and address beside it", () => {
    expect(FLAT).toContain(
      `CHECK ("payer_billing_details"."gstin_enc" IS NULL OR ("payer_billing_details"."legal_name_enc" IS NOT NULL AND "payer_billing_details"."address_enc" IS NOT NULL))`,
    );
  });

  it("the buyer's details are ciphertext columns; no plain buyer GSTIN, name or address", () => {
    expect(FLAT).not.toMatch(/"buyer_(gstin|legal_name|address)" text/);
    expect(FLAT).not.toMatch(/"payer_billing_details" \([^)]*"(gstin|legal_name|address)" text/);
  });
});

describe("the header", () => {
  it("states the deploy order, the slot order, the locks and the rollback", () => {
    expect(RAW).toContain("Apply every lower-numbered migration first");
    expect(RAW).toContain("lock_timeout");
    for (const t of TABLES) expect(RAW).toContain(`DROP TABLE IF EXISTS "${t}";`);
  });

  it("carries no GSTIN-shaped value", () => {
    expect(RAW).not.toMatch(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]/);
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

  it("its snapshot builds on its predecessor's and records every table", () => {
    const previousSlot = String(Number(SLOT) - 1).padStart(4, "0");
    const next = snapshot(SLOT);
    expect(next.prevId).toBe(snapshot(previousSlot).id);
    for (const t of TABLES) expect(next.tables).toHaveProperty(`public.${t}`);
  });
});
