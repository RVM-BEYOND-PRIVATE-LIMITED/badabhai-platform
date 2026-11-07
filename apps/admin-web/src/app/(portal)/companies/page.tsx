import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import {
  COMPANY_KIND_FILTER_ROLES,
  COMPANY_KIND_LABELS,
  companyKindFilter,
  companyPage,
  companyPageSize,
  type CompanyKindFilter,
  type CompanyStatus,
  type CompanyVerificationStatus,
} from "../../../lib/company-vocabulary";
import {
  getCompanyMetricsFor,
  listCompanies,
  type CompanyListItem,
  type CompanyMetrics,
} from "../../../lib/companies";
import {
  isAdminRequestError,
  isAdminUnauthorized,
  isAdminForbidden,
} from "../../../lib/admin-http";
import { displayName, identityPosture, NAME_UNREADABLE } from "../../../lib/identity";
import { customerHref } from "../../../lib/customer";
import { formatCount, formatDate, formatRupees, shortId, timestampTitle } from "../../../lib/format";
import { queryHref } from "../../../lib/query-href";
import { readRefusal, type ReadRefusal } from "../../../lib/read-refusal";
import { PageHeader } from "../../../components/page-header";
import { FilterPanel } from "../../../components/filter-panel";
import { FilterChip } from "../../../components/filter-chip-link";
import { DataGrid, type GridColumn } from "../../../components/data-grid";
import { NumberedPager } from "../../../components/pager";
import { StatusPill } from "../../../components/status-pill";
import { NameCell } from "../../../components/name-cell";
import { CopyId } from "../../../components/copy-id";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { RetryActions } from "../../../components/retry-actions";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { CompanyFilterBar } from "./company-filter-bar";
import { AddCompany } from "./add-company";
import { CompanyRowActions } from "./company-row-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Companies" };

/**
 * Companies — every organisation, Companies (`kind = employer`) and Agencies (`kind = agent`).
 *
 * The list is `GET /admin/companies` (#2564): one row per ORGANISATION, numbered (25 / 50 / 100),
 * with the closed kind/status/verification filters and the whole-word name, city and GSTIN
 * searches the API serves. The #2574 grid draws it; the page's metrics columns are hydrated from
 * the payer detail and payment timeline, because the company record intentionally does not carry
 * posting counts, a balance or a last payment.
 *
 * Writes are capability-gated and every one records a reason server-side: Add (T2), Archive (T3),
 * Restore (T2).
 */
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("read_entities");
  const mayReadEvents = can(session.capabilities, "read_events");
  const mayManage = can(session.capabilities, "manage_companies");

  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

  /** The address word ("company"/"agency") — never sent to the API as written. */
  const kind = companyKindFilter(one(sp.kind));
  const status = one(sp.status);
  const verification = one(sp.verification);
  const name = one(sp.name);
  const city = one(sp.city);
  const gst = one(sp.gst);
  const sort = one(sp.sort) === "oldest" ? "oldest" : "newest";
  const size = companyPageSize(one(sp.size));
  const page = companyPage(one(sp.page));

  const filters = {
    kind,
    status,
    verification,
    name,
    city,
    gst,
    sort: sort === "oldest" ? "oldest" : undefined,
    size: size === 25 ? undefined : String(size),
  };
  const filtered = Boolean(kind || status || verification || name || city || gst);

  let data: Awaited<ReturnType<typeof listCompanies>> | null = null;
  let metrics = new Map<string, CompanyMetrics>();
  let failed = false;
  let nameSearchUnavailable = false;
  let notAllowed = false;
  let refusal: ReadRefusal = null;

  // A hand-edited address can carry a status or verification value the server's strict enums
  // refuse. The page forwards it (so the refusal is the server's own answer); `filtered` tells
  // `readRefusal` that a 400 is the operator's filter rather than an outage.
  try {
    data = await listCompanies({
      kind: kind ? COMPANY_KIND_FILTER_ROLES[kind] : undefined,
      status: status as CompanyStatus | undefined,
      verification: verification as CompanyVerificationStatus | undefined,
      name,
      city,
      gst,
      sort,
      page,
      pageSize: size,
    });
    metrics = await getCompanyMetricsFor(data.items.map((item) => item.id)).catch(
      () => new Map<string, CompanyMetrics>(),
    );
  } catch (err) {
    failed = true;
    if (isAdminForbidden(err)) notAllowed = true;
    else if (isAdminUnauthorized(err)) throw err;
    else if (isAdminRequestError(err) && err.status === 503 && name) nameSearchUnavailable = true;
    // 400 from a malformed GSTIN (or an enum value a hand-edited address made up) is the
    // operator's to correct; with no filter set there is nothing the server could refuse and it
    // is an outage instead. `page` is not a cursor here, so there is no cursor refusal state.
    refusal = readRefusal(err, { filtered, cursor: undefined });
  }

  const refused = refusal !== null && refusal !== undefined;
  const filtersRefused = refusal === "filters";
  const listHref = queryHref("/companies", filters);
  const clearFilters = filtered ? (
    <Link className="btn btn--ghost" href="/companies">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
    </Link>
  ) : null;
  const clearName = name ? (
    <Link className="btn btn--ghost" href={queryHref("/companies", { ...filters, name: undefined })}>
      <Icon name={ACTION_ICON.clearFilters} />
      Clear the name filter
    </Link>
  ) : null;

  const posture = identityPosture(data?.items ?? [], "org_name", can(session.capabilities, "read_identity"));

  const columns: GridColumn<CompanyListItem>[] = [
    {
      id: "name",
      header: "Name",
      text: "truncate",
      rowHeader: true,
      cell: (row) =>
        posture === "named" ? (
          <NameCell value={row.org_name} absentTitle={NAME_UNREADABLE} />
        ) : (
          <span className="mono" title={row.id}>
            {shortId(row.id)}
          </span>
        ),
      trail: (row) => <CopyId id={row.id} label="company id" />,
      title: (row) => displayName(row.org_name) ?? row.id,
    },
    {
      id: "kind",
      header: "Kind",
      width: "short",
      cell: (row) => COMPANY_KIND_LABELS[row.kind],
    },
    {
      id: "status",
      header: "Status",
      width: "status",
      cell: (row) => (
        <StatusPill
          value={row.status}
          title={
            row.status === "suspended" && row.previous_status
              ? `Before suspension: ${row.previous_status}`
              : row.status === "archived" && row.previous_status
                ? `Restores to: ${row.previous_status}`
                : undefined
          }
        />
      ),
    },
    {
      id: "postings",
      header: "Postings",
      width: "short",
      className: "table__meta",
      cell: (row) => postingsCell(metrics.get(row.id)),
      title: (row) => {
        const m = metrics.get(row.id);
        return m?.countsLoaded
          ? `${formatCount(m.openPostings ?? 0)} open of ${formatCount(m.totalPostings ?? 0)} in all`
          : "The postings count could not be loaded.";
      },
    },
    {
      id: "balance",
      header: "Credit balance",
      width: "number",
      className: "ui-num",
      cell: (row) => {
        const m = metrics.get(row.id);
        return m?.balance === null || m?.balance === undefined ? (
          <span className="table__meta" title="The balance could not be loaded.">
            —
          </span>
        ) : (
          formatCount(m.balance)
        );
      },
    },
    {
      id: "last-payment",
      header: "Last payment",
      width: "money",
      cell: (row) => {
        const m = metrics.get(row.id);
        if (!m?.paymentsLoaded)
          return (
            <span className="table__meta" title="The payment timeline could not be loaded.">
              —
            </span>
          );
        if (!m.lastPaymentAt) return <span className="table__meta">No payment yet</span>;
        return (
          <span title={timestampTitle(m.lastPaymentAt)}>
            {formatDate(m.lastPaymentAt)}
            {m.lastPaymentInr !== null ? ` · ${formatRupees(m.lastPaymentInr)}` : ""}
          </span>
        );
      },
    },
    {
      id: "registered",
      header: "Registered",
      width: "date",
      cell: (row) => (
        <time dateTime={row.created_at} title={timestampTitle(row.created_at)}>
          {formatDate(row.created_at)}
        </time>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      width: "actions",
      cell: (row) => (
        <CompanyRowActions
          company={{
            id: row.id,
            name: displayName(row.org_name),
            status: row.status,
          }}
          mayManage={mayManage}
          mayReadEvents={mayReadEvents}
          timelineHref={mayReadEvents ? `${customerHref(row.id)}/timeline` : null}
        />
      ),
    },
  ];

  return (
    <div className="page page--list">
      <PageHeader
        title="Companies"
        description={
          posture === "faceless"
            ? "Companies and agencies, identified by id — your role does not include name access."
            : posture === "capped"
              ? "Companies and agencies, identified by id while names are withheld (see below)."
              : "Companies and agencies, named by the organisation they registered as."
        }
        info={
          <>
            <p>
              One row per organisation. Team logins are listed under their company, never as
              companies of their own.
            </p>
            <p>
              The registered name is self-declared at signup, not a verified legal name, and is
              disclosed only to a role with name access.
            </p>
          </>
        }
        primaryAction={<AddCompany canCreate={mayManage} />}
        filters={
          <>
            <div className="segmented" role="group" aria-label="Kind">
              <FilterChip selected={!kind} href={kindHref(undefined)} cursor={undefined}>
                All
              </FilterChip>
              <FilterChip
                selected={kind === "company"}
                href={kindHref("company")}
                cursor={undefined}
              >
                Companies
              </FilterChip>
              <FilterChip selected={kind === "agency"} href={kindHref("agency")} cursor={undefined}>
                Agencies
              </FilterChip>
            </div>
            <FilterPanel
              headingId="company-filter-heading"
              heading="Filter companies"
              filters={{
                kind,
                status,
                verification,
                name,
                city,
                gst,
                sort: sort === "oldest" ? "oldest" : undefined,
              }}
            >
              <CompanyFilterBar
                name={name ?? ""}
                kind={kind ?? ""}
                status={status ?? ""}
                verification={verification ?? ""}
                city={city ?? ""}
                gst={gst ?? ""}
                sort={sort === "oldest" ? "oldest" : ""}
                size={String(size)}
                nameSearchAvailable={data?.name_search_available ?? true}
              />
            </FilterPanel>
          </>
        }
      />

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see the registered name, so this is a limit on the read: this admin
          account has spent its hourly name budget.
        </IdentityCapNotice>
      )}

      <section className="panel" aria-labelledby="company-results" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="company-results">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? filtersRefused
                  ? "That filter combination was rejected."
                  : "Nothing was fetched."
                : `${data?.items.length ?? 0} compan${data?.items.length === 1 ? "y" : "ies"} on this page.`}
            </p>
          </div>
          {filtersRefused ? null : clearFilters}
        </div>

        {notAllowed ? (
          <div className="state state--error">
            <h3 className="state__title">Your role cannot read companies</h3>
            <p className="state__body">
              The admin API refused the read. That is a capability decision, not a fault in the
              filter.
            </p>
          </div>
        ) : nameSearchUnavailable ? (
          <div className="state state--error">
            <h3 className="state__title">Name search is unavailable</h3>
            <p className="state__body">
              The name index is not configured on this deployment, so nothing was fetched. Every
              other filter still works.
            </p>
            <div className="state__actions">{clearName}</div>
          </div>
        ) : refused ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected that filter</h3>
            <p className="state__body">
              One of the values is not one this portal recognises — most often a GSTIN or a
              status. Nothing was fetched. Correct the value above, or clear the filters.
            </p>
            <div className="state__actions">{clearFilters}</div>
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">Companies are unavailable</h3>
            <p className="state__body">
              The list did not load, and that is a fault on our side rather than anything in the
              filters.
            </p>
            <RetryActions href={listHref} cursor={undefined} />
          </div>
        ) : data && data.items.length > 0 ? (
          <DataGrid
            id="companies"
            caption="Companies and agencies, newest first"
            columns={columns}
            rows={data.items}
            rowKey={(row) => row.id}
            rowLink={{
              column: "name",
              href: (row) => customerHref(row.id),
              name: (row) => displayName(row.org_name) ?? `company ${shortId(row.id)}`,
              label: (row) => `Company ${shortId(row.id)}`,
            }}
            pager={
              <NumberedPager
                basePath="/companies"
                params={{
                  kind,
                  status,
                  verification,
                  name,
                  city,
                  gst,
                  sort: sort === "oldest" ? "oldest" : undefined,
                  size: size === 25 ? undefined : String(size),
                }}
                page={page}
                pageSize={size}
                total={data.total}
              />
            }
          />
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No companies match these filters</h3>
            <p className="state__body">
              Nothing matches the filters currently applied. Widen them, or clear them to see
              every company and agency.
            </p>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No companies registered yet</h3>
            <p className="state__body">
              Companies and agencies appear here when they sign up, or when an admin creates one
              with “Add company”.
            </p>
          </div>
        )}
      </section>
    </div>
  );

  function kindHref(next: CompanyKindFilter | undefined) {
    return queryHref("/companies", {
      ...filters,
      kind: next,
    });
  }
}

function postingsCell(metrics: CompanyMetrics | undefined) {
  if (!metrics?.countsLoaded) {
    return (
      <span className="table__meta" title="The postings count could not be loaded.">
        —
      </span>
    );
  }
  return `${formatCount(metrics.openPostings ?? 0)} / ${formatCount(metrics.totalPostings ?? 0)}`;
}
