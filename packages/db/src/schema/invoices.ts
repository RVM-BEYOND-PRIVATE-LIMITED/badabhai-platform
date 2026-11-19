import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { InvoiceNumberSeries, InvoiceSupplyType } from "@badabhai/types";
import { paymentOrders } from "./payer";
import { paymentRefunds } from "./payment-refunds";

/**
 * #2749 part 4 — GST invoices and credit notes (migration 0188). Five new tables, nothing else
 * touched. Owner rulings 2026-11-18: the seller is entered BY HAND into `seller_tax_config` after
 * the merge; the invoice series is `<prefix>/<FY>/<serial>` (`BB/2026-27/0001`), the credit-note
 * series its own (`CN/2026-27/0001`), each gap-free and restarting every 1 April (IST); GST is
 * rounded to the rupee and no round-off line exists; billing details are saved once per company
 * and each invoice snapshots them at settle time.
 *
 * NO VALUE IN CODE. Not one GSTIN, PAN, name or address of the seller appears in this repository
 * (it is public): the seller row is typed into the database by the owner.
 *
 * RLS forced and every role revoked on all five (the migration's hand-written tail): only the
 * service role's backend reads them.
 */
export type InvoiceSupply = InvoiceSupplyType;
export type InvoiceSeries = InvoiceNumberSeries;

// ---------------------------------------------------------------------------
// seller_tax_config — the seller of record, entered by hand (#2749 item 1).
//
// ONE ACTIVE ROW (`seller_tax_config_one_active_uq`). Plain text, not ciphertext: the seller's
// GSTIN, PAN, name and address are printed on every invoice. Still never logged or emitted.
// A change of address or GSTIN is a NEW row (the old one set inactive): every invoice snapshots
// the row it was issued under, so history never moves.
//
// The prefixes are at most three characters, so a number with a four-digit serial fits Rule
// 46(b)'s 16 characters (`ABC/2026-27/0001`), and the two series never share a prefix.
// ---------------------------------------------------------------------------
export const sellerTaxConfig = pgTable(
  "seller_tax_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legalName: text("legal_name").notNull(),
    gstin: text("gstin").notNull(),
    pan: text("pan").notNull(),
    stateCode: text("state_code").notNull(),
    address: text("address").notNull(),
    sacCode: text("sac_code").notNull(),
    invoicePrefix: text("invoice_prefix").notNull(),
    creditNotePrefix: text("credit_note_prefix").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("seller_tax_config_one_active_uq").on(t.isActive).where(sql`${t.isActive}`),
    check("seller_tax_config_state_chk", sql`${t.stateCode} ~ '^[0-9]{2}$'`),
    check(
      "seller_tax_config_gstin_chk",
      sql`${t.gstin} ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' AND substr(${t.gstin}, 1, 2) = ${t.stateCode} AND substr(${t.gstin}, 3, 10) = ${t.pan}`,
    ),
    check("seller_tax_config_pan_chk", sql`${t.pan} ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`),
    check("seller_tax_config_sac_chk", sql`${t.sacCode} ~ '^[0-9]{6}$'`),
    check(
      "seller_tax_config_prefix_chk",
      sql`${t.invoicePrefix} ~ '^[A-Z][A-Z0-9]{0,2}$' AND ${t.creditNotePrefix} ~ '^[A-Z][A-Z0-9]{0,2}$' AND ${t.invoicePrefix} <> ${t.creditNotePrefix}`,
    ),
    check(
      "seller_tax_config_text_chk",
      sql`length(btrim(${t.legalName})) > 0 AND length(btrim(${t.address})) > 0`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type SellerTaxConfigRow = typeof sellerTaxConfig.$inferSelect;

// ---------------------------------------------------------------------------
// payer_billing_details — a company's billing details, saved once and reused (owner ruling
// 2026-11-18). Keyed by the TENANT KEY (the wallet's key, like `payer_credits`; no FK), so a team
// shares one set. Real checkout requires a row; each invoice snapshots it at settle time.
//
// `state_code` is plain (the place of supply: printed, and it decides CGST+SGST vs IGST). The
// GSTIN, legal name and address are AES ciphertext under the SAME key as `payers.org_name_enc`
// (`PiiCryptoService`). A GSTIN needs the legal name and the address beside it.
// ---------------------------------------------------------------------------
export const payerBillingDetails = pgTable(
  "payer_billing_details",
  {
    payerId: uuid("payer_id").primaryKey(),
    stateCode: text("state_code").notNull(),
    gstinEnc: text("gstin_enc"),
    legalNameEnc: text("legal_name_enc"),
    addressEnc: text("address_enc"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // The login that saved them (opaque `payers.id`).
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    check("payer_billing_details_state_chk", sql`${t.stateCode} ~ '^[0-9]{2}$'`),
    check(
      "payer_billing_details_gstin_chk",
      sql`${t.gstinEnc} IS NULL OR (${t.legalNameEnc} IS NOT NULL AND ${t.addressEnc} IS NOT NULL)`,
    ),
  ],
).enableRLS();

export type PayerBillingDetailsRow = typeof payerBillingDetails.$inferSelect;

// ---------------------------------------------------------------------------
// invoice_number_series — one gap-free counter per (series, financial year).
//
// Numbered with `INSERT … ON CONFLICT DO UPDATE SET last_number = last_number + 1 RETURNING`
// INSIDE the transaction that writes the document: the row lock serialises two issuers, and a
// rollback releases the number, so the series never has a gap. A new financial year starts a new
// row at 1.
// ---------------------------------------------------------------------------
export const invoiceNumberSeries = pgTable(
  "invoice_number_series",
  {
    series: text("series").$type<InvoiceSeries>().notNull(),
    financialYear: text("financial_year").notNull(),
    lastNumber: integer("last_number").notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "invoice_number_series_pk", columns: [t.series, t.financialYear] }),
    check("invoice_number_series_series_chk", sql`${t.series} IN ('invoice', 'credit_note')`),
    check("invoice_number_series_fy_chk", sql`${t.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check("invoice_number_series_last_chk", sql`${t.lastNumber} >= 0`),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// invoices — ONE per captured real payment order (`invoices_order_uq`), written in the settle's
// transaction (in a savepoint: a failure here never refuses the money).
//
// The seller is a SNAPSHOT of the active `seller_tax_config` row and the buyer a snapshot of the
// company's `payer_billing_details` at settle time (the ciphertext copied as is). Amounts come
// from the order's stamped paise: taxable + CGST + SGST + IGST = total; inside the seller's state
// only CGST/SGST, across states only IGST. `description` names the product, never a person.
// `is_test` copies `payers.is_test_account` of the wallet at settle time.
// ---------------------------------------------------------------------------
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentOrderId: uuid("payment_order_id")
      .notNull()
      .references(() => paymentOrders.id),
    // The wallet (tenant key) the order was stamped with. No FK, like the wallet.
    payerId: uuid("payer_id").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    financialYear: text("financial_year").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    sellerLegalName: text("seller_legal_name").notNull(),
    sellerGstin: text("seller_gstin").notNull(),
    sellerPan: text("seller_pan").notNull(),
    sellerStateCode: text("seller_state_code").notNull(),
    sellerAddress: text("seller_address").notNull(),
    sacCode: text("sac_code").notNull(),
    // The place of supply: the buyer's saved state, else the seller's (IGST Act s12(2)(b)).
    buyerStateCode: text("buyer_state_code").notNull(),
    buyerGstinEnc: text("buyer_gstin_enc"),
    buyerLegalNameEnc: text("buyer_legal_name_enc"),
    buyerAddressEnc: text("buyer_address_enc"),
    supplyType: text("supply_type").$type<InvoiceSupply>().notNull(),
    description: text("description").notNull(),
    taxablePaise: integer("taxable_paise").notNull(),
    cgstPaise: integer("cgst_paise").notNull(),
    sgstPaise: integer("sgst_paise").notNull(),
    igstPaise: integer("igst_paise").notNull(),
    totalPaise: integer("total_paise").notNull(),
    gstRateBps: integer("gst_rate_bps").notNull(),
    isTest: boolean("is_test").notNull().default(false),
    // `invoices/<financial year>/<id>.pdf` in INVOICES_BUCKET once rendered; null until then.
    pdfStorageKey: text("pdf_storage_key"),
    pdfRenderedAt: timestamp("pdf_rendered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_order_uq").on(t.paymentOrderId),
    uniqueIndex("invoices_number_uq").on(t.invoiceNumber),
    // The company's list, newest first.
    index("invoices_payer_idx").on(t.payerId, t.issuedAt.desc()),
    check("invoices_supply_chk", sql`${t.supplyType} IN ('intra', 'inter')`),
    check(
      "invoices_paise_chk",
      sql`${t.taxablePaise} >= 0 AND ${t.cgstPaise} >= 0 AND ${t.sgstPaise} >= 0 AND ${t.igstPaise} >= 0 AND ${t.totalPaise} >= 0`,
    ),
    check(
      "invoices_sum_chk",
      sql`${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.igstPaise} = ${t.totalPaise}`,
    ),
    check(
      "invoices_split_chk",
      sql`(${t.supplyType} = 'intra' AND ${t.igstPaise} = 0) OR (${t.supplyType} = 'inter' AND ${t.cgstPaise} = 0 AND ${t.sgstPaise} = 0)`,
    ),
    check(
      "invoices_place_chk",
      sql`(${t.supplyType} = 'intra') = (${t.buyerStateCode} = ${t.sellerStateCode}) AND ${t.buyerStateCode} ~ '^[0-9]{2}$'`,
    ),
    check("invoices_rate_chk", sql`${t.gstRateBps} BETWEEN 0 AND 10000`),
    check(
      "invoices_number_chk",
      sql`char_length(${t.invoiceNumber}) <= 16 AND ${t.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'`,
    ),
    check(
      "invoices_buyer_chk",
      sql`${t.buyerGstinEnc} IS NULL OR (${t.buyerLegalNameEnc} IS NOT NULL AND ${t.buyerAddressEnc} IS NOT NULL)`,
    ),
    check(
      "invoices_pdf_chk",
      sql`(${t.pdfStorageKey} IS NULL) = (${t.pdfRenderedAt} IS NULL)`,
    ),
  ],
).enableRLS();

export type InvoiceRow = typeof invoices.$inferSelect;

// ---------------------------------------------------------------------------
// credit_notes — ONE per refund (`credit_notes_refund_uq`), written in the refund's own
// transaction (the one that removes the credits and writes the `payment_refunds` row). Refunds are
// whole-order, so a credit note copies its invoice's tax lines. Its own gap-free series.
// ---------------------------------------------------------------------------
export const creditNotes = pgTable(
  "credit_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    paymentRefundId: uuid("payment_refund_id")
      .notNull()
      .references(() => paymentRefunds.id),
    creditNoteNumber: text("credit_note_number").notNull(),
    financialYear: text("financial_year").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    taxablePaise: integer("taxable_paise").notNull(),
    cgstPaise: integer("cgst_paise").notNull(),
    sgstPaise: integer("sgst_paise").notNull(),
    igstPaise: integer("igst_paise").notNull(),
    totalPaise: integer("total_paise").notNull(),
    pdfStorageKey: text("pdf_storage_key"),
    pdfRenderedAt: timestamp("pdf_rendered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("credit_notes_refund_uq").on(t.paymentRefundId),
    uniqueIndex("credit_notes_number_uq").on(t.creditNoteNumber),
    index("credit_notes_invoice_idx").on(t.invoiceId),
    check(
      "credit_notes_paise_chk",
      sql`${t.taxablePaise} >= 0 AND ${t.cgstPaise} >= 0 AND ${t.sgstPaise} >= 0 AND ${t.igstPaise} >= 0 AND ${t.totalPaise} >= 0`,
    ),
    check(
      "credit_notes_sum_chk",
      sql`${t.taxablePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.igstPaise} = ${t.totalPaise}`,
    ),
    // Never both kinds of tax: CGST/SGST (inside the state) or IGST (across states).
    check(
      "credit_notes_split_chk",
      sql`${t.igstPaise} = 0 OR (${t.cgstPaise} = 0 AND ${t.sgstPaise} = 0)`,
    ),
    check(
      "credit_notes_number_chk",
      sql`char_length(${t.creditNoteNumber}) <= 16 AND ${t.financialYear} ~ '^[0-9]{4}-[0-9]{2}$'`,
    ),
    check(
      "credit_notes_pdf_chk",
      sql`(${t.pdfStorageKey} IS NULL) = (${t.pdfRenderedAt} IS NULL)`,
    ),
  ],
).enableRLS();

export type CreditNoteRow = typeof creditNotes.$inferSelect;
