import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import {
  listOutOfCredits,
  type OutOfCreditsPage,
  type OutOfCreditsRow,
} from "../../../../lib/numbers";
import { isAdminRequestError, isAdminUnauthorized } from "../../../../lib/admin-http";
import { displayName } from "../../../../lib/identity";
import { customerHref } from "../../../../lib/customer";
import {
  formatRelative,
  packCodeLabel,
  shortId,
  timestampTitle,
} from "../../../../lib/format";
import { CREDIT_CALL_RESULT_LABELS } from "../../../../lib/numbers-vocabulary";
import { PageHeader } from "../../../../components/page-header";
import { DataGrid, type GridColumn } from "../../../../components/data-grid";
import { Pager } from "../../../../components/pager";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { NumbersTabs } from "../numbers-tabs";
import { LogCallButtons } from "../log-call-buttons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Out-of-credits calls" };

/**
 * The out-of-credits call list (#2884; API #2755 part C).
 *
 * Companies whose usable balance is zero, newest first, keyset paged. The route never returns a
 * phone: the "Phone" link opens the User accounts screen, which is where a phone lives. The row is
 * refreshed after a call is logged, so the next operator sees the latest result.
 */
export default async function OutOfCreditsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("read_business_numbers");

  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  const cursor = one(sp.cursor);

  let page: OutOfCreditsPage | null = null;
  let problem: "off" | "unavailable" | "cursor" | "error" | null = null;

  try {
    page = await listOutOfCredits({ cursor });
  } catch (err) {
    if (isAdminUnauthorized(err)) throw err;
    if (isAdminRequestError(err)) {
      if (err.status === 404) problem = "off";
      else if (err.status === 503) problem = "unavailable";
      else if (err.status === 400 && cursor) problem = "cursor";
      else problem = "error";
    } else {
      problem = "error";
    }
  }

  return (
    <div className="page page--list">
      <PageHeader
        back={{ href: "/numbers", label: "Numbers" }}
        title="Out-of-credits calls"
        description="Companies whose usable credits are zero, newest first, with their latest call."
        info={
          <>
            <p>
              These routes never carry a phone. Use the Phone link to open the company on User
              accounts, where the login and its contact details live.
            </p>
            <p>Logging a call records the result only — a closed code, never free text.</p>
          </>
        }
        filters={<NumbersTabs active="out-of-credits" />}
      />

      <section className="panel" aria-labelledby="ooc-results" aria-live="polite">
        <div className="panel__head">
          <h2 className="panel__title" id="ooc-results">
            Call list
          </h2>
          <p className="panel__sub">
            {page
              ? `${page.rows.length} compan${page.rows.length === 1 ? "y" : "ies"} on this page.`
              : "Nothing was fetched."}
          </p>
        </div>

        {problem ? (
          <Problem problem={problem} />
        ) : page && page.rows.length > 0 ? (
          <DataGrid
            id="out-of-credits"
            caption="Companies whose credits ran out, newest first"
            columns={COLUMNS}
            rows={page.rows}
            rowKey={(row) => row.payer_id}
            pager={
              <Pager
                basePath="/numbers/out-of-credits"
                params={{}}
                cursor={cursor}
                nextCursor={page.next_cursor}
                note="The list is keyset paged, so a call logged mid-scan cannot skip or repeat a company."
              />
            }
          />
        ) : (
          <div className="state">
            <h3 className="state__title">No company is out of credits</h3>
            <p className="state__body">
              Every countable company has a usable balance. This list fills when one spends or
              loses its last credit.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function Problem({ problem }: { problem: "off" | "unavailable" | "cursor" | "error" }) {
  if (problem === "off") {
    return (
      <div className="state">
        <h3 className="state__title">Not switched on yet</h3>
        <p className="state__body">
          This deployment has not turned the numbers screen on. Nothing is wrong with your
          access.
        </p>
      </div>
    );
  }
  if (problem === "unavailable") {
    return (
      <div className="state state--error">
        <h3 className="state__title">Try again later</h3>
        <p className="state__body">
          A migration the call list reads has not been applied, so nothing was fetched.
        </p>
      </div>
    );
  }
  if (problem === "cursor") {
    return (
      <div className="state state--error">
        <h3 className="state__title">The page cursor was refused</h3>
        <p className="state__body">Nothing was fetched. Start from the first page.</p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/numbers/out-of-credits">
            <Icon name={ACTION_ICON.back} />
            First page
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="state state--error">
      <h3 className="state__title">The call list did not load</h3>
      <p className="state__body">This is a fault on our side. Retry reads the same page again.</p>
      <div className="state__actions">
        <Link className="btn btn--ghost" href="/numbers/out-of-credits">
          <Icon name={ACTION_ICON.retry} />
          Retry
        </Link>
      </div>
    </div>
  );
}

const COLUMNS: readonly GridColumn<OutOfCreditsRow>[] = [
  {
    id: "company",
    header: "Company",
    text: "truncate",
    rowHeader: true,
    cell: (row) => {
      const name = row.org_name === undefined ? null : displayName(row.org_name);
      return name ? (
        <Link href={customerHref(row.payer_id)}>{name}</Link>
      ) : (
        <span className="mono" title={row.payer_id}>
          {shortId(row.payer_id)}
        </span>
      );
    },
    title: (row) => (row.org_name === undefined ? row.payer_id : (row.org_name ?? row.payer_id)),
  },
  {
    id: "ran-out",
    header: "Ran out",
    width: "date",
    cell: (row) => (
      <time dateTime={row.ran_out_at} title={timestampTitle(row.ran_out_at)}>
        {formatRelative(row.ran_out_at)}
      </time>
    ),
  },
  {
    id: "last-purchase",
    header: "Last purchase",
    width: "date",
    cell: (row) =>
      row.last_purchase ? (
        <span title={timestampTitle(row.last_purchase.at)}>
          {formatRelative(row.last_purchase.at)}
          {row.last_purchase.pack_code ? ` · ${packCodeLabel(row.last_purchase.pack_code)}` : ""}
        </span>
      ) : (
        <span className="table__meta">Never paid</span>
      ),
  },
  {
    id: "last-open",
    header: "Last contact opened",
    width: "date",
    cell: (row) =>
      row.last_open_at ? (
        <time dateTime={row.last_open_at} title={timestampTitle(row.last_open_at)}>
          {formatRelative(row.last_open_at)}
        </time>
      ) : (
        <span className="table__meta">Never</span>
      ),
  },
  {
    id: "last-call",
    header: "Last call",
    width: "date",
    cell: (row) =>
      row.last_call ? (
        <span title={timestampTitle(row.last_call.called_at)}>
          {formatRelative(row.last_call.called_at)} ·{" "}
          {CREDIT_CALL_RESULT_LABELS[row.last_call.result]} ·{" "}
          <span className="mono">{shortId(row.last_call.admin_id)}</span>
        </span>
      ) : (
        <span className="table__meta">No call yet</span>
      ),
  },
  {
    id: "phone",
    header: "Phone",
    width: "short",
    cell: (row) => (
      <Link
        className="btn btn--ghost btn--sm"
        href={`/accounts?org_id=${encodeURIComponent(row.payer_id)}`}
        title="The phone is on the User accounts screen; this route never returns it."
      >
        <Icon name={ACTION_ICON.call} />
        <span>Phone</span>
      </Link>
    ),
  },
  {
    id: "log-call",
    header: "Log call",
    width: "actions",
    cell: (row) => <LogCallButtons payerId={row.payer_id} />,
  },
];
