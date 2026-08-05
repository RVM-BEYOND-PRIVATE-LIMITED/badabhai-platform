import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { getFinanceSummary, listOrders } from "../../../lib/entities";
import {
  formatCount,
  formatRelative,
  formatRupees,
  formatTimestamp,
  shortId,
} from "../../../lib/format";
import { PaymentsPostureBanner, MockMoneyTag } from "../../../components/payments-posture";
import { StatusPill } from "../../../components/status-pill";
import { Pager } from "../../../components/pager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Transactions" };

const STATUSES = ["created", "paid", "failed"] as const;

/**
 * Transactions — credit-pack payment orders.
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

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Transactions</h1>
          <p className="page__sub">
            Credit-pack payment orders. Amounts and credits are stamped at order creation, so
            a later price change never rewrites a past order.
          </p>
        </div>
      </header>

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
              <div className="stat stat--warn">
                <span className="stat__value">
                  {formatRupees(mockPurchases.amount_inr)}{" "}
                  <MockMoneyTag posture={summary.payments} />
                </span>
                <span className="stat__label">
                  Pack purchases via the mock path ({formatCount(mockPurchases.movements)}) —
                  recorded in the credit ledger, not as orders
                </span>
              </div>
            ) : (
              <div className="stat">
                <span className="stat__value">
                  {formatRupees(summary.paid_orders.amount_inr)}{" "}
                  <MockMoneyTag posture={summary.payments} />
                </span>
                <span className="stat__label">
                  Settled ({formatCount(summary.paid_orders.count)} orders)
                </span>
              </div>
            )}
            <div className="stat">
              <span className="stat__value">
                {formatCount(
                  summary.payments.mode === "mock" && mockPurchases
                    ? mockPurchases.credits_delta
                    : summary.paid_orders.credits,
                )}
              </span>
              <span className="stat__label">Credits sold</span>
            </div>
            <div className={`stat${summary.unsettled_orders.count > 0 ? " stat--warn" : ""}`}>
              <span className="stat__value">{formatCount(summary.unsettled_orders.count)}</span>
              <span className="stat__label">
                Unsettled orders — started, never completed. Not revenue.
              </span>
            </div>
            <div className={`stat${summary.failed_orders.count > 0 ? " stat--warn" : ""}`}>
              <span className="stat__value">{formatCount(summary.failed_orders.count)}</span>
              <span className="stat__label">Failed orders</span>
            </div>
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
              Clear filters
            </Link>
          )}
        </div>

        <div className="filters filters--inline">
          {STATUSES.map((s) => (
            <Link
              className={`btn btn--sm ${s === status ? "btn--primary" : "btn--ghost"}`}
              href={`/transactions?status=${s}`}
              key={s}
            >
              {s === "created" ? "Unsettled" : s === "paid" ? "Settled" : "Failed"}
            </Link>
          ))}
        </div>

        {orders === null ? (
          <p className="empty">Payment orders are unavailable right now.</p>
        ) : orders.items.length === 0 ? (
          filtered ? (
            <p className="empty">No orders match these filters.</p>
          ) : posture?.mode === "mock" ? (
            // The honest empty state. "No payment orders recorded yet" is TRUE and
            // MISLEADING: it reads as "no sales" when packs are being bought through the
            // mock path, which writes the ledger and creates no order row.
            <p className="empty">
              No payment orders exist — and none can, while real payments are switched off.
              Order rows are created only by the payment provider&apos;s checkout. Pack
              purchases made through the mock path are recorded in the{" "}
              <Link className="link" href="/credits?reason=pack_purchase">
                credit ledger
              </Link>{" "}
              instead
              {mockPurchases && mockPurchases.movements > 0
                ? ` — ${formatCount(mockPurchases.movements)} of them in the last ${summary?.window_days ?? 30} days.`
                : "."}
            </p>
          ) : (
            <p className="empty">No payment orders recorded yet.</p>
          )
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Payment orders, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Account</th>
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
                    <td>{o.pack_code}</td>
                    <td className="mono">{formatRupees(o.amount_inr)}</td>
                    <td className="mono">{formatCount(o.credits_granted)}</td>
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
