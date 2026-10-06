import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { getFinanceSummary, listLedger } from "../../../lib/entities";
import {
  creditReasonLabel,
  formatCount,
  formatDelta,
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
import { filterChipClass } from "../../../components/filter-chip";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Credits" };

const WINDOWS = [7, 30, 90];

/**
 * Credits — the platform's credit position and the movements behind it.
 *
 * Credits are REAL platform state: a balance genuinely entitles a payer to unlock contacts.
 * The ₹ amounts attached to them are not, while payments are mocked — hence the banner, and
 * the `simulated` tag on every rupee tile, which travels with a screenshot in a way a
 * page-top banner does not.
 *
 * The two are shown together deliberately: the balance is a MATERIALIZATION of the ledger,
 * and an operator asking "why is this number wrong" needs both sides to see a divergence.
 */
export default async function CreditsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const windowDays = WINDOWS.includes(Number(one(sp.windowDays))) ? Number(one(sp.windowDays)) : 30;
  const cursor = one(sp.cursor);
  const reason = one(sp.reason);

  /**
   * The CURRENT query, rebuilt — so a "Retry" repeats what failed instead of resetting it.
   * The two retry links below pointed at `/credits?windowDays=N`, which silently dropped
   * `reason` and `cursor`: an operator filtered to a reason and three pages into the ledger
   * was returned, unannounced, to an unfiltered page one that looked like a successful
   * reload. `cursor` is included deliberately — retrying should land you where you were.
   */
  const queryHref = (() => {
    const qs = new URLSearchParams({ windowDays: String(windowDays) });
    if (reason) qs.set("reason", reason);
    return `/credits?${qs.toString()}`;
  })();
  const retryHref = cursor ? `${queryHref}&cursor=${encodeURIComponent(cursor)}` : queryHref;

  // Independent reads: a failing ledger must not blank the position, and vice versa.
  const [summaryRes, ledgerRes] = await Promise.allSettled([
    getFinanceSummary({ windowDays }),
    listLedger({ reason, cursor, limit: 25 }),
  ]);
  const summary = summaryRes.status === "fulfilled" ? summaryRes.value : null;
  const ledger = ledgerRes.status === "fulfilled" ? ledgerRes.value : null;

  // The posture comes from whichever response arrived. If NEITHER did, nothing below renders
  // a rupee, so there is no unlabelled money on the page.
  const posture = summary?.payments ?? ledger?.payments ?? null;

  /**
   * ONE LINK PER TARGET ON THE SCREEN. Both of these states can render at once — on a fresh
   * platform the balances AND the ledger are empty, and in an outage both reads fail — and each
   * used to carry its own copy of the same action.
   *  - The empty ledger owns "Open payment orders": a purchase is what fills it, so that is
   *    where the link answers the question. The empty balances state offers it only when the
   *    ledger is not showing it.
   *  - The ledger's failure owns "Retry": it is the paged list, and its Retry repeats this whole
   *    address, cursor included — which re-reads the summary too. The summary's failure offers
   *    its own Retry only when the ledger is not showing one.
   */
  const ledgerOffersOrders = ledger !== null && ledger.items.length === 0 && !reason;
  const ledgerOffersRetry = ledger === null;

  return (
    <div className="page">
      <PageHeader
        title="Credits"
        description="The platform's outstanding credit liability and every movement behind it."
        filters={
          /* The reporting window is a FILTER on the position below, not an action, so it sits
             in the filter row under the header rather than in the actions slot. */
          <nav className="filters--inline" aria-label="Reporting window">
            {WINDOWS.map((w) => (
              <Link
                aria-current={w === windowDays ? "true" : undefined}
                className={filterChipClass(w === windowDays, "md")}
                /* Keeps the ledger's reason filter; the two rows used to reset each other. */
                href={`/credits?windowDays=${w}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`}
                key={w}
              >
                <Icon name={ACTION_ICON.calendar} />
                {w}d
              </Link>
            ))}
          </nav>
        }
      />

      {posture && <PaymentsPostureBanner posture={posture} />}

      {summary ? (
        <>
          <section aria-labelledby="cr-position">
            <h2 className="sr-only" id="cr-position">
              Credit position
            </h2>
            <div className="stats">
              <Stat label="Credits outstanding" value={formatCount(summary.outstanding_credits)} />
              <Stat
                label="Customers holding credits"
                value={formatCount(summary.payers_with_balance)}
              />
              <Stat
                label={`Settled in ${summary.window_days}d (${formatCount(summary.paid_orders.count)} orders)`}
                value={formatRupees(summary.paid_orders.amount_inr)}
                adornment={<MockMoneyTag posture={summary.payments} />}
                wide
              />
              <Stat
                label="Unsettled orders — started, never completed"
                value={formatCount(summary.unsettled_orders.count)}
                tone={summary.unsettled_orders.count > 0 ? "warn" : undefined}
              />
            </div>
          </section>

          <div className="cols">
            <section className="panel" aria-labelledby="cr-reason">
              <div className="panel__head">
                <h2 className="panel__title" id="cr-reason">
                  Movement by reason
                </h2>
                <p className="panel__sub">
                  Net credit change over the last {summary.window_days} days.
                </p>
              </div>
              {summary.by_reason.length === 0 ? (
                <div className="state">
                  <h3 className="state__title">No credit movement in this window</h3>
                  <p className="state__body">
                    Nothing was granted, purchased, spent on an unlock or refunded in the
                    last {summary.window_days} days. A quiet window is a real answer — try a
                    longer one before treating it as a fault.
                  </p>
                  {windowDays !== 90 && (
                    <div className="state__actions">
                      <Link className="btn btn--ghost" href="/credits?windowDays=90">
                        <Icon name={ACTION_ICON.calendar} />
                        Widen to 90 days
                      </Link>
                    </div>
                  )}
                </div>
              ) : (
                <div className="tablewrap">
                  <table className="table">
                    <caption className="sr-only">Credit movement by reason</caption>
                    <thead>
                      <tr>
                        <th scope="col">Reason</th>
                        <th scope="col">Movements</th>
                        <th scope="col">Net credits</th>
                        <th scope="col">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.by_reason.map((b) => (
                        <tr key={b.reason}>
                          <td>{creditReasonLabel(b.reason)}</td>
                          <td className="ui-num">{formatCount(b.movements)}</td>
                          <td className="mono ui-num">{formatDelta(b.credits_delta)}</td>
                          <td className="table__meta ui-num">
                            {/* Only purchases carry a stamped price; a debit or a grant has
                                no rupee amount, and showing ₹0 would claim one. */}
                            {b.amount_inr > 0 ? formatRupees(b.amount_inr) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="panel" aria-labelledby="cr-holders">
              <div className="panel__head">
                <h2 className="panel__title" id="cr-holders">
                  Largest balances
                </h2>
                <p className="panel__sub">Who is holding the outstanding credits.</p>
              </div>
              {summary.top_balances.length === 0 ? (
                <div className="state">
                  <h3 className="state__title">No customer holds a credit balance yet</h3>
                  <p className="state__body">
                    Nothing has been granted or purchased, so no customer has credits to
                    spend on an unlock. The ledger below is the place to confirm that.
                  </p>
                  {ledgerOffersOrders ? null : (
                    <div className="state__actions">
                      <Link className="btn btn--ghost" href="/transactions">
                        <Icon name="receipt" />
                        Open payment orders
                      </Link>
                    </div>
                  )}
                </div>
              ) : (
                <div className="tablewrap">
                  <table className="table">
                    <caption className="sr-only">Largest credit balances</caption>
                    <thead>
                      <tr>
                        <th scope="col">Customer</th>
                        <th scope="col">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.top_balances.map((b) => (
                        <tr key={b.payer_id}>
                          <td>
                            <Link
                              className="link mono"
                              href={`/companies/${b.payer_id}`}
                              title={b.payer_id}
                            >
                              {shortId(b.payer_id)}
                            </Link>
                          </td>
                          <td className="mono ui-num">{formatCount(b.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </>
      ) : (
        // The summary and the ledger are read independently on purpose, so this failure
        // states its own scope: the ledger below may well still be rendering.
        <section className="panel" aria-labelledby="cr-position-error">
          <div className="panel__head">
            <h2 className="panel__title" id="cr-position-error">
              Credit position
            </h2>
          </div>
          <div className="state state--error">
            <h3 className="state__title">The credit position is unavailable</h3>
            <p className="state__body">
              {ledgerOffersRetry
                ? "The finance summary did not load, so the outstanding balance and the movement breakdown are missing. The credit ledger below did not load either; its Retry reads both again."
                : "The finance summary did not load, so the outstanding balance and the movement breakdown are missing. The credit ledger below is a separate read and is unaffected."}
            </p>
            {ledgerOffersRetry ? null : (
              <div className="state__actions">
                <Link className="btn btn--ghost" href={retryHref}>
                  <Icon name={ACTION_ICON.retry} />
                  Retry
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="cr-ledger" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="cr-ledger">
              Credit ledger
            </h2>
            <p className="panel__sub">
              Append-only. Every grant, purchase, unlock debit and refund, newest first.
            </p>
          </div>
          {reason && (
            /* Clears the ledger's reason and KEEPS the reporting window above — one filter, so it
               is named for it ("Clear filters" means every filter, the bare route). */
            <Link className="btn btn--ghost" href={`/credits?windowDays=${windowDays}`}>
              <Icon name={ACTION_ICON.clearFilters} />
              Clear the reason filter
            </Link>
          )}
        </div>

        <div className="filters filters--inline">
          {["pack_purchase", "grant", "unlock_debit", "refund"].map((r) => (
            <Link
              aria-current={r === reason ? "true" : undefined}
              className={filterChipClass(r === reason)}
              href={`/credits?windowDays=${windowDays}&reason=${r}`}
              key={r}
            >
              {creditReasonLabel(r)}
            </Link>
          ))}
        </div>

        {ledger === null ? (
          <div className="state state--error">
            <h3 className="state__title">The ledger is unavailable</h3>
            <p className="state__body">
              {summary
                ? "The credit movements did not load. The position above is a separate read and is unaffected, so a balance shown there is still current."
                : "The credit movements did not load, and neither did the position above. Retry reads both again."}
            </p>
            {/* The ledger is the paged list on this page: Retry keeps its cursor, and with one
                in the query the first page is offered too. */}
            <RetryActions href={queryHref} cursor={cursor} />
          </div>
        ) : ledger.items.length === 0 ? (
          reason ? (
            <div className="state">
              <h3 className="state__title">No movements with this reason</h3>
              {/* The selected reason is not echoed back into the copy: it comes straight
                  from the query string, and the highlighted chip above already says which
                  one is active. */}
              <p className="state__body">
                Nothing has been recorded under the selected reason. Clear it to see every
                movement, newest first.
              </p>
            </div>
          ) : (
            <div className="state">
              <h3 className="state__title">No credit movements recorded yet</h3>
              <p className="state__body">
                The ledger is append-only and still empty: no pack has been purchased, no
                grant issued and no contact unlocked. It fills from the first purchase.
              </p>
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/transactions">
                  <Icon name="receipt" />
                  Open payment orders
                </Link>
              </div>
            </div>
          )
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Credit ledger, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Credits</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                {ledger.items.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <time dateTime={row.created_at} title={formatTimestamp(row.created_at)}>
                        {formatRelative(row.created_at)}
                      </time>
                    </td>
                    <td>
                      <Link className="link mono" href={`/companies/${row.payer_id}`}>
                        {shortId(row.payer_id)}
                      </Link>
                    </td>
                    <td>
                      {/* The pill shows the REASON, toned by direction — a debit spends
                          credits, everything else adds them. It used to borrow the
                          applications tone map by value, which rendered the word "applied"
                          next to an ops grant. */}
                      <StatusPill
                        value={row.reason}
                        label={creditReasonLabel(row.reason)}
                        tone={row.delta < 0 ? "warn" : "ok"}
                        title={`${row.reason} · ${row.delta < 0 ? "spends" : "adds"} credits`}
                      />
                    </td>
                    <td className="mono ui-num">{formatDelta(row.delta)}</td>
                    <td className="table__meta ui-num">
                      {/* A null price is a legacy row or a non-purchase. Rendering the
                          current catalog price here would retroactively rewrite what a past
                          purchase appears to have cost. */}
                      {row.price_inr === null ? "—" : formatRupees(row.price_inr)}
                    </td>
                    <td className="table__meta">
                      {row.pack_code
                        ? packCodeLabel(row.pack_code)
                        : row.unlock_id
                          ? `unlock ${shortId(row.unlock_id)}`
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pager
          basePath="/credits"
          params={{ reason, windowDays: String(windowDays) }}
          nextCursor={ledger?.nextCursor}
          note="The ledger is append-only, so a keyset page is stable even as new movements arrive."
        />
      </section>
    </div>
  );
}
