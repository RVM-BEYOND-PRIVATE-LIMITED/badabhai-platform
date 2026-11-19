import type { Database, PaymentOrder, PaymentRefundRow } from "@badabhai/db";

/**
 * #2750 item 10 — the GST credit note a refund needs (brief 4C.12; #2749 part 4 builds them).
 *
 * Owner ruling 2026-11-18: no refund goes out without its credit note. The refund service asks its
 * issuer twice, both times inside the refund's own transaction (the one that removes the credits
 * and writes the `payment_refunds` row):
 *
 *  1. {@link CreditNoteIssuer.prepare}, BEFORE any write: finds the order's invoice and refuses the
 *     refund with a typed code when no credit note can be issued (409 `NO_INVOICE_FOR_ORDER`, 409
 *     `CREDIT_NOTE_AMOUNT_MISMATCH`, 503 `INVOICES_UNAVAILABLE`);
 *  2. {@link CreditNoteIssuer.issueWithinTx}, AFTER the refund row exists: numbers the credit note
 *     in its own gap-free series, writes `credit_notes`, stamps
 *     `payment_refunds.credit_note_number` and records `credit_note.issued`.
 *
 * The bound issuer is `InvoiceCreditNotes` (`apps/api/src/invoices`). {@link NoCreditNotes} stays for
 * tests: it reports `available: false`, and every refund route then answers 503
 * `CREDIT_NOTES_UNAVAILABLE` before it reads anything.
 */
export interface CreditNoteIssuer {
  /** True once credit notes can be issued; until then no refund may be made. */
  readonly available: boolean;

  /** Step 1, before any write. Throws an HttpException with a typed code to refuse the refund. */
  prepare(tx: Database, order: PaymentOrder, amountPaise: number): Promise<PreparedCreditNote>;

  /** Step 2, after the refund row is written, on the same transaction. */
  issueWithinTx(
    tx: Database,
    prepared: PreparedCreditNote,
    refund: PaymentRefundRow,
    ctx: { correlationId: string; requestId?: string },
  ): Promise<{ creditNoteNumber: string }>;
}

/** What step 1 found, handed to step 2 (opaque to the refund service). */
export interface PreparedCreditNote {
  readonly invoiceId: string;
}

/** The Nest token the refund service injects its issuer by. */
export const CREDIT_NOTE_ISSUER = Symbol("CREDIT_NOTE_ISSUER");

/** No credit notes: refunds stay off. Kept for tests (production binds the real issuer). */
export class NoCreditNotes implements CreditNoteIssuer {
  readonly available = false;

  prepare(): Promise<PreparedCreditNote> {
    return Promise.reject(new Error("credit notes are not available"));
  }

  issueWithinTx(): Promise<{ creditNoteNumber: string }> {
    return Promise.reject(new Error("credit notes are not available"));
  }
}
