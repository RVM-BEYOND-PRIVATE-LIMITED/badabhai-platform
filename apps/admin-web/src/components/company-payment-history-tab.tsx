import Link from "next/link";
import type { AdminPaymentHistory } from "../lib/payment-history";
import { describeHistorySimulated, formatHistoryAmount } from "../lib/payment-history";
import { formatCount, formatDelta, formatRupees, formatTimestamp, timestampTitle } from "../lib/format";
import { queryHref } from "../lib/query-href";
import { Pager } from "./pager";
import { StatusPill } from "./status-pill";
import { Stat } from "./stat";
import { CopyId } from "./copy-id";
import { ACTION_ICON, Icon } from "@badabhai/icons";

const TYPE_LABELS: Record<string, string> = {
  payment_order: "Payment order",
  credit_purchase: "Credit purchase",
  credit_grant: "Credit grant",
  credit_refund: "Credit refund",
  credit_spend: "Credit spend",
  posting_plan: "Posting plan",
  boost: "Boost",
  capacity_purchase: "Capacity purchase",
  quota_topup: "Quota top-up",
};

/**
 * The Payment history tab (A9, #2579; API #2565).
 *
 * Dates are IST, amounts are whole rupees from the API's own stamped values, and the totals are
 * the response's `totals` — never summed in the browser. Every row carries the API's `simulated`
 * flag while real payments are off, so a mock rupee cannot be read as a real one.
 */
export function CompanyPaymentHistoryTab({
  history,
  cursor,
  basePath,
}: {
  history: AdminPaymentHistory | null;
  cursor: string | undefined;
  basePath: string;
}) {
  const retryHref = queryHref(basePath, { tab: "payments" });
  if (history === null) {
    return (
      <div className="state state--error">
        <h3 className="state__title">Payment history could not be loaded</h3>
        <p className="state__body">
          The company record loaded, but the payment timeline did not — so this table is missing,
          not empty. No total on this tab is guessed.
        </p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href={retryHref}>
            <Icon name={ACTION_ICON.retry} />
            Retry
          </Link>
        </div>
      </div>
    );
  }

  const totals = history.totals;
  return (
    <div className="company-payments">
      <div className="panel__head">
        <h2 className="panel__title">Payment history</h2>
        <p className="panel__sub">
          {history.payments.mode === "mock"
            ? "Real payments are off on this deployment — every amount below is simulated."
            : "One company's orders, purchases, plans, boosts, capacity and top-ups, newest first."}
        </p>
      </div>

      <div className="stats stats--compact" aria-label="Payment totals">
        <Stat
          label="₹ spent"
          value={formatRupees(totals.inr_spent)}
          wide
          countUp={{ to: totals.inr_spent, kind: "rupees" }}
        />
        <Stat
          label="Credits bought"
          value={formatCount(totals.credits_bought)}
          countUp={{ to: totals.credits_bought, kind: "count" }}
        />
        <Stat
          label="Credits used"
          value={formatCount(totals.credits_used)}
          countUp={{ to: totals.credits_used, kind: "count" }}
        />
        <Stat
          label="Live balance"
          value={formatCount(totals.balance)}
          countUp={{ to: totals.balance, kind: "count" }}
        />
      </div>

      {history.items.length === 0 ? (
        <div className="state">
          <h3 className="state__title">No payments recorded yet</h3>
          <p className="state__body">
            This company has no orders, purchases or credit movements. A company can be perfectly
            active on a free path; the absence of money here is not an error.
          </p>
        </div>
      ) : (
        <>
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Payment history, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Date (IST)</th>
                  <th scope="col">Type</th>
                  <th scope="col">Item</th>
                  <th scope="col">Credits</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">Provider reference</th>
                </tr>
              </thead>
              <tbody>
                {history.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <time dateTime={item.date} title={timestampTitle(item.date)}>
                        {formatTimestamp(item.date)}
                      </time>
                    </td>
                    <td>
                      {TYPE_LABELS[item.type] ?? item.type.replace(/_/g, " ")}
                      {item.simulated ? (
                        <span className="tag" title={describeHistorySimulated(true)}>
                          Simulated
                        </span>
                      ) : null}
                    </td>
                    <td>{item.item}</td>
                    <td className="ui-num">
                      {item.credits === null ? "—" : formatDelta(item.credits)}
                    </td>
                    <td className="ui-num">{formatHistoryAmount(item.amount_inr)}</td>
                    <td>
                      <StatusPill value={item.status} />
                    </td>
                    <td>
                      {item.provider_reference ? (
                        <>
                          <span className="mono" title={item.provider_reference}>
                            {item.provider_reference}
                          </span>
                          <CopyId id={item.provider_reference} label="provider reference" />
                        </>
                      ) : (
                        <span className="table__meta">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            basePath={basePath}
            params={{ tab: "payments" }}
            cursor={cursor}
            nextCursor={history.nextCursor}
            note="The payment timeline is keyset-paged, so no movement can skip or repeat between pages."
          />
        </>
      )}
    </div>
  );
}
