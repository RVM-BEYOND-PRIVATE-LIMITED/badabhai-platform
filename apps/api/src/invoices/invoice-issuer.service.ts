import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Database, PaymentOrder, SellerTaxConfigRow } from "@badabhai/db";
import {
  formatDocumentNumber,
  isValidGstin,
  splitGstForSupply,
  supplyTypeFor,
} from "@badabhai/pricing";
import type { InvoiceNotIssuedReason } from "@badabhai/types";
import { sqlStateOf } from "../common/db-error";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { invoiceDescription } from "./invoice-description";
import { InvoicesRepository } from "./invoices.repository";
import { isInvoiceTestMode } from "./test-mode";

/** The tracing ids an issuing transaction carries onto its events. */
export interface IssueContext {
  readonly correlationId: string;
  readonly requestId?: string;
}

/** The order's tax lines in paise, from its stamped columns. Null for a pre-0176 order. */
export function invoiceAmountsOf(
  order: Pick<PaymentOrder, "taxablePaise" | "totalPaise" | "gstRateBps">,
): { taxablePaise: number; gstPaise: number; totalPaise: number; gstRateBps: number } | null {
  if (order.taxablePaise === null || order.totalPaise === null || order.gstRateBps === null) {
    return null;
  }
  // The GST is what the buyer paid over the taxable value: total − taxable. For an order stamped
  // under the earlier rule (GST to the paisa plus a round-off) this is the same whole rupee the
  // owner's ruling prints, because both the total and the taxable value are whole rupees.
  return {
    taxablePaise: order.taxablePaise,
    gstPaise: order.totalPaise - order.taxablePaise,
    totalPaise: order.totalPaise,
    gstRateBps: order.gstRateBps,
  };
}

/**
 * The seller row an invoice or credit note may be issued under: the active row, and only when its
 * GSTIN passes the check character (the DB CHECK pins the shape, not the checksum). A row typed in
 * with a mistyped GSTIN is treated like no row: nothing is issued under it.
 */
export function usableSeller(
  seller: SellerTaxConfigRow | undefined,
): { ok: true; seller: SellerTaxConfigRow } | { ok: false; reason: "seller_not_configured" | "seller_config_invalid" } {
  if (!seller) return { ok: false, reason: "seller_not_configured" };
  if (!isValidGstin(seller.gstin)) return { ok: false, reason: "seller_config_invalid" };
  return { ok: true, seller };
}

/** Thrown inside the savepoint: there is no usable seller row to issue under. */
export class SellerNotConfiguredError extends Error {
  override readonly name = "SellerNotConfiguredError";
  constructor(readonly reason: "seller_not_configured" | "seller_config_invalid") {
    super(reason);
  }
}

/** Thrown inside the savepoint: the order carries no paise price line (a pre-0176 order). */
export class PriceLineMissingError extends Error {
  override readonly name = "PriceLineMissingError";
}

/** The Razorpay provider name on `payment_orders.provider` (a real order). */
const RAZORPAY = "razorpay";

/** A real captured order: Razorpay, paid, with the provider's payment id. */
export function isRealPaidOrder(order: Pick<PaymentOrder, "provider" | "status" | "providerPaymentRef">): boolean {
  return (
    order.provider === RAZORPAY &&
    order.status === "paid" &&
    order.providerPaymentRef !== null &&
    order.providerPaymentRef.length > 0
  );
}

/**
 * Issues the GST invoice of a captured real payment, INSIDE the settle's transaction (#2749 item
 * 8; owner rulings 2026-11-18).
 *
 * MONEY TAKEN IS NEVER REFUSED. The whole write runs in a SAVEPOINT (a nested transaction). If
 * anything in it throws — no usable seller row (none, or a GSTIN that fails its check character),
 * a pre-0176 order with no price line, a missing table, a number past 16 characters — only the
 * savepoint rolls back: the credits the settle granted stay, one ERROR line is logged (ids and an
 * error class, no PII) and `payment.invoice_not_issued` is recorded on the settle's transaction.
 *
 * TEST MODE (a `rzp_test_` key id): no invoice and no number; `payment.invoice_not_issued` with
 * reason `test_mode` (a WARN line, not an ERROR: nothing needs repairing).
 *
 * ONE PER ORDER. The settle's compare-and-set already lets exactly one caller reach this; an
 * invoice already on the order (`invoices_order_uq` behind it) issues nothing new and records
 * nothing.
 *
 * WHAT IT WRITES: the next gap-free number of the `invoice` series, with the issue instant and the
 * financial year read from the database clock UNDER the series row lock (so numbers and dates never
 * invert), the usable seller row as a snapshot, the company's saved billing details as a snapshot
 * (the ciphertext copied as is), the place of supply = the company's saved state, else the seller's
 * own (IGST Act s12(2)(b): an unregistered recipient with no address on record), the tax split by
 * {@link splitGstForSupply}, `is_test` from the wallet's `payers.is_test_account`, and
 * `invoice.issued` on the same savepoint.
 *
 * A captured payment left without an invoice is repaired, one order at a time, by
 * `issue-missing-invoice.cli` ({@link issueWithinTx} in its own transaction).
 */
@Injectable()
export class InvoiceIssuer {
  private readonly logger = new Logger(InvoiceIssuer.name);

  constructor(
    private readonly repo: InvoicesRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerConfig, "PAYMENTS_PROVIDER_KEY">,
  ) {}

  /** True while the api runs on a Razorpay TEST key: no invoice is issued. */
  get testMode(): boolean {
    return isInvoiceTestMode(this.config);
  }

  /**
   * Issue the invoice of `order` (the row the settle just CLAIMED, status `paid`) on `tx`, the
   * settle's transaction. Returns the new invoice's id, or null when none was issued. Never throws
   * for a business reason, and even a failure to record that the invoice was NOT issued is caught
   * and logged, so a settle never fails here.
   */
  async issueForSettledOrderWithinTx(
    tx: Database,
    order: PaymentOrder,
    ctx: IssueContext,
  ): Promise<string | null> {
    // Only a real captured order: every payment order is a Razorpay order today (the mock route
    // writes none), and it carries the provider's payment id once claimed.
    if (order.provider !== RAZORPAY || order.providerPaymentRef === null) return null;
    if (this.testMode) {
      this.logger.warn(`test-mode payment: no GST invoice issued order_row=${order.id}`);
      await this.recordNotIssued(tx, order, "test_mode", ctx);
      return null;
    }
    try {
      return await tx.transaction(async (sp) => {
        const savepoint = sp as unknown as Database;
        if (await this.repo.findInvoiceByOrder(savepoint, order.id)) return null; // a replay
        return this.issueWithinTx(savepoint, order, ctx);
      });
    } catch (err) {
      const reason = reasonOf(err);
      this.logger.error(
        `invoice NOT issued; credits granted order_row=${order.id} reason=${reason} ` +
          `error=${errorClass(err)} sqlstate=${sqlStateOf(err) ?? "none"}`,
      );
      await this.recordNotIssued(tx, order, reason, ctx);
      return null;
    }
  }

  /**
   * Write the invoice of `order` on `tx` and record `invoice.issued`. THROWS on any failure (the
   * caller decides: the settle's savepoint catches; the repair CLI reports). It does not check test
   * mode or an existing invoice — both callers do that first.
   */
  async issueWithinTx(tx: Database, order: PaymentOrder, ctx: IssueContext): Promise<string> {
    const amounts = invoiceAmountsOf(order);
    if (amounts === null) throw new PriceLineMissingError("the order has no paise price line");
    const usable = usableSeller(await this.repo.activeSeller(tx));
    if (!usable.ok) throw new SellerNotConfiguredError(usable.reason);
    const seller = usable.seller;

    const billing = await this.repo.billingDetails(order.payerId, tx);
    const placeOfSupply = billing?.stateCode ?? seller.stateCode;
    const supplyType = supplyTypeFor(seller.stateCode, placeOfSupply);
    const split = splitGstForSupply(amounts.gstPaise, supplyType);

    // The number, its instant and its year, from the database clock under the series row lock.
    const taken = await this.repo.nextNumber(tx, "invoice");
    const invoiceNumber = formatDocumentNumber(seller.invoicePrefix, taken.financialYear, taken.serial);
    const isTest = await this.repo.isTestPayer(tx, order.payerId);

    const row = await this.repo.insertInvoice(tx, {
      paymentOrderId: order.id,
      payerId: order.payerId,
      invoiceNumber,
      financialYear: taken.financialYear,
      issuedAt: taken.issuedAt,
      ...sellerSnapshot(seller),
      buyerStateCode: placeOfSupply,
      buyerGstinEnc: billing?.gstinEnc ?? null,
      buyerLegalNameEnc: billing?.legalNameEnc ?? null,
      buyerAddressEnc: billing?.addressEnc ?? null,
      supplyType,
      description: invoiceDescription(order),
      taxablePaise: amounts.taxablePaise,
      cgstPaise: split.cgstPaise,
      sgstPaise: split.sgstPaise,
      igstPaise: split.igstPaise,
      totalPaise: amounts.totalPaise,
      gstRateBps: amounts.gstRateBps,
      isTest,
    });

    await this.events.emit({
      event_name: "invoice.issued",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "payer", subject_id: order.payerId },
      payload: {
        invoice_id: row.id,
        payment_order_id: order.id,
        payer_id: order.payerId,
        financial_year: taken.financialYear,
        supply_type: supplyType,
        total_paise: row.totalPaise,
        is_test: isTest,
      },
      idempotencyKey: `invoice.issued:order:${order.id}`,
      correlationId: ctx.correlationId,
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      tx,
    });
    return row.id;
  }

  /**
   * `payment.invoice_not_issued`, on the settle's transaction, in a savepoint of its own: if even
   * this cannot be written (the events table is failing), it is logged and the settle still
   * commits its credits.
   */
  private async recordNotIssued(
    tx: Database,
    order: PaymentOrder,
    reason: InvoiceNotIssuedReason,
    ctx: IssueContext,
  ): Promise<void> {
    try {
      await tx.transaction(async (sp) => {
        await this.events.emit({
          event_name: "payment.invoice_not_issued",
          actor: { actor_type: "system", actor_id: null },
          subject: { subject_type: "payer", subject_id: order.payerId },
          payload: { payment_order_id: order.id, payer_id: order.payerId, reason },
          idempotencyKey: `payment.invoice_not_issued:order:${order.id}`,
          correlationId: ctx.correlationId,
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          tx: sp as unknown as Database,
        });
      });
    } catch (err) {
      this.logger.error(
        `payment.invoice_not_issued could not be recorded order_row=${order.id} error=${errorClass(err)}`,
      );
    }
  }
}

/** The seller columns an invoice snapshots. */
export function sellerSnapshot(seller: SellerTaxConfigRow): {
  sellerLegalName: string;
  sellerGstin: string;
  sellerPan: string;
  sellerStateCode: string;
  sellerAddress: string;
  sacCode: string;
} {
  return {
    sellerLegalName: seller.legalName,
    sellerGstin: seller.gstin,
    sellerPan: seller.pan,
    sellerStateCode: seller.stateCode,
    sellerAddress: seller.address,
    sacCode: seller.sacCode,
  };
}

function reasonOf(err: unknown): InvoiceNotIssuedReason {
  if (err instanceof SellerNotConfiguredError) return err.reason;
  if (err instanceof PriceLineMissingError) return "price_line_missing";
  return "issue_failed";
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}
