import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { financialYearOf } from "@badabhai/pricing";
import {
  creditNotes,
  invoices,
  payerBillingDetails,
  payers,
  paymentOrders,
  paymentRefunds,
  sellerTaxConfig,
  type CreditNoteRow,
  type Database,
  type InvoiceRow,
  type InvoiceSeries,
  type PaymentOrder,
  type PayerBillingDetailsRow,
  type SellerTaxConfigRow,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The ciphertext columns of a company's billing details, as stored. */
export interface BillingDetailsWrite {
  readonly payerId: string;
  readonly stateCode: string;
  readonly gstinEnc: string | null;
  readonly legalNameEnc: string | null;
  readonly addressEnc: string | null;
  readonly updatedBy: string;
}

/** One invoice in the company's list, with its credit note when the order was refunded. */
export interface InvoiceListRow {
  readonly invoice: InvoiceRow;
  readonly creditNote: Pick<CreditNoteRow, "id" | "creditNoteNumber" | "issuedAt" | "totalPaise"> | null;
}

/** A credit note with the invoice it reverses (the PDF prints both numbers and the snapshots). */
export interface CreditNoteWithInvoice {
  readonly creditNote: CreditNoteRow;
  readonly invoice: InvoiceRow;
}

/** A number taken from a series, with the instant and financial year it was taken in. */
export interface IssuedNumber {
  readonly serial: number;
  readonly financialYear: string;
  readonly issuedAt: Date;
}

/** A lock wait straddled 1 April 00:00 IST: the year chosen and the instant read disagree. */
export class FinancialYearMovedError extends Error {
  override readonly name = "FinancialYearMovedError";
}

/**
 * The Indian financial year (`2026-27`) of `t.ist`, an IST wall-clock timestamp: from 1 April the
 * year that starts then, before it the year that started the April before. SQL twin of
 * `financialYearOf` (`@badabhai/pricing`); the DB test proves they agree.
 */
const FINANCIAL_YEAR_OF_IST = sql.raw(
  `(CASE WHEN extract(month FROM t.ist) >= 4 ` +
    `THEN to_char(t.ist, 'YYYY') || '-' || to_char(t.ist + interval '1 year', 'YY') ` +
    `ELSE to_char(t.ist - interval '1 year', 'YYYY') || '-' || to_char(t.ist, 'YY') END)`,
);

/** The most invoices `GET /payer/invoices` returns (newest first). */
export const INVOICE_LIST_LIMIT = 200;

/**
 * Data access for the invoice tables (#2749 part 4, migration 0188): the seller row, a company's
 * billing details, the gap-free number series, invoices and credit notes. The ONLY reader and
 * writer of the five tables. Every write that belongs to a money transaction takes the caller's
 * executor (`db`): the settle's savepoint, or the refund's transaction.
 */
@Injectable()
export class InvoicesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The pool, for the reads that take a handle. */
  get reader(): Database {
    return this.db;
  }

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => work(tx as unknown as Database));
  }

  /** The one active seller row, or undefined (the owner has not entered it yet). */
  async activeSeller(db: Database = this.db): Promise<SellerTaxConfigRow | undefined> {
    const [row] = await db
      .select()
      .from(sellerTaxConfig)
      .where(eq(sellerTaxConfig.isActive, true))
      .limit(1);
    return row;
  }

  async billingDetails(
    payerId: string,
    db: Database = this.db,
  ): Promise<PayerBillingDetailsRow | undefined> {
    const [row] = await db
      .select()
      .from(payerBillingDetails)
      .where(eq(payerBillingDetails.payerId, payerId))
      .limit(1);
    return row;
  }

  /** Save (insert or replace) a company's billing details, on the caller's transaction. */
  async upsertBillingDetails(tx: Database, values: BillingDetailsWrite): Promise<PayerBillingDetailsRow> {
    const [row] = await tx
      .insert(payerBillingDetails)
      .values({ ...values, updatedAt: sql`now()` })
      .onConflictDoUpdate({
        target: payerBillingDetails.payerId,
        set: {
          stateCode: values.stateCode,
          gstinEnc: values.gstinEnc,
          legalNameEnc: values.legalNameEnc,
          addressEnc: values.addressEnc,
          updatedBy: values.updatedBy,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    if (!row) throw new Error("invoices: the billing details were not written");
    return row;
  }

  /**
   * The next number of a series, GAP-FREE, with the document's issue instant and financial year.
   *
   * ONE statement on the caller's transaction: it reads the database clock once (a CTE), derives
   * the Indian financial year from it (IST), inserts that year's row at 1 or adds 1 to it, and
   * RETURNS `clock_timestamp()` taken AFTER the row lock is held. Two issuers serialise on the row;
   * the second's instant is read only once the first has committed, so a later number never
   * carries an earlier date (no inversion around midnight). A rollback of the caller releases the
   * number, so none is ever skipped.
   *
   * THE YEAR AND THE INSTANT AGREE. The year is chosen before the lock and the instant read after
   * it; if a lock wait straddled 1 April 00:00 IST they would disagree, so that attempt is rolled
   * back (its own savepoint: the number is released) and taken again, up to three times.
   *
   * `fixedAt` (tests only) replaces the clock with one instant, so the year boundary can be proved.
   */
  async nextNumber(tx: Database, series: InvoiceSeries, fixedAt?: Date): Promise<IssuedNumber> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await tx.transaction((sp) => this.takeNumber(sp as unknown as Database, series, fixedAt));
      } catch (err) {
        if (!(err instanceof FinancialYearMovedError) || attempt >= 3) throw err;
      }
    }
  }

  private async takeNumber(tx: Database, series: InvoiceSeries, fixedAt?: Date): Promise<IssuedNumber> {
    const clock = fixedAt ? sql`${fixedAt.toISOString()}::timestamptz` : sql`clock_timestamp()`;
    const rows = await tx.execute<{ last_number: number; financial_year: string; issued_at: Date | string }>(sql`
      WITH t AS (SELECT (${clock}) AT TIME ZONE 'Asia/Kolkata' AS ist)
      INSERT INTO invoice_number_series AS s (series, financial_year, last_number)
      SELECT ${series}, ${FINANCIAL_YEAR_OF_IST}, 1 FROM t
      ON CONFLICT (series, financial_year) DO UPDATE SET last_number = s.last_number + 1
      RETURNING s.last_number, s.financial_year, ${clock} AS issued_at`);
    const row = rows[0];
    if (!row) throw new Error("invoices: the number series did not answer");
    const issuedAt = row.issued_at instanceof Date ? row.issued_at : new Date(row.issued_at);
    if (financialYearOf(issuedAt) !== row.financial_year) throw new FinancialYearMovedError();
    return { serial: Number(row.last_number), financialYear: row.financial_year, issuedAt };
  }

  /** The financial year the database assigns an instant (the same expression `nextNumber` uses). */
  async financialYearInDb(at: Date): Promise<string> {
    const rows = await this.db.execute<{ fy: string }>(sql`
      SELECT ${FINANCIAL_YEAR_OF_IST} AS fy
      FROM (SELECT ${at.toISOString()}::timestamptz AT TIME ZONE 'Asia/Kolkata' AS ist) t`);
    return rows[0]!.fy;
  }

  /** `payers.is_test_account` of the wallet's anchor row (false when there is no such row). */
  async isTestPayer(db: Database, payerId: string): Promise<boolean> {
    const [row] = await db
      .select({ isTest: payers.isTestAccount })
      .from(payers)
      .where(eq(payers.id, payerId))
      .limit(1);
    return row?.isTest ?? false;
  }

  /** A payment order by our row id (the repair CLI's read). */
  async findPaymentOrder(orderId: string): Promise<PaymentOrder | undefined> {
    const [row] = await this.db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.id, orderId))
      .limit(1);
    return row;
  }

  async findInvoiceByOrder(db: Database, paymentOrderId: string): Promise<InvoiceRow | undefined> {
    const [row] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.paymentOrderId, paymentOrderId))
      .limit(1);
    return row;
  }

  async insertInvoice(tx: Database, values: typeof invoices.$inferInsert): Promise<InvoiceRow> {
    const [row] = await tx.insert(invoices).values(values).returning();
    if (!row) throw new Error("invoices: the invoice row was not written");
    return row;
  }

  async insertCreditNote(
    tx: Database,
    values: typeof creditNotes.$inferInsert,
  ): Promise<CreditNoteRow> {
    const [row] = await tx.insert(creditNotes).values(values).returning();
    if (!row) throw new Error("invoices: the credit note row was not written");
    return row;
  }

  /** Stamp the credit note's number on its refund row (the refund's own transaction). */
  async stampRefundCreditNote(tx: Database, refundId: string, creditNoteNumber: string): Promise<void> {
    await tx
      .update(paymentRefunds)
      .set({ creditNoteNumber, updatedAt: sql`now()` })
      .where(eq(paymentRefunds.id, refundId));
  }

  /** The company's invoices, newest first, each with its credit note (one refund per order). */
  async listForPayer(payerId: string, limit = INVOICE_LIST_LIMIT): Promise<InvoiceListRow[]> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.payerId, payerId))
      .orderBy(desc(invoices.issuedAt), desc(invoices.id))
      .limit(limit);
    if (rows.length === 0) return [];
    const notes = await this.db
      .select({
        id: creditNotes.id,
        invoiceId: creditNotes.invoiceId,
        creditNoteNumber: creditNotes.creditNoteNumber,
        issuedAt: creditNotes.issuedAt,
        totalPaise: creditNotes.totalPaise,
      })
      .from(creditNotes)
      .where(
        inArray(
          creditNotes.invoiceId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(creditNotes.issuedAt);
    const byInvoice = new Map<string, InvoiceListRow["creditNote"]>();
    for (const n of notes) {
      if (!byInvoice.has(n.invoiceId)) {
        byInvoice.set(n.invoiceId, {
          id: n.id,
          creditNoteNumber: n.creditNoteNumber,
          issuedAt: n.issuedAt,
          totalPaise: n.totalPaise,
        });
      }
    }
    return rows.map((invoice) => ({ invoice, creditNote: byInvoice.get(invoice.id) ?? null }));
  }

  /** One invoice, only when it belongs to the wallet (else undefined: the caller's neutral 404). */
  async findInvoiceForPayer(invoiceId: string, payerId: string): Promise<InvoiceRow | undefined> {
    const [row] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.payerId, payerId)))
      .limit(1);
    return row;
  }

  async findInvoice(invoiceId: string): Promise<InvoiceRow | undefined> {
    const [row] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    return row;
  }

  /** One credit note with its invoice, only when the invoice belongs to the wallet. */
  async findCreditNoteForPayer(
    creditNoteId: string,
    payerId: string,
  ): Promise<CreditNoteWithInvoice | undefined> {
    const [row] = await this.db
      .select({ creditNote: creditNotes, invoice: invoices })
      .from(creditNotes)
      .innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
      .where(and(eq(creditNotes.id, creditNoteId), eq(invoices.payerId, payerId)))
      .limit(1);
    return row;
  }

  /**
   * Record where an invoice's PDF is stored. Compare-and-set on a null key, so two concurrent
   * first downloads keep the first key (both uploaded the same deterministic object path).
   */
  async markInvoicePdf(invoiceId: string, key: string): Promise<void> {
    await this.db
      .update(invoices)
      .set({ pdfStorageKey: key, pdfRenderedAt: sql`now()` })
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.pdfStorageKey)));
  }

  async markCreditNotePdf(creditNoteId: string, key: string): Promise<void> {
    await this.db
      .update(creditNotes)
      .set({ pdfStorageKey: key, pdfRenderedAt: sql`now()` })
      .where(and(eq(creditNotes.id, creditNoteId), isNull(creditNotes.pdfStorageKey)));
  }
}
