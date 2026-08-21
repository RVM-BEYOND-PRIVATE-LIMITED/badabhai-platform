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
  const retryHref = (() => {
    const qs = new URLSearchParams({ windowDays: String(windowDays) });
    if (reason) qs.set("reason", reason);
    if (cursor) qs.set("cursor", cursor);
    return `/credits?${qs.toString()}`;
  })();

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

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Credits</h1>
          <p className="page__sub">
            The platform&apos;s outstanding credit liability and every movement behind it.
          </p>
        </div>
        <div className="page__actions">
          {WINDOWS.map((w) => (
            <Link
              className={`btn ${w === windowDays ? "btn--primary" : "btn--ghost"}`}
              href={`/credits?windowDays=${w}`}
              key={w}
            >
              {w}d
            </Link>
          ))}
        </div>
      </header>

      {posture && <PaymentsPostureBanner posture={posture} />}

      {summary ? (
        <>
          <section aria-labelledby="cr-position">
            <h2 className="sr-only" id="cr-position">
              Credit position
            </h2>
            <div className="stats">
              <div className="stat">
                <span className="stat__value">{formatCount(summary.outstanding_credits)}</span>
                <span className="stat__label">Credits outstanding</span>
              </div>
              <div className="stat">
                <span className="stat__value">{formatCount(summary.payers_with_balance)}</span>
                <span className="stat__label">Payers holding credits</span>
              </div>
              <div className="stat">
                <span className="stat__value">
                  {formatRupees(summary.paid_orders.amount_inr)}{" "}
                  <MockMoneyTag posture={summary.payments} />
                </span>
                <span className="stat__label">
                  Settled in {summary.window_days}d ({formatCount(summary.paid_orders.count)}{" "}
                  orders)
                </span>
              </div>
              <div
                className={`stat${summary.unsettled_orders.count > 0 ? " stat--warn" : ""}`}
              >
                <span className="stat__value">
                  {formatCount(summary.unsettled_orders.count)}
                </span>
                <span className="stat__label">
                  Unsettled orders — started, never completed
                </span>
              </div>
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
                  <h3 className="state__title">No payer holds a credit balance yet</h3>
                  <p className="state__body">
                    Nothing has been granted or purchased, so no account has credits to
                    spend on an unlock. The ledger below is the place to confirm that.
                  </p>
                  <div className="state__actions">
                    <Link className="btn btn--ghost" href="/transactions">
                      Open transactions
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="tablewrap">
                  <table className="table">
                    <caption className="sr-only">Largest credit balances</caption>
                    <thead>
                      <tr>
                        <th scope="col">Account</th>
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
              The finance summary did not load, so the outstanding balance and the movement
              breakdown are missing. The credit ledger below is a separate read and is
              unaffected. Reload to try again.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href={retryHref}>
                Retry
              </Link>
            </div>
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
            <Link className="btn btn--ghost" href="/credits">
              Clear filter
            </Link>
          )}
        </div>

        <div className="filters filters--inline">
          {["pack_purchase", "grant", "unlock_debit", "refund"].map((r) => (
            <Link
              className={`btn btn--sm ${r === reason ? "btn--primary" : "btn--ghost"}`}
              href={`/credits?reason=${r}`}
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
              The credit movements did not load. The position above is a separate read and
              is unaffected, so a balance shown there is still current. Reload to try again.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href={retryHref}>
                Retry
              </Link>
            </div>
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
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/credits">
                  Clear filter
                </Link>
              </div>
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
                  Open transactions
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
                  <th scope="col">Account</th>
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
