import Link from "next/link";
import type { PayerListItem } from "../lib/entities";
import { formatRelative, formatTimestamp, shortId } from "../lib/format";
import { StatusPill } from "./status-pill";

/**
 * The payer roster, shared by Companies (`role=employer`) and Agencies (`role=agent`).
 *
 * ── WHY THERE IS NO COMPANY NAME COLUMN ─────────────────────────────────────────────────
 * A payer's organisation name, login email and phone are B2B contact PII, encrypted at
 * rest, and the admin read does not decrypt them. So a row here is an opaque id, a status
 * and a join date — which is correct, and on its own not much use for "suspend Acme".
 *
 * The identification path is the other way round: Jobs carries `org_label`, `role_title`
 * and `location_label`, which the poster typed themselves and which every worker already
 * sees in the feed. An operator finds the POSTING, follows it to its owner, and acts. The
 * payer detail page closes the loop by listing that payer's postings, so the org labels
 * they have used appear there too.
 *
 * This is deliberately not "solved" by decrypting names into a list. That would turn one
 * screen into a bulk export of every customer's contact identity — a far larger exposure
 * than the problem it fixes.
 */
export function PayerList({
  payers,
  basePath,
  emptyMessage,
}: {
  payers: PayerListItem[];
  /** "/companies" or "/agencies" — detail links stay inside the section you came from. */
  basePath: string;
  emptyMessage: string;
}) {
  if (payers.length === 0) return <p className="empty">{emptyMessage}</p>;

  return (
    <div className="tablewrap">
      <table className="table">
        <caption className="sr-only">Accounts, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Status</th>
            <th scope="col">Registered</th>
            <th scope="col">Last change</th>
          </tr>
        </thead>
        <tbody>
          {payers.map((p) => (
            <tr key={p.id}>
              <td>
                <Link className="link mono" href={`${basePath}/${p.id}`} title={p.id}>
                  {shortId(p.id)}
                </Link>
              </td>
              <td>
                <StatusPill value={p.status} />
                {p.status === "suspended" && p.previous_status && (
                  // What reinstate would restore. Without it an operator has to guess
                  // whether reinstating republishes a posting the payer had paused.
                  <span className="table__meta"> was {p.previous_status}</span>
                )}
              </td>
              <td>
                <time dateTime={p.created_at} title={formatTimestamp(p.created_at)}>
                  {formatRelative(p.created_at)}
                </time>
              </td>
              <td>
                <time dateTime={p.updated_at} title={formatTimestamp(p.updated_at)}>
                  {formatRelative(p.updated_at)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
