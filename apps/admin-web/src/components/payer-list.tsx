import Link from "next/link";
import type { PayerListItem } from "../lib/entities";
import { NAME_UNREADABLE, type IdentityPosture } from "../lib/identity";
import { formatRelative, formatTimestamp, shortId } from "../lib/format";
import { StatusPill } from "./status-pill";
import { NameCell } from "./name-cell";

/**
 * The payer roster, shared by Companies (`role=employer`) and Agencies (`role=agent`).
 *
 * ── THE ORGANISATION NAME COLUMN (owner ruling 2026-08-18) ──────────────────────────────
 * `payers.org_name_enc` is now served behind `read_identity`, so "suspend Acme" is a thing an
 * operator can actually do on this screen. It is the account's SELF-DECLARED business name from
 * signup, not a verified legal one — the same caveat the detail page states about the org labels
 * on their postings, and worth keeping in mind on a screen that sits next to a suspend button.
 *
 * It is NOT a contact person: no contact-person column exists anywhere in the codebase, and
 * neither the payer's login email nor an agency's KYC account-holder name (an ADR-0022
 * money/legal gate) is a substitute for one. Email and phone remain undecrypted for every role.
 *
 * ── THE OLD IDENTIFICATION PATH STILL WORKS, AND IS STILL THE ONLY ONE ON SOME ROWS ─────
 * Jobs carries `org_label`, `role_title` and `location_label`, which the poster typed themselves
 * and which every worker already sees in the feed. That remains the way in for an `analyst`, for
 * a capped read, and for any account whose org name was never recorded — find the POSTING,
 * follow it to its owner, act. The detail page closes the loop by listing that payer's postings.
 */
export function PayerList({
  payers,
  basePath,
  emptyMessage,
  posture,
}: {
  payers: PayerListItem[];
  /** "/companies" or "/agencies" — detail links stay inside the section you came from. */
  basePath: string;
  emptyMessage: string;
  /** Decided by the page from the rows + `read_identity`. See `lib/identity.ts`. */
  posture: IdentityPosture;
}) {
  if (payers.length === 0) {
    // The recovery action is the identification path documented above, and it is the right one
    // in every posture: this screen has no name SEARCH even when it shows names.
    return (
      <div className="state">
        <h3 className="state__title">{emptyMessage}</h3>
        <p className="state__body">
          There is nothing to search by on this screen. The way in is the other direction —
          find the posting, then follow it to the account that published it.
        </p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/jobs">
            Browse job postings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="tablewrap">
      <table className="table">
        <caption className="sr-only">Accounts, newest first</caption>
        <thead>
          <tr>
            {/* Only in the `named` posture — a dash under this heading would claim the account
                registered without a business name. */}
            {posture === "named" && <th scope="col">Organisation</th>}
            <th scope="col">Account</th>
            <th scope="col">Status</th>
            <th scope="col">Registered</th>
            <th scope="col">Last change</th>
          </tr>
        </thead>
        <tbody>
          {payers.map((p) => (
            <tr key={p.id}>
              {posture === "named" && (
                <td>
                  {/* `payers.org_name_enc` is NOT NULL, so a dash here cannot mean "none was
                      recorded" — see NAME_UNREADABLE. */}
                  <NameCell value={p.org_name} absentTitle={NAME_UNREADABLE} />
                </td>
              )}
              {/* The id column stays: it is the join key onto the audit spine and the handle
                  for an account that never recorded a name. */}
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
