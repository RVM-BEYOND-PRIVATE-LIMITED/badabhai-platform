import Link from "next/link";
import type { CreditsView } from "../lib/entities";
import {
  creditReasonLabel,
  formatCount,
  formatDelta,
  formatRupees,
  formatTimestamp,
  packCodeLabel,
  timestampTitle,
} from "../lib/format";
import { queryHref } from "../lib/query-href";
import { Pager } from "./pager";
import { StatusPill } from "./status-pill";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * The Credits ledger tab (A9, #2579; `GET /admin/payers/:id/credits`).
 *
 * The balance and the append-only movements are served together so an operator investigating a
 * wrong balance can see both sides. A ₹0 here is a real zero; a missing price is "not recorded".
 */
export function CompanyCreditsTab({
  credits,
  cursor,
  basePath,
}: {
  credits: CreditsView | null;
  cursor: string | undefined;
  basePath: string;
}) {
  if (credits === null) {
    return (
      <div className="state state--error">
        <h3 className="state__title">The credits ledger could not be loaded</h3>
        <p className="state__body">
          The company record loaded, but its ledger did not — so this table is missing, not
          empty, and the balance below is not claimed.
        </p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href={queryHref(basePath, { tab: "credits" })}>
            <Icon name={ACTION_ICON.retry} />
            Retry
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="company-credits">
      <div className="panel__head">
        <h2 className="panel__title">Credits ledger</h2>
        <p className="panel__sub">
          {formatCount(credits.balance)} credits in the live balance. Every movement is append-only.
        </p>
      </div>

      {credits.ledger.items.length === 0 ? (
        <div className="state">
          <h3 className="state__title">No credit movements yet</h3>
          <p className="state__body">
            This company has never bought, been granted or spent credits. A zero balance with no
            ledger rows is a truthful empty state.
          </p>
        </div>
      ) : (
        <>
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Credit ledger, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Date (IST)</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Credits</th>
                  <th scope="col">Pack</th>
                  <th scope="col">Price</th>
                  <th scope="col">Unlock</th>
                </tr>
              </thead>
              <tbody>
                {credits.ledger.items.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <time dateTime={row.created_at} title={timestampTitle(row.created_at)}>
                        {formatTimestamp(row.created_at)}
                      </time>
                    </td>
                    <td>
                      <StatusPill
                        value={row.reason}
                        label={creditReasonLabel(row.reason)}
                        tone={row.delta < 0 ? "warn" : "ok"}
                      />
                    </td>
                    <td className="ui-num">{formatDelta(row.delta)}</td>
                    <td>{row.pack_code ? packCodeLabel(row.pack_code) : "—"}</td>
                    <td className="ui-num">
                      {row.price_inr === null ? (
                        <span className="table__meta">Not recorded</span>
                      ) : (
                        formatRupees(row.price_inr)
                      )}
                    </td>
                    <td>
                      {row.unlock_id ? (
                        <span className="mono" title={row.unlock_id}>
                          {row.unlock_id}
                        </span>
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
            params={{ tab: "credits" }}
            cursor={cursor}
            nextCursor={credits.ledger.nextCursor}
            note="The credits ledger is keyset-paged, so no movement can skip or repeat between pages."
          />
        </>
      )}
    </div>
  );
}
