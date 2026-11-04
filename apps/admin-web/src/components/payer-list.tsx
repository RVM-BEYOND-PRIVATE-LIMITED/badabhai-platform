import Link from "next/link";
import type { ReactNode } from "react";
import type { PayerListItem } from "../lib/entities";
import { NAME_UNREADABLE, displayName, type IdentityPosture } from "../lib/identity";
import { formatRelative, shortId, timestampTitle } from "../lib/format";
import { CopyId } from "./copy-id";
import { StatusPill } from "./status-pill";
import { NameCell } from "./name-cell";
import { DataGrid, type GridColumn } from "./data-grid";
import { ACTION_ICON, Icon } from "@badabhai/icons";

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
  pager,
}: {
  payers: PayerListItem[];
  /** "/companies" or "/agencies" — detail links stay inside the section you came from. */
  basePath: string;
  emptyMessage: string;
  /** Decided by the page from the rows + `read_identity`. See `lib/identity.ts`. */
  posture: IdentityPosture;
  /** The page's pager, drawn in the grid's footer bar. */
  pager?: ReactNode;
}) {
  if (payers.length === 0) {
    // The recovery action is the identification path documented above, and it is the right one
    // in every posture: this screen has no name SEARCH even when it shows names.
    return (
      <div className="state">
        <h3 className="state__title">{emptyMessage}</h3>
        <p className="state__body">
          There is nothing to search by on this screen. The way in is the other direction —
          find the posting, then follow it to the customer that published it.
        </p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/jobs">
            <Icon name={ACTION_ICON.posting} />
            Browse postings
          </Link>
        </div>
      </div>
    );
  }

  const named = posture === "named";
  /**
   * The roster's columns on the data grid (A4, #2574). The row's link is its NAME: the
   * organisation in the `named` posture, otherwise the id — then the only handle the row has.
   */
  const columns: GridColumn<PayerListItem>[] = [
    /* Only in the `named` posture — a dash under this heading would claim the account registered
       without a business name. `payers.org_name_enc` is NOT NULL, so a dash here cannot mean
       "none was recorded" — see NAME_UNREADABLE. */
    ...(named
      ? [
          {
            id: "organisation",
            header: "Organisation",
            cell: (p: PayerListItem) => <NameCell value={p.org_name} absentTitle={NAME_UNREADABLE} />,
            title: (p: PayerListItem) => displayName(p.org_name) ?? undefined,
          },
        ]
      : []),
    /* The id column stays: it is the join key onto the audit spine and the handle for an account
       that never recorded a name. */
    {
      id: "customer",
      header: "Customer",
      width: "id",
      cell: (p) =>
        named ? (
          <span className="mono" title={p.id}>
            {shortId(p.id)}
          </span>
        ) : (
          <span className="mono">{shortId(p.id)}</span>
        ),
      title: named ? undefined : (p) => p.id,
      trail: (p) => <CopyId id={p.id} />,
    },
    {
      id: "status",
      header: "Status",
      /* A text column: the pill and, for a suspended account, what reinstating would restore. */
      title: (p) =>
        p.status === "suspended" && p.previous_status
          ? `${p.status} · was ${p.previous_status}`
          : undefined,
      cell: (p) => (
        <>
          <StatusPill value={p.status} />
          {p.status === "suspended" && p.previous_status && (
            // What reinstate would restore. Without it an operator has to guess whether
            // reinstating republishes a posting the payer had paused.
            <span className="table__meta"> was {p.previous_status}</span>
          )}
        </>
      ),
    },
    {
      id: "registered",
      header: "Registered",
      width: "date",
      cell: (p) => (
        <time dateTime={p.created_at} title={timestampTitle(p.created_at)}>
          {formatRelative(p.created_at)}
        </time>
      ),
    },
    {
      id: "updated",
      header: "Last updated",
      width: "date",
      cell: (p) => (
        <time dateTime={p.updated_at} title={timestampTitle(p.updated_at)}>
          {formatRelative(p.updated_at)}
        </time>
      ),
    },
  ];

  return (
    <DataGrid
      /* Companies and Agencies are two lists to the viewer: each keeps its own column choices. */
      id={basePath === "/agencies" ? "agencies" : "companies"}
      caption="Customers, newest first"
      columns={columns}
      rows={payers}
      rowKey={(p) => p.id}
      rowLink={{
        column: named ? "organisation" : "customer",
        href: (p) => `${basePath}/${p.id}`,
        name: (p) => (named ? displayName(p.org_name) : null) ?? `customer ${shortId(p.id)}`,
        // The dash means "the name could not be read"; as a link's whole name it would say nothing.
        label: (p) =>
          named && displayName(p.org_name) === null
            ? `Customer ${shortId(p.id)}, name unreadable`
            : undefined,
      }}
      pager={pager}
    />
  );
}
