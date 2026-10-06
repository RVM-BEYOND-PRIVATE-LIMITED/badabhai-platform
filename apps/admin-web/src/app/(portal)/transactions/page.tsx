import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { getFinanceSummary, listOrders } from "../../../lib/entities";
import {
  formatCount,
  formatRelative,
  formatRupees,
  formatTimestamp,
  packCodeLabel,
  shortId,
} from "../../../lib/format";
import { PaymentsPostureBanner, MockMoneyTag } from "../../../components/payments-posture";
import { StatusPill } from "../../../components/status-pill";
import { Pager } from "../../../components/pager";
import { Stat } from "../../../components/stat";
import { PageHeader } from "../../../components/page-header";
import { RetryActions } from "../../../components/retry-actions";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payment orders" };

const STATUSES = ["created", "paid", "failed"] as const;

/**
 * Payment orders — credit-pack checkouts.
 *
 * ── WHAT AN ORDER IS, AND IS NOT ────────────────────────────────────────────────────────
 * A `created` order is a checkout that STARTED. It is not revenue, not a pending payment,
 * and not a promise — most of them are abandoned tabs. It is shown in its own column and
 * never folded into a settled total, because "₹12,000 in orders" and "₹12,000 received" are
 * different claims and only one of them is true.
 *
 * `amount_inr` and `credits_granted` were both stamped at order creation, so a later ops
 * re-price cannot retroactively change what a past order appears to have cost or bought.
 * That is why this page renders the stored values rather than re-resolving the catalog.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const status = one(sp.status);
  const payerId = one(sp.payerId);
  const cursor = one(sp.cursor);

  const [summaryRes, ordersRes] = await Promise.allSettled([
    getFinanceSummary({ windowDays: 30 }),
    listOrders({ status, payerId, cursor, limit: 25 }),
  ]);
  const summary = summaryRes.status === "fulfilled" ? summaryRes.value : null;
  const orders = ordersRes.status === "fulfilled" ? ordersRes.value : null;
  const posture = orders?.payments ?? summary?.payments ?? null;

  // Pack purchases as the LEDGER saw them. While payments are mocked this is the only place
  // a sale is recorded — see the note above the stats block.
  const mockPurchases = summary?.by_reason.find((b) => b.reason === "pack_purchase") ?? null;

  const filtered = Boolean(status || payerId);

  /**
   * The CURRENT query without its cursor — where "Back to the first page" lands. RetryActions
   * puts the cursor back for "Retry", so an operator three pages into the orders who hits a
   * transient failure lands back on the page they were reading, not on page one.
   */
  const queryHref = (() => {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (payerId) qs.set("payerId", payerId);
    const q = qs.toString();
    return q ? `/transactions?${q}` : "/transactions";
  })();

  return (
    <div className="page">
      <PageHeader
        title="Payment orders"
        description="Credit-pack checkouts, with amounts and credits stamped at order creation so a later price change never rewrites a past order."
      />

      {posture && <PaymentsPostureBanner posture={posture} />}

      {/*
       * ── WHY THE LEDGER APPEARS ON THE ORDERS PAGE ──────────────────────────────────
       * `payment_orders` rows are created ONLY by the real-payments stream. The mock
       * purchase path writes the credit ledger directly and creates no order — so while
       * payments are mocked, this table is empty EVEN WHEN packs are being bought.
       *
       * Found by running it: two real mock purchases totalling ₹3,000 sat in the ledger
       * while this page said "no payment orders recorded yet". An operator would read that
       * as "no sales". Surfacing the ledger-side purchase figure is what makes the page
       * honest rather than merely accurate.
       */}
      {summary && (
        <section aria-labelledby="tx-stats">
          <h2 className="sr-only" id="tx-stats">
            Order outcomes, last {summary.window_days} days
          </h2>
          <div className="stats">
            {mockPurchases && summary.payments.mode === "mock" ? (
              <Stat
                label={`Pack purchases via the mock path (${formatCount(mockPurchases.movements)}) — recorded in the credit ledger, not as orders`}
                value={formatRupees(mockPurchases.amount_inr)}
                adornment={<MockMoneyTag posture={summary.payments} />}
                tone="warn"
                wide
              />
            ) : (
              <Stat
                label={`Settled (${formatCount(summary.paid_orders.count)} orders)`}
                value={formatRupees(summary.paid_orders.amount_inr)}
                adornment={<MockMoneyTag posture={summary.payments} />}
                wide
              />
            )}
            <Stat
              label="Credits sold"
              value={formatCount(
                summary.payments.mode === "mock" && mockPurchases
                  ? mockPurchases.credits_delta
                  : summary.paid_orders.credits,
              )}
            />
            <Stat
              label="Unsettled orders — started, never completed. Not revenue."
              value={formatCount(summary.unsettled_orders.count)}
              tone={summary.unsettled_orders.count > 0 ? "warn" : undefined}
            />
            <Stat
              label="Failed orders"
              value={formatCount(summary.failed_orders.count)}
              tone={summary.failed_orders.count > 0 ? "warn" : undefined}
            />
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="tx-list" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="tx-list">
              Orders
            </h2>
            <p className="panel__sub">
              {orders ? `${orders.items.length} order${orders.items.length === 1 ? "" : "s"} on this page.` : "—"}
            </p>
          </div>
          {filtered && (
            <Link className="btn btn--ghost" href="/transactions">
              <Icon name={ACTION_ICON.clearFilters} />
              Clear filters
            </Link>
          )}
        </div>

        <div className="filters filters--inline">
          {STATUSES.map((s) => (
            <Link
              aria-current={s === status ? "true" : undefined}
              className={`btn btn--sm ${s === status ? "btn--primary" : "btn--ghost"}`}
              /* Keeps an account narrowing (`?payerId=`); a chip used to drop it. */
              href={`/transactions?status=${s}${payerId ? `&payerId=${encodeURIComponent(payerId)}` : ""}`}
              key={s}
            >
              {s === "created" ? "Unsettled" : s === "paid" ? "Settled" : "Failed"}
            </Link>
          ))}
        </div>

        {orders === null ? (
          <div className="state state--error">
            <h3 className="state__title">Payment orders are unavailable</h3>
            <p className="state__body">
              The order list did not load. The figures above are a separate read and are
              unaffected.
            </p>
            {/* Repeat the SAME query. Pointing this at the bare route (which is what "Clear
                filters" does) silently dropped status / payerId / cursor, so a transient failure
                quietly returned the operator to an unfiltered page one while claiming to retry. */}
            <RetryActions href={queryHref} cursor={cursor} />
          </div>
        ) : orders.items.length === 0 ? (
          filtered ? (
            <div className="state">
              <h3 className="state__title">No orders match these filters</h3>
              <p className="state__body">
                Nothing matches the filters currently applied. Clear them to see every
                order, newest first.
              </p>
            </div>
          ) : posture?.mode === "mock" ? (
            // The honest empty state. "No payment orders recorded yet" is TRUE and
            // MISLEADING: it reads as "no sales" when packs are being bought through the
            // mock path, which writes the ledger and creates no order row. The recovery
            // action is therefore the ledger, not a retry — there is nothing to retry.
            <div className="state">
              <h3 className="state__title">
                No payment orders exist — and none can, while real payments are switched off
              </h3>
              <p className="state__body">
                Order rows are created only by the payment provider&apos;s checkout. Pack
                purchases made through the mock path are recorded in the credit ledger
                instead
                {mockPurchases && mockPurchases.movements > 0
                  ? ` — ${formatCount(mockPurchases.movements)} of them in the last ${summary?.window_days ?? 30} days.`
                  : "."}
              </p>
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/credits?reason=pack_purchase">
                  <Icon name={ACTION_ICON.credits} />
                  Open the credit ledger
                </Link>
              </div>
            </div>
          ) : (
            <div className="state">
              <h3 className="state__title">No payment orders recorded yet</h3>
              {/* Deliberately not "real payments are on": this branch is also reached when
                  the posture itself is unknown, and asserting the mode would be a guess. */}
              <p className="state__body">
                No checkout has been started. An order row appears the moment a customer opens
                the pack checkout with the payment provider.
              </p>
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/credits">
                  <Icon name={ACTION_ICON.credits} />
                  Open the credit ledger
                </Link>
              </div>
            </div>
          )
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Payment orders, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Pack</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Credits</th>
                  <th scope="col">Status</th>
                  <th scope="col">Provider</th>
                </tr>
              </thead>
              <tbody>
                {orders.items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <time dateTime={o.created_at} title={formatTimestamp(o.created_at)}>
                        {formatRelative(o.created_at)}
                      </time>
                    </td>
                    <td>
                      <Link className="link mono" href={`/companies/${o.payer_id}`}>
                        {shortId(o.payer_id)}
                      </Link>
                    </td>
                    <td>{packCodeLabel(o.pack_code)}</td>
                    <td className="mono ui-num">{formatRupees(o.amount_inr)}</td>
                    <td className="mono ui-num">{formatCount(o.credits_granted)}</td>
                    <td>
                      {/* The pill shows the REAL order status. `created` is toned warn, not
                          neutral: an order stuck in checkout is a thing to look at, not a
                          resting state. Toned explicitly rather than by borrowing another
                          domain's value, which would have displayed "active" for a paid
                          order and "rejected" for a failed one. */}
                      <StatusPill
                        value={o.status}
                        label={
                          o.status === "created"
                            ? "unsettled"
                            : o.status === "paid"
                              ? "settled"
                              : "failed"
                        }
                        tone={o.status === "paid" ? "ok" : o.status === "created" ? "warn" : "bad"}
                        title={`order status: ${o.status}`}
                      />
                    </td>
                    <td className="table__meta">
                      {o.provider}
                      {posture?.mode === "mock" && " (mock)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pager
          basePath="/transactions"
          params={{ status, payerId }}
          nextCursor={orders?.nextCursor}
        />
      </section>
    </div>
  );
}
