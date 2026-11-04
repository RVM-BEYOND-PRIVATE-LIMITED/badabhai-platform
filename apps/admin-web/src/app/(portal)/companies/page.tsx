import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listPayers } from "../../../lib/entities";
import {
  isUnknownValue,
  readRefusal,
  type ReadRefusal,
} from "../../../lib/read-refusal";
import { PAYER_STATUSES } from "../../../lib/list-filter-values";
import { queryHref } from "../../../lib/query-href";
import { identityPosture } from "../../../lib/identity";
import { PayerList } from "../../../components/payer-list";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { Pager } from "../../../components/pager";
import { PayerFilterBar } from "../../../components/payer-filter-bar";
import { FilterPanel } from "../../../components/filter-panel";
import { PageHeader } from "../../../components/page-header";
import { NavPendingCue } from "../../../components/nav-pending";
import { FilterChip } from "../../../components/filter-chip-link";
import {
  CUSTOMER_KIND_FILTER_ROLES,
  customerKindFilter,
  type CustomerKindFilter,
} from "../../../lib/customer";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  CURSOR_REFUSAL,
  FirstPageAction,
  RetryActions,
} from "../../../components/retry-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Companies" };

/**
 * Companies — every customer: Companies (`role = employer`) and Agencies (`role = agent`).
 *
 * ONE LIST WITH A KIND FILTER (A6, #2576). The two were separate sections over the same table and
 * the same API, `GET /admin/payers`; they are one Directory section now, and the Kind chips —
 * All, Companies, Agencies (`?kind=company|agency`) — set the `role` that API already takes.
 * `/agencies` redirects to `?kind=agency` (next.config.mjs). An unknown `kind` is not sent to the
 * API (the page translates it): the list shows every customer and the All chip says so.
 *
 * The organisation name is served behind `read_identity` since the 2026-08-18 ruling; the
 * posture is computed here and handed to the shared list.
 */
const KIND_WORDS: Record<
  CustomerKindFilter | "all",
  { title: string; one: string; many: string; contact: string }
> = {
  all: {
    title: "Customers",
    one: "customer",
    many: "customers",
    contact: "Email, phone and an agency's KYC details stay encrypted at rest and are served to no one.",
  },
  company: {
    title: "Companies",
    one: "company",
    many: "companies",
    contact: "Email and phone stay encrypted at rest and are served to no one.",
  },
  agency: {
    title: "Agencies",
    one: "agency",
    many: "agencies",
    contact: "Email, phone and KYC details stay encrypted at rest and are served to no one.",
  },
};
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const status = one(sp.status);
  const kind = customerKindFilter(one(sp.kind));
  const cursor = one(sp.cursor);
  const words = KIND_WORDS[kind ?? "all"];

  let page: Awaited<ReturnType<typeof listPayers>> | null = null;
  let failed = false;
  /** A filter in the address the server could have refused (a value it does not accept). */
  const refusable = isUnknownValue(status, PAYER_STATUSES);
  let refusal: ReadRefusal = null;
  try {
    page = await listPayers({
      role: kind ? CUSTOMER_KIND_FILTER_ROLES[kind] : undefined,
      status,
      cursor,
    });
  } catch (err) {
    // A REFUSED request (a 400: the address bar) and an UNAVAILABLE one (our fault) are
    // different screens — "pick a status" over an outage blames a filter that is not broken.
    failed = true;
    // A 400 is the operator's address only when the address holds something to refuse — a
    // filter, or a page cursor. With neither, it cannot be theirs: that is an outage too. The
    // console's one rule, `readRefusal` — and only a filter value the server does not accept
    // counts as refusable: a valid one beside an over-long cursor leaves the CURSOR refused.
    refusal = readRefusal(err, { filtered: refusable, cursor });
  }
  const refused = refusal !== null;
  /** The filters were refused — not the page cursor beside them. */
  const filtersRefused = refusal === "filters";
  /** The current query without the cursor — what the recoveries below repeat. */
  const listHref = queryHref("/companies", { kind, status });
  /** A Kind chip's address: its kind, the status kept, no page cursor. */
  const kindHref = (k: CustomerKindFilter | undefined) => queryHref("/companies", { kind: k, status });
  /**
   * The ONE "Clear filters" on this screen (owner brief 2026-10-01): in the results head while
   * the list loads, and inside the refusal state when the server refused the filters — there it
   * is the recovery, so the head does not repeat it.
   */
  const clearFilters = status || kind ? (
    <Link className="btn btn--ghost" href="/companies">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
      <NavPendingCue message="Clearing the filters…" />
    </Link>
  ) : null;

  const posture = identityPosture(
    page?.items ?? [],
    "org_name",
    can(session.capabilities, "read_identity"),
  );

  return (
    <div className="page page--list">
      <PageHeader
        title="Companies"
        description={
          /* THREE-VALUED, like the detail panel's sub: "named by the organisation" directly
             above the notice saying names are withheld would contradict it. */
          posture === "faceless"
            ? `${words.title}, identified by id — your role does not include name access.`
            : posture === "capped"
              ? `${words.title}, identified by id while names are withheld (see below).`
              : `${words.title}, named by the organisation they registered as.`
        }
        info={
          <>
            {posture === "faceless" ? <p>Find one through its postings.</p> : null}
            {posture === "named" ? (
              <p>The organisation name is self-declared at signup, not a verified legal name.</p>
            ) : null}
            <p>{words.contact}</p>
          </>
        }
        filters={
          <>
            {/* The Kind filter (A6): one segmented chip row, always in view — it is what the
                Companies and Agencies sections used to be. Each chip keeps the status. */}
            <div className="segmented" role="group" aria-label="Kind">
              <FilterChip selected={!kind} href={kindHref(undefined)} cursor={cursor}>
                All
              </FilterChip>
              <FilterChip selected={kind === "company"} href={kindHref("company")} cursor={cursor}>
                Companies
              </FilterChip>
              <FilterChip selected={kind === "agency"} href={kindHref("agency")} cursor={cursor}>
                Agencies
              </FilterChip>
            </div>
            {/* Folds behind a "Filters (n)" toggle on a phone (AW-08); unchanged above it. */}
            <FilterPanel headingId="cf-heading" heading="Filter customers" filters={{ status }}>
              <PayerFilterBar basePath="/companies" status={status ?? ""} kind={kind} />
            </FilterPanel>
          </>
        }
      />

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see them, so this is a limit on the read: this admin account has spent
          its hourly name budget.
        </IdentityCapNotice>
      )}

      <section className="panel" aria-labelledby="cr-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="cr-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? filtersRefused
                  ? "That filter was rejected."
                  : "Nothing was fetched."
                : `${page?.items.length ?? 0} ${page?.items.length === 1 ? words.one : words.many} on this page.`}
            </p>
          </div>
          {filtersRefused ? null : clearFilters}
        </div>

        {refused ? (
          <div className="state state--error">
            <h3 className="state__title">
              {filtersRefused ? "The server rejected that filter" : CURSOR_REFUSAL.title}
            </h3>
            <p className="state__body">
              {filtersRefused
                ? "That is not a customer status this portal recognises, so nothing was fetched. Pick a status from the list above, or clear the filter and start again."
                : CURSOR_REFUSAL.body}
            </p>
            {/* Repeating a refused request cannot succeed, so there is no Retry. With a filter
                value the server does not accept in the address, that value is what was refused —
                keeping it on the first page would be refused again, and the way out is Clear
                filters. Otherwise the page cursor was refused (the API refuses one only when it
                is longer than any it issues): the first page, filters kept. */}
            {filtersRefused ? (
              <div className="state__actions">{clearFilters}</div>
            ) : (
              <FirstPageAction href={listHref} cursor={cursor} />
            )}
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">{words.title} are unavailable</h3>
            <p className="state__body">
              The list did not load, and that is a fault on our side rather than anything in the
              filter.
            </p>
            {/* The SAME query — filter and cursor kept — and, past page one, the first page of
                it. Neither is "Clear filters", which the results head already offers. */}
            <RetryActions href={listHref} cursor={cursor} />
          </div>
        ) : (
          <PayerList
            payers={page?.items ?? []}
            basePath="/companies"
            posture={posture}
            kind={kind}
            pager={
              <Pager
                basePath="/companies"
                params={{ kind, status }}
                cursor={cursor}
                nextCursor={page?.nextCursor}
              />
            }
            emptyMessage={
              status ? `No ${words.many} match this filter.` : `No ${words.many} registered yet.`
            }
          />
        )}
      </section>
    </div>
  );
}
