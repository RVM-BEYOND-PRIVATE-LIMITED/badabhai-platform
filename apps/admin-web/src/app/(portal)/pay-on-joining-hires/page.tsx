import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { isAdminRequestError } from "../../../lib/admin-http";
import {
  listPayOnJoiningHires,
  type PayOnJoiningHireRow,
} from "../../../lib/pay-on-joining";
import {
  PAY_ON_JOINING_PAYMENT_STATE_LABELS,
  PAY_ON_JOINING_PAYMENT_STATES,
  formatPaise,
  type PayOnJoiningPaymentState,
} from "../../../lib/pay-on-joining-vocabulary";
import {
  isMalformedUuid,
  isUnknownValue,
  readRefusal,
  type ReadRefusal,
} from "../../../lib/read-refusal";
import { formatDate, shortId, timestampTitle } from "../../../lib/format";
import { queryHref } from "../../../lib/query-href";
import { PageHeader } from "../../../components/page-header";
import { FilterPanel } from "../../../components/filter-panel";
import { DataGrid, type GridColumn } from "../../../components/data-grid";
import { Pager } from "../../../components/pager";
import { CopyId } from "../../../components/copy-id";
import { StatusPill } from "../../../components/status-pill";
import { NavPendingCue } from "../../../components/nav-pending";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  CURSOR_REFUSAL,
  FirstPageAction,
  RetryActions,
} from "../../../components/retry-actions";
import { PayOnJoiningHireDialog } from "./pay-on-joining-hire-form";
import { PayOnJoiningHiresFilterBar } from "./filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pay-on-joining hires" };

const PAGE_SIZE = 50;
const DESCRIPTION = "The pilot's hire records: fee, 30-day check and partner payment.";

/**
 * Pay-on-joining hire records (#2753 item 11) — the pilot's commercial record of a hire.
 *
 * Add and edit are governed Server Actions. Edit is seeded from the row already on the list;
 * there is no `GET :id` route. A 404 is the feature switch being off, not a broken screen.
 */
export default async function PayOnJoiningHiresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("manage_companies");

  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

  const factoryPayerId = one(sp.factory_payer_id);
  const partnerPayerId = one(sp.partner_payer_id);
  const paid = one(sp.paid);
  const cursor = one(sp.cursor);

  const filtered = Boolean(factoryPayerId || partnerPayerId || paid);
  const refusable =
    isMalformedUuid(factoryPayerId) ||
    isMalformedUuid(partnerPayerId) ||
    isUnknownValue(paid, PAY_ON_JOINING_PAYMENT_STATES);

  let page: Awaited<ReturnType<typeof listPayOnJoiningHires>> | null = null;
  let refusal: ReadRefusal = null;
  try {
    page = await listPayOnJoiningHires({
      factoryPayerId,
      partnerPayerId,
      paid: paid as PayOnJoiningPaymentState | undefined,
      cursor,
      limit: PAGE_SIZE,
    });
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader
            back={{ href: "/hires", label: "Hire records" }}
            title="Pay-on-joining hires"
            description={DESCRIPTION}
          />
          <section className="panel">
            <div className="state">
              <h2 className="state__title">Pay-on-joining records are not switched on yet</h2>
              <p className="state__body">
                Until the pay-on-joining switch is turned on for this environment, nothing is
                recorded here.
              </p>
            </div>
          </section>
        </div>
      );
    }
    if (isAdminRequestError(err) && err.status === 503) {
      return (
        <div className="page page--reading">
          <PageHeader
            back={{ href: "/hires", label: "Hire records" }}
            title="Pay-on-joining hires"
            description={DESCRIPTION}
          />
          <section className="panel">
            <div className="state state--error">
              <h2 className="state__title">Pay-on-joining records are unavailable</h2>
              <p className="state__body">
                The feature is on, but its table is not ready. Retry after the migration lands.
              </p>
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/pay-on-joining-hires">
                  <Icon name={ACTION_ICON.retry} />
                  Retry
                </Link>
              </div>
            </div>
          </section>
        </div>
      );
    }
    refusal = readRefusal(err, { filtered: refusable, cursor });
  }

  const failed = page === null;
  const refused = refusal !== null;
  const filtersRefused = refusal === "filters";
  const listHref = queryHref("/pay-on-joining-hires", {
    factory_payer_id: factoryPayerId,
    partner_payer_id: partnerPayerId,
    paid,
  });
  const clearFilters = filtered ? (
    <Link className="btn btn--ghost" href="/pay-on-joining-hires">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
      <NavPendingCue message="Clearing the filters…" />
    </Link>
  ) : null;

  return (
    <div className="page page--list">
      <PageHeader
        back={{ href: "/hires", label: "Hire records" }}
        title="Pay-on-joining hires"
        description={DESCRIPTION}
        info={
          <p>
            A record only: nothing here raises an invoice, moves money or pays a partner. The
            partner's share is worked out by the server from the fee.
          </p>
        }
        primaryAction={<PayOnJoiningHireDialog mode="create" />}
        filters={
          <FilterPanel
            headingId="poj-filters"
            heading="Filter pay-on-joining records"
            filters={{
              factory_payer_id: factoryPayerId,
              partner_payer_id: partnerPayerId,
              paid,
            }}
          >
            <PayOnJoiningHiresFilterBar
              factoryPayerId={factoryPayerId ?? ""}
              partnerPayerId={partnerPayerId ?? ""}
              paid={paid ?? ""}
            />
          </FilterPanel>
        }
      />

      <section className="panel" aria-labelledby="poj-results" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="poj-results">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? filtersRefused
                  ? "That filter combination was rejected."
                  : "Nothing was fetched."
                : `${page?.items.length ?? 0} record${page?.items.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {filtersRefused ? null : clearFilters}
        </div>

        {refused ? (
          <div className="state state--error">
            <h3 className="state__title">
              {filtersRefused ? "The server rejected these filters" : CURSOR_REFUSAL.title}
            </h3>
            <p className="state__body">
              {filtersRefused
                ? "Nothing was fetched. A factory or partner id must be a full UUID, and the payment state must be one this list records. Correct the value above, or clear the filters."
                : CURSOR_REFUSAL.body}
            </p>
            {filtersRefused ? (
              <div className="state__actions">{clearFilters}</div>
            ) : (
              <FirstPageAction href={listHref} cursor={cursor} />
            )}
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">Pay-on-joining records are unavailable</h3>
            <p className="state__body">
              The list did not load, and that is a fault on our side rather than anything in the
              filters.
            </p>
            <RetryActions href={listHref} cursor={cursor} />
          </div>
        ) : page && page.items.length > 0 ? (
          <DataGrid
            id="pay-on-joining-hires"
            caption="Pay-on-joining hire records, newest first"
            columns={COLUMNS}
            rows={page.items}
            rowKey={(row) => row.id}
            pager={
              <Pager
                basePath="/pay-on-joining-hires"
                params={{
                  factory_payer_id: factoryPayerId,
                  partner_payer_id: partnerPayerId,
                  paid,
                }}
                cursor={cursor}
                nextCursor={page.nextCursor}
                note="Paging uses a keyset cursor, so records added mid-scan cannot make rows skip or repeat."
              />
            }
          />
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No hire records match these filters</h3>
            <p className="state__body">
              Nothing matches the filters currently applied. Widen them, or clear them to see
              every pay-on-joining record.
            </p>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No pay-on-joining hires recorded yet</h3>
            <p className="state__body">
              Use “Record a hire” to add the first one. The pilot’s records are entered by hand.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function stayChecked(row: PayOnJoiningHireRow) {
  if (row.stay_checked_on === null || row.stayed_30_days === null) {
    return <span className="table__meta">Not checked</span>;
  }
  return (
    <span title={`Checked ${row.stay_checked_on}`}>
      {row.stayed_30_days ? "Stayed" : "Left"} · {formatDate(row.stay_checked_on)}
    </span>
  );
}

function optionalDate(value: string | null) {
  return value === null ? (
    <span className="table__meta">—</span>
  ) : (
    <time dateTime={value} title={timestampTitle(value)}>
      {formatDate(value)}
    </time>
  );
}

const COLUMNS: readonly GridColumn<PayOnJoiningHireRow>[] = [
  {
    id: "factory",
    header: "Factory",
    width: "id",
    rowHeader: true,
    cell: (row) => <span className="mono">{shortId(row.factory_payer_id)}</span>,
    trail: (row) => <CopyId id={row.factory_payer_id} label="factory id" />,
    title: (row) => row.factory_payer_id,
  },
  {
    id: "worker",
    header: "Worker",
    width: "id",
    cell: (row) => <span className="mono">{shortId(row.worker_id)}</span>,
    trail: (row) => <CopyId id={row.worker_id} label="worker id" />,
    title: (row) => row.worker_id,
  },
  {
    id: "partner",
    header: "Partner",
    width: "id",
    cell: (row) =>
      row.partner_payer_id === null ? (
        <span className="table__meta">None</span>
      ) : (
        <span className="mono">{shortId(row.partner_payer_id)}</span>
      ),
    trail: (row) =>
      row.partner_payer_id === null ? null : (
        <CopyId id={row.partner_payer_id} label="partner id" />
      ),
    title: (row) => row.partner_payer_id ?? undefined,
  },
  {
    id: "joined",
    header: "Joined",
    width: "date",
    cell: (row) => optionalDate(row.joined_on),
  },
  {
    id: "fee",
    header: "Fee",
    width: "money",
    className: "ui-num",
    cell: (row) => formatPaise(row.fee_paise),
    title: (row) => `${row.fee_paise} paise`,
  },
  {
    id: "share",
    header: "Partner share",
    width: "money",
    className: "ui-num",
    cell: (row) => formatPaise(row.partner_share_paise),
    trail: (row) => (
      <>
        <br />
        <span className="table__meta">{row.partner_share_percent}%</span>
      </>
    ),
    title: (row) =>
      `${formatPaise(row.partner_share_paise)} · ${row.partner_share_percent}% of the fee`,
  },
  {
    id: "stay",
    header: "30-day check",
    width: "short",
    cell: stayChecked,
  },
  {
    id: "payment",
    header: "Payment",
    width: "status",
    cell: (row) => (
      <StatusPill
        value={row.payment_state}
        label={PAY_ON_JOINING_PAYMENT_STATE_LABELS[row.payment_state]}
        tone={row.payment_state === "settled" ? "ok" : "warn"}
      />
    ),
  },
  {
    id: "posting",
    header: "Posting",
    width: "id",
    defaultHidden: true,
    cell: (row) =>
      row.job_posting_id === null ? (
        <span className="table__meta">None</span>
      ) : (
        <span className="mono">{shortId(row.job_posting_id)}</span>
      ),
    title: (row) => row.job_posting_id ?? undefined,
  },
  {
    id: "invoiced",
    header: "Invoiced",
    width: "date",
    defaultHidden: true,
    cell: (row) => optionalDate(row.invoiced_on),
  },
  {
    id: "factory-paid",
    header: "Factory paid",
    width: "date",
    defaultHidden: true,
    cell: (row) => optionalDate(row.factory_paid_on),
  },
  {
    id: "partner-paid",
    header: "Partner paid",
    width: "date",
    defaultHidden: true,
    cell: (row) => optionalDate(row.partner_paid_on),
  },
  {
    id: "note",
    header: "Note",
    text: "wrap",
    defaultHidden: true,
    cell: (row) =>
      row.note === null ? <span className="table__meta">—</span> : row.note,
  },
  {
    id: "actions",
    header: "Actions",
    width: "actions",
    cell: (row) => <PayOnJoiningHireDialog mode="edit" initial={row} />,
  },
];
