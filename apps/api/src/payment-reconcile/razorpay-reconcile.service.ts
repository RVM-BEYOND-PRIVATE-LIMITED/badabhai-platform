import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { isRazorpayTestKey } from "../invoices/test-mode";
import {
  RAZORPAY_CAPTURED_STATUS,
  RAZORPAY_CURRENCY,
  RazorpayClient,
  capturedStatusLabel,
  type FetchedPayment,
} from "../unlocks/razorpay.client";
import {
  RazorpayReconcileRepository,
  type ReconcileOrder,
  type ReconcileOrdersSnapshot,
} from "./razorpay-reconcile.repository";

/** How far back each run looks. Twice the tick, so a day missed or a late webhook is still read. */
export const RECONCILE_WINDOW_HOURS = 48;
/**
 * The newest half hour is left for the next run: a payment captured a minute ago may still be
 * settling (webhook in flight), and a `to` in the past keeps Razorpay's newest-first list still.
 */
export const RECONCILE_SETTLE_GRACE_MINUTES = 30;
/** At most this many pages of 100 payments per run (5,000); more is logged as truncated. */
export const RECONCILE_MAX_PAGES = 50;
/** At most this many single-payment reads per run, for paid orders the list did not show. */
export const RECONCILE_MAX_FETCHES = 50;
/** At most this many findings per class go into the log line (the counts are always whole). */
export const RECONCILE_LOG_IDS_PER_CLASS = 50;

/**
 * The four ways Razorpay and our books can disagree:
 *  - `captured_not_paid` (a): Razorpay captured the money, our order is not `paid` on that payment
 *    (`created`, `failed`, `held`, or paid by a different payment): the company paid, no credits.
 *  - `paid_not_captured` (b): our order is `paid`, Razorpay holds no captured payment for it (and
 *    no refund our refund path made).
 *  - `amount_mismatch` (c): the order is paid on the payment, but the amounts or currency differ.
 *  - `captured_unknown_order`: a captured payment on a Razorpay order we have no row for.
 */
export type ReconcileFindingKind =
  | "captured_not_paid"
  | "paid_not_captured"
  | "amount_mismatch"
  | "captured_unknown_order";

/** One disagreement, with the opaque ids whoever repairs it needs. No buyer data. */
export interface ReconcileFinding {
  readonly kind: ReconcileFindingKind;
  /** Our `payment_orders.id`, or null when we hold no order. */
  readonly orderId: string | null;
  /** Razorpay's `order_*`, or null when the payment names none. */
  readonly providerOrderId: string | null;
  /** Razorpay's `pay_*`, or null when the order names none. */
  readonly paymentId: string | null;
  /** A short closed-vocabulary reason (no free text from the provider). */
  readonly reason: string;
}

/** What the comparison found. */
export interface ReconcileSummary {
  /** Captured payments in the window. */
  readonly paymentsChecked: number;
  /** Our paid orders created in the window. */
  readonly ordersChecked: number;
  readonly findings: readonly ReconcileFinding[];
  /** Paid orders whose payment could not be read this run (the fetch cap). Not findings. */
  readonly unverified: number;
}

/** What one tick did. Counts only (BullMQ job-inspection surface). */
export type RazorpayReconcileResult =
  | { readonly armed: false }
  | { readonly armed: true; readonly skipped: "test_mode" | "not_live" }
  | {
      readonly armed: true;
      readonly paymentsChecked: number;
      readonly ordersChecked: number;
      readonly capturedNotPaid: number;
      readonly paidNotCaptured: number;
      readonly amountMismatches: number;
      readonly capturedUnknownOrder: number;
      readonly unverified: number;
      readonly truncated: boolean;
      /** True when this run wrote today's alert (false when clean, or already raised today). */
      readonly alerted: boolean;
    };

/** The run's window: `[now − 48 h, now − 30 min)`. */
export function reconcileWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - RECONCILE_WINDOW_HOURS * 60 * 60 * 1000),
    to: new Date(now.getTime() - RECONCILE_SETTLE_GRACE_MINUTES * 60 * 1000),
  };
}

function isCaptured(p: FetchedPayment): boolean {
  return p.status === RAZORPAY_CAPTURED_STATUS;
}

/** Captured exactly what the order asked for, in rupees. */
function amountMatches(p: FetchedPayment, o: ReconcileOrder): boolean {
  return p.amountPaise === o.expectedPaise && p.currency === RAZORPAY_CURRENCY;
}

function amountReason(p: FetchedPayment, o: ReconcileOrder): string {
  return p.currency === RAZORPAY_CURRENCY
    ? `captured_${p.amountPaise}_expected_${o.expectedPaise}`
    : "currency_not_inr";
}

/** A listed captured payment that settled its own paid order: the comparison already read it. */
function settledFromList(p: FetchedPayment | undefined, o: ReconcileOrder): boolean {
  return p !== undefined && isCaptured(p) && p.orderId === o.providerOrderId;
}

/**
 * The payment ids of paid orders that the window's list does not hold at all, which the run reads
 * one by one (a payment made just before the window, or one past a page that moved).
 */
export function paymentIdsToFetch(
  listed: readonly FetchedPayment[],
  paidInWindow: readonly ReconcileOrder[],
): string[] {
  const listedIds = new Set(listed.map((p) => p.id));
  const ids = new Set<string>();
  for (const o of paidInWindow) {
    if (o.providerPaymentRef === null || listedIds.has(o.providerPaymentRef)) continue;
    ids.add(o.providerPaymentRef);
  }
  return [...ids];
}

/**
 * #2773 — THE COMPARISON. Pure: the window's Razorpay payments, our orders, and the payments read
 * one by one (`null` = the read failed, absent = not read) in; the findings out.
 *
 * Side one, every CAPTURED payment that names a Razorpay order: our order must exist, be `paid`,
 * name this payment, and match its amount. Payments with no Razorpay order were not made through
 * our checkout (every checkout creates an order) and are not compared.
 *
 * Side two, every order of ours `paid` in the window: its payment must be captured on its order
 * (else the amount check above, or here when read one by one), or refunded by our refund path.
 */
export function reconcile(input: {
  listed: readonly FetchedPayment[];
  orders: ReconcileOrdersSnapshot;
  fetched: ReadonlyMap<string, FetchedPayment | null>;
}): ReconcileSummary {
  const findings: ReconcileFinding[] = [];
  const listedById = new Map(input.listed.map((p) => [p.id, p]));
  const orderByProviderId = new Map(
    input.orders.byProviderOrderId.map((o) => [o.providerOrderId, o]),
  );
  const captured = input.listed.filter(isCaptured);

  for (const p of captured) {
    if (p.orderId === null) continue;
    const o = orderByProviderId.get(p.orderId);
    const ids = { providerOrderId: p.orderId, paymentId: p.id };
    if (!o) {
      findings.push({ kind: "captured_unknown_order", orderId: null, ...ids, reason: "no_order" });
    } else if (o.status !== "paid") {
      findings.push({
        kind: "captured_not_paid",
        orderId: o.orderId,
        ...ids,
        reason: `order_${o.status}`,
      });
    } else if (o.providerPaymentRef !== p.id) {
      findings.push({
        kind: "captured_not_paid",
        orderId: o.orderId,
        ...ids,
        reason: "order_paid_by_other_payment",
      });
    } else if (!amountMatches(p, o)) {
      findings.push({
        kind: "amount_mismatch",
        orderId: o.orderId,
        ...ids,
        reason: amountReason(p, o),
      });
    }
  }

  let unverified = 0;
  for (const o of input.orders.paidInWindow) {
    const ref = o.providerPaymentRef;
    const ids = { orderId: o.orderId, providerOrderId: o.providerOrderId, paymentId: ref };
    if (ref === null) {
      findings.push({ kind: "paid_not_captured", ...ids, reason: "no_payment_ref" });
      continue;
    }
    const fromList = listedById.get(ref);
    if (settledFromList(fromList, o)) continue; // compared on side one
    const p = fromList ?? input.fetched.get(ref);
    if (p === undefined) {
      unverified++;
    } else if (p === null) {
      findings.push({ kind: "paid_not_captured", ...ids, reason: "payment_fetch_failed" });
    } else if (p.orderId !== o.providerOrderId) {
      findings.push({ kind: "paid_not_captured", ...ids, reason: "payment_on_other_order" });
    } else if (isCaptured(p)) {
      if (!amountMatches(p, o)) {
        findings.push({ kind: "amount_mismatch", ...ids, reason: amountReason(p, o) });
      }
    } else if (!(p.status === "refunded" && o.refundRecorded)) {
      findings.push({
        kind: "paid_not_captured",
        ...ids,
        reason: `payment_${capturedStatusLabel(p.status)}`,
      });
    }
  }

  return {
    paymentsChecked: captured.length,
    ordersChecked: input.orders.paidInWindow.length,
    findings,
    unverified,
  };
}

/** The alert's idempotency key: one alert per UTC day, however many ticks or replicas run. */
export function reconcileAlertKey(now: Date): string {
  return `payment.reconciliation_failed:${now.toISOString().slice(0, 10)}`;
}

/** The kinds, in the order the log line and the event name them. */
const KINDS: readonly ReconcileFindingKind[] = [
  "captured_not_paid",
  "paid_not_captured",
  "amount_mismatch",
  "captured_unknown_order",
];

/** One finding as the log shows it: our order, Razorpay's order, the payment, the reason. */
function describeFinding(f: ReconcileFinding): string {
  return `order=${f.orderId ?? "-"} rzp_order=${f.providerOrderId ?? "-"} payment=${
    f.paymentId ?? "-"
  } reason=${f.reason}`;
}

/**
 * #2773 — THE NIGHTLY RAZORPAY RECONCILIATION.
 *
 * Lists every payment Razorpay created in the last 48 hours (less the newest half hour), reads
 * our matching `payment_orders` in one read-only snapshot, and compares them ({@link reconcile}).
 * A clean run logs one line and emits nothing. A run with findings:
 *  - logs ONE error line with the counts and, per finding, our order id, Razorpay's order and
 *    payment ids and a closed reason (at most {@link RECONCILE_LOG_IDS_PER_CLASS} per class);
 *  - emits ONE `payment.reconciliation_failed` (counts only), keyed per day so a duplicated tick
 *    or a second replica raises it once. The admin dashboard's breach counter shows it.
 *
 * IT NEVER CHANGES MONEY: no order, wallet or refund is written, and the only provider calls are
 * reads. Whoever repairs a finding decides what is right.
 *
 * TEST KEYS ARE SKIPPED: with a `rzp_test_` key id (the invoice code's rule) no money moves, so
 * the run returns without a call. OFF BY DEFAULT (`RAZORPAY_RECONCILE_ENABLED`): a tick returns
 * at once without a call or a query.
 */
@Injectable()
export class RazorpayReconcileService {
  private readonly logger = new Logger(RazorpayReconcileService.name);

  constructor(
    private readonly repo: RazorpayReconcileRepository,
    private readonly razorpay: RazorpayClient,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async run(now: Date): Promise<RazorpayReconcileResult> {
    if (!this.config.RAZORPAY_RECONCILE_ENABLED) return { armed: false };
    if (isRazorpayTestKey(this.config.PAYMENTS_PROVIDER_KEY)) {
      this.logger.log("razorpay reconciliation: skipped, test-mode key (no real money moves)");
      return { armed: true, skipped: "test_mode" };
    }
    if (!this.razorpay.isLive) {
      this.logger.log("razorpay reconciliation: skipped, real payments are not configured");
      return { armed: true, skipped: "not_live" };
    }

    const { from, to } = reconcileWindow(now);
    const list = await this.razorpay.listPayments({ from, to, maxPages: RECONCILE_MAX_PAGES });
    if (list.truncated) {
      this.logger.warn(
        `razorpay reconciliation: the payment list stopped at ${RECONCILE_MAX_PAGES} pages; ` +
          `older payments in the window were not compared`,
      );
    }
    const providerOrderIds = [
      ...new Set(
        list.payments.filter(isCaptured).flatMap((p) => (p.orderId === null ? [] : [p.orderId])),
      ),
    ];
    const orders = await this.repo.read({ providerOrderIds, from, to });

    const fetched = new Map<string, FetchedPayment | null>();
    for (const id of paymentIdsToFetch(list.payments, orders.paidInWindow).slice(
      0,
      RECONCILE_MAX_FETCHES,
    )) {
      try {
        fetched.set(id, await this.razorpay.fetchPayment(id));
      } catch {
        fetched.set(id, null); // the client logged the error class
      }
    }

    const s = reconcile({ listed: list.payments, orders, fetched });
    const count = (k: ReconcileFindingKind) => s.findings.filter((f) => f.kind === k).length;
    const counts = {
      armed: true as const,
      paymentsChecked: s.paymentsChecked,
      ordersChecked: s.ordersChecked,
      capturedNotPaid: count("captured_not_paid"),
      paidNotCaptured: count("paid_not_captured"),
      amountMismatches: count("amount_mismatch"),
      capturedUnknownOrder: count("captured_unknown_order"),
      unverified: s.unverified,
      truncated: list.truncated,
    };
    if (s.unverified > 0) {
      this.logger.warn(
        `razorpay reconciliation: ${s.unverified} paid order(s) not verified this run ` +
          `(more than ${RECONCILE_MAX_FETCHES} single-payment reads); the next run reads them`,
      );
    }
    if (s.findings.length === 0) {
      this.logger.log(
        `razorpay reconciliation: clean (payments_checked=${s.paymentsChecked} ` +
          `orders_checked=${s.ordersChecked})`,
      );
      return { ...counts, alerted: false };
    }

    const lists = KINDS.map((k) => {
      const all = s.findings.filter((f) => f.kind === k);
      const shown = all.slice(0, RECONCILE_LOG_IDS_PER_CLASS).map(describeFinding);
      const more = all.length - shown.length;
      return `${k}=[${shown.join("; ")}]${more > 0 ? ` (+${more} more)` : ""}`;
    });
    this.logger.error(
      `razorpay reconciliation FAILED: payments_checked=${s.paymentsChecked} ` +
        `orders_checked=${s.ordersChecked} captured_not_paid=${counts.capturedNotPaid} ` +
        `paid_not_captured=${counts.paidNotCaptured} amount_mismatches=${counts.amountMismatches} ` +
        `captured_unknown_order=${counts.capturedUnknownOrder}; nothing was changed. ` +
        lists.join(" "),
    );
    const { written } = await this.events.emitOnce({
      event_name: "payment.reconciliation_failed",
      actor: { actor_type: "system" },
      subject: { subject_type: "payer", subject_id: null },
      payload: {
        window_hours: RECONCILE_WINDOW_HOURS,
        payments_checked: s.paymentsChecked,
        orders_checked: s.ordersChecked,
        captured_not_paid: counts.capturedNotPaid,
        paid_not_captured: counts.paidNotCaptured,
        amount_mismatches: counts.amountMismatches,
        captured_unknown_order: counts.capturedUnknownOrder,
      },
      idempotencyKey: reconcileAlertKey(now),
    });
    return { ...counts, alerted: written };
  }
}
