import type { PaymentOrder } from "@badabhai/db";
import { isRealPaidOrder } from "./invoice-issuer.service";

/**
 * #2749 part 4 — issue the GST invoice of ONE captured payment that has none (a settle that recorded
 * `payment.invoice_not_issued`: no seller row yet, a mistyped seller GSTIN, a failure). PURE
 * decision + I/O through `deps`, so the refusals are tested without a database.
 *
 * REFUSES (writes nothing) when:
 *  - `order_not_found`: no such payment order;
 *  - `not_real_paid_order`: not a Razorpay order in `paid` with the provider's payment id (a
 *    created, failed or held order took no money that settled);
 *  - `already_invoiced`: the order has an invoice (one per order, ever);
 *  - `mode_unknown`: the Razorpay key id the api runs with was not given (`PAYMENTS_PROVIDER_KEY`),
 *    so a test-mode order cannot be told from a live one — fails closed;
 *  - `test_mode`: that key id is a `rzp_test_` key (a rehearsal payment: no invoice, ever);
 *  - `seller_not_configured` / `seller_config_invalid`: no usable seller row to issue under.
 *
 * DRY RUN BY DEFAULT: `would_issue` says the order passes every check. `apply` issues it through
 * the same `InvoiceIssuer` the settle uses, in its own transaction, with the number, the date and
 * the financial year taken NOW (the database clock under the series row lock). Never hand-edit
 * `invoice_number_series`: this is the only repair.
 */
export type IssueMissingInvoiceRefusal =
  | "order_not_found"
  | "not_real_paid_order"
  | "already_invoiced"
  | "mode_unknown"
  | "test_mode"
  | "seller_not_configured"
  | "seller_config_invalid";

export type IssueMissingInvoiceResult =
  | { outcome: "refused"; reason: IssueMissingInvoiceRefusal }
  | { outcome: "would_issue" }
  | { outcome: "issued"; invoiceId: string };

export interface IssueMissingInvoiceDeps {
  findOrder: (orderId: string) => Promise<PaymentOrder | undefined>;
  hasInvoice: (orderId: string) => Promise<boolean>;
  /** The seller row check the issuer applies (`usableSeller`). */
  sellerCheck: () => Promise<"ok" | "seller_not_configured" | "seller_config_invalid">;
  /** Issues the invoice in its own transaction; throws on any failure. */
  issue: (order: PaymentOrder) => Promise<string>;
}

export async function issueMissingInvoice(
  deps: IssueMissingInvoiceDeps,
  input: { orderId: string; apply: boolean; testMode: boolean | null },
): Promise<IssueMissingInvoiceResult> {
  const order = await deps.findOrder(input.orderId);
  if (!order) return { outcome: "refused", reason: "order_not_found" };
  if (!isRealPaidOrder(order)) return { outcome: "refused", reason: "not_real_paid_order" };
  if (await deps.hasInvoice(order.id)) return { outcome: "refused", reason: "already_invoiced" };
  if (input.testMode === null) return { outcome: "refused", reason: "mode_unknown" };
  if (input.testMode) return { outcome: "refused", reason: "test_mode" };
  const seller = await deps.sellerCheck();
  if (seller !== "ok") return { outcome: "refused", reason: seller };
  if (!input.apply) return { outcome: "would_issue" };
  return { outcome: "issued", invoiceId: await deps.issue(order) };
}
