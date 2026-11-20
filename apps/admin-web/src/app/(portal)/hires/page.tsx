import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { isAdminRequestError } from "../../../lib/admin-http";
import {
  HIRE_POSTING_KIND_LABELS,
  HIRE_STATUSES,
  HIRE_STATUS_LABELS,
  type HireStatus,
} from "../../../lib/hires-vocabulary";
import { listHires, type HireRecord } from "../../../lib/hires";
import {
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
import { HireFilterBar } from "./filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hire records" };

const PAGE_SIZE = 50;
const PAY_ON_JOINING_HREF = "/pay-on-joining-hires";
const DESCRIPTION = "Who companies took on, and how the platform knows.";

/**
 * Hire records (#2753 item 9) — the read-only list of everyone a company took on.
 *
 * A row is FACELESS: the company, worker and posting appear as ids, with the status and the
 * dates each source said "hired". No detail route exists, so rows do not link.
 */
export default async function HireRecordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("manage_companies");

  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

  const status = one(sp.status);
  const cursor = one(sp.cursor);
  const filtered = Boolean(status);
  const refusable = isUnknownValue(status, HIRE_STATUSES);

  let page: Awaited<ReturnType<typeof listHires>> | null = null;
  let refusal: ReadRefusal = null;
  try {
    page = await listHires({
      status: status as HireStatus | undefined,
      cursor,
      limit: PAGE_SIZE,
    });
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader
            title="Hire records"
            description={DESCRIPTION}
            secondaryActions={<RelatedView />}
          />
          <section className="panel">
            <div className="state">
              <h2 className="state__title">Hire records are not switched on yet</h2>
              <p className="state__body">
                Until the hire-records switch is turned on for this environment, nothing is
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
            title="Hire records"
            description={DESCRIPTION}
            secondaryActions={<RelatedView />}
          />
          <section className="panel">
            <div className="state state--error">
              <h2 className="state__title">Hire records are unavailable</h2>
              <p className="state__body">
                The list is switched on, but its table is not ready. Retry after the migration
                lands.
              </p>
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/hires">
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
  const listHref = queryHref("/hires", { status });
  const clearFilters = filtered ? (
    <Link className="btn btn--ghost" href="/hires">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
      <NavPendingCue message="Clearing the filters…" />
    </Link>
  ) : null;

  return (
    <div className="page page--list">
      <PageHeader
        title="Hire records"
        description={DESCRIPTION}
        info={
          <p>
            A row joins a company, a worker and a posting. Only a confirmed record counts toward
            hires, and no detail page exists here — the worker and company screens name them.
          </p>
        }
        secondaryActions={<RelatedView />}
        filters={
          <FilterPanel headingId="hire-filters" heading="Filter hire records" filters={{ status }}>
            <HireFilterBar status={status ?? ""} />
          </FilterPanel>
        }
      />

      <section className="panel" aria-labelledby="hire-results" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="hire-results">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? filtersRefused
                  ? "That status was rejected."
                  : "Nothing was fetched."
                : `${page?.items.length ?? 0} record${page?.items.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {filtersRefused ? null : clearFilters}
        </div>

        {refused ? (
          <div className="state state--error">
            <h3 className="state__title">
              {filtersRefused ? "The server rejected that status" : CURSOR_REFUSAL.title}
            </h3>
            <p className="state__body">
              {filtersRefused
                ? "Nothing was fetched. A status must be one this list records — reported, confirmed or rejected. Choose it again, or clear the filter."
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
            <h3 className="state__title">Hire records are unavailable</h3>
            <p className="state__body">
              The list did not load, and that is a fault on our side rather than anything in the
              filter.
            </p>
            <RetryActions href={listHref} cursor={cursor} />
          </div>
        ) : page && page.items.length > 0 ? (
          <DataGrid
            id="hire-records"
            caption="Hire records, newest first"
            columns={COLUMNS}
            rows={page.items}
            rowKey={(row) => row.id}
            pager={
              <Pager
                basePath="/hires"
                params={{ status }}
                cursor={cursor}
                nextCursor={page.nextCursor}
                note="Paging uses a keyset cursor, so records created mid-scan cannot make rows skip or repeat."
              />
            }
          />
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No hire records match this status</h3>
            <p className="state__body">
              Nothing on the spine holds that status. Choose another status, or clear the filter to
              see every hire record.
            </p>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No hire records yet</h3>
            <p className="state__body">
              A record appears when a company moves someone into hired, a source answers, or the
              desk confirms one.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function RelatedView() {
  return (
    <Link className="btn btn--ghost" href={PAY_ON_JOINING_HREF}>
      <Icon name="hand-coins" />
      Pay-on-joining records
      <NavPendingCue message="Opening pay-on-joining records…" />
    </Link>
  );
}

function dateCell(value: string | null, withTitle = false) {
  if (value === null) {
    return <span className="table__meta">—</span>;
  }
  return (
    <time dateTime={value} title={withTitle ? timestampTitle(value) : undefined}>
      {formatDate(value)}
    </time>
  );
}

const COLUMNS: readonly GridColumn<HireRecord>[] = [
  {
    id: "hire",
    header: "Hire",
    width: "id",
    rowHeader: true,
    cell: (row) => <span className="mono">{shortId(row.id)}</span>,
    trail: (row) => <CopyId id={row.id} label="hire id" />,
    title: (row) => row.id,
  },
  {
    id: "company",
    header: "Company",
    width: "id",
    cell: (row) => <span className="mono">{shortId(row.tenant_payer_id)}</span>,
    trail: (row) => <CopyId id={row.tenant_payer_id} label="company id" />,
    title: (row) => row.tenant_payer_id,
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
    id: "posting",
    header: "Posting",
    width: "short",
    cell: (row) => HIRE_POSTING_KIND_LABELS[row.posting_kind],
    trail: (row) => (
      <>
        <br />
        <span className="table__meta mono">{shortId(row.posting_id)}</span>
      </>
    ),
    title: (row) => `${HIRE_POSTING_KIND_LABELS[row.posting_kind]} · ${row.posting_id}`,
  },
  {
    id: "status",
    header: "Status",
    width: "status",
    cell: (row) => (
      <StatusPill value={row.status} label={HIRE_STATUS_LABELS[row.status]} />
    ),
  },
  {
    id: "hired-on",
    header: "Hired on",
    width: "date",
    cell: (row) => dateCell(row.hired_on),
  },
  {
    id: "recorded",
    header: "Recorded",
    width: "date",
    cell: (row) => dateCell(row.created_at, true),
  },
  {
    id: "updated",
    header: "Updated",
    width: "date",
    cell: (row) => dateCell(row.updated_at, true),
  },
];
