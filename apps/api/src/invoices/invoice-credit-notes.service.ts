import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { Database, InvoiceRow, PaymentOrder, PaymentRefundRow } from "@badabhai/db";
import { formatDocumentNumber } from "@badabhai/pricing";
import { sqlStateOf } from "../common/db-error";
import { EventsService } from "../events/events.service";
import type { CreditNoteIssuer, PreparedCreditNote } from "../payment-refunds/credit-note-issuer";
import { usableSeller } from "./invoice-issuer.service";
import { InvoicesRepository } from "./invoices.repository";

const UNDEFINED_TABLE = "42P01";

/** Step 1's finding: the invoice to reverse and the credit-note prefix in force. */
interface InvoicePrepared extends PreparedCreditNote {
  readonly invoice: InvoiceRow;
  readonly prefix: string;
}

function isInvoicePrepared(p: PreparedCreditNote): p is InvoicePrepared {
  return "invoice" in p && "prefix" in p;
}

/** 503: no credit note can be numbered (no active seller row, or the tables are missing). */
export function invoicesUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: "INVOICES_UNAVAILABLE",
    message: "GST invoices cannot be issued right now",
  });
}

/**
 * The real credit-note issuer (#2749 part 4), bound to `CREDIT_NOTE_ISSUER`: refunds are on once
 * it is (owner ruling 2026-11-18, ADR-0066 §2.11).
 *
 * Refunds are whole-order today, so a credit note copies its invoice's tax lines exactly. It is
 * numbered in its OWN gap-free series (`credit_note`, the active seller row's
 * `credit_note_prefix`), its instant and financial year read from the database clock under the
 * series row lock (as an invoice's), inside the refund's transaction: a refund that rolls back
 * releases the number.
 *
 * TEST MODE: a test-mode order has no invoice, so its refund is refused with
 * `NO_INVOICE_FOR_ORDER` before anything is numbered — no credit-note number is taken.
 *
 * REFUSALS, before the refund writes anything (step 1):
 *  - 409 `NO_INVOICE_FOR_ORDER`: the order has no invoice (its settle issued none);
 *  - 409 `CREDIT_NOTE_AMOUNT_MISMATCH`: the refund amount is not the invoice total;
 *  - 503 `INVOICES_UNAVAILABLE`: no active seller row, its GSTIN fails the check character, or the
 *    tables are missing.
 */
@Injectable()
export class InvoiceCreditNotes implements CreditNoteIssuer {
  readonly available = true;

  constructor(
    private readonly repo: InvoicesRepository,
    private readonly events: EventsService,
  ) {}

  async prepare(tx: Database, order: PaymentOrder, amountPaise: number): Promise<InvoicePrepared> {
    try {
      const invoice = await this.repo.findInvoiceByOrder(tx, order.id);
      if (!invoice) {
        throw new ConflictException({
          code: "NO_INVOICE_FOR_ORDER",
          message: "this order has no GST invoice, so no credit note can be issued for it",
        });
      }
      if (invoice.totalPaise !== amountPaise) {
        throw new ConflictException({
          code: "CREDIT_NOTE_AMOUNT_MISMATCH",
          message: "the refund amount is not the invoice total",
        });
      }
      const usable = usableSeller(await this.repo.activeSeller(tx));
      if (!usable.ok) throw invoicesUnavailable();
      return { invoiceId: invoice.id, invoice, prefix: usable.seller.creditNotePrefix };
    } catch (err) {
      if (sqlStateOf(err) === UNDEFINED_TABLE) throw invoicesUnavailable();
      throw err;
    }
  }

  async issueWithinTx(
    tx: Database,
    prepared: PreparedCreditNote,
    refund: PaymentRefundRow,
    ctx: { correlationId: string; requestId?: string },
  ): Promise<{ creditNoteNumber: string }> {
    if (!isInvoicePrepared(prepared)) throw new Error("credit note: not prepared by this issuer");
    const { invoice, prefix } = prepared;
    // The number, its instant and its year, from the database clock under the series row lock.
    const taken = await this.repo.nextNumber(tx, "credit_note");
    const { financialYear, issuedAt } = taken;
    const creditNoteNumber = formatDocumentNumber(prefix, financialYear, taken.serial);

    const note = await this.repo.insertCreditNote(tx, {
      invoiceId: invoice.id,
      paymentRefundId: refund.id,
      creditNoteNumber,
      financialYear,
      issuedAt,
      taxablePaise: invoice.taxablePaise,
      cgstPaise: invoice.cgstPaise,
      sgstPaise: invoice.sgstPaise,
      igstPaise: invoice.igstPaise,
      totalPaise: invoice.totalPaise,
    });
    await this.repo.stampRefundCreditNote(tx, refund.id, creditNoteNumber);
    await this.events.emit({
      event_name: "credit_note.issued",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "payer", subject_id: invoice.payerId },
      payload: {
        credit_note_id: note.id,
        invoice_id: invoice.id,
        payment_refund_id: refund.id,
        payer_id: invoice.payerId,
        financial_year: financialYear,
        total_paise: note.totalPaise,
      },
      idempotencyKey: `credit_note.issued:${refund.id}`,
      correlationId: ctx.correlationId,
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      tx,
    });
    return { creditNoteNumber };
  }
}
