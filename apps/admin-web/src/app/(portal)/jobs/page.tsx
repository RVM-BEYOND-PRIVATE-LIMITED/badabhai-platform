import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listJobPostings } from "../../../lib/entities";
import {
  isMalformedUuid,
  isUnknownValue,
  readRefusal,
  type ReadRefusal,
} from "../../../lib/read-refusal";
import { JOB_POSTING_STATUSES, JOB_POSTING_VERIFICATION_STATUSES } from "@badabhai/types";
import { queryHref } from "../../../lib/query-href";
import { formatPayBand, formatRelative, formatTimestamp } from "../../../lib/format";
import { StatusPill } from "../../../components/status-pill";
import { CustomerLink } from "../../../components/customer-link";
import { Pager } from "../../../components/pager";
import { PageHeader } from "../../../components/page-header";
import { JobFilterBar } from "./filter-bar";
import { FilterPanel } from "../../../components/filter-panel";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  CURSOR_REFUSAL,
  FirstPageAction,
  RetryActions,
} from "../../../components/retry-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Postings" };

/**
 * Postings — and, in practice, the entry point for most operational work.
 *
 * This is the only entity list with human-readable text on it (`org_label`, `role_title`,
 * `location_label`), because those are poster-typed fields already shown to every worker
 * in the feed. That makes this the screen where an operator actually FINDS things: a spam
 * or misleading posting is identifiable here, and its customer is one click away.
 * Workers, Companies and Agencies are opaque by design and are reached through here.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("read_entities");
  const mayReadEvents = can(session.capabilities, "read_events");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const status = one(sp.status);
  const verificationStatus = one(sp.verificationStatus);
  const payerId = one(sp.payerId);
  const cursor = one(sp.cursor);

  const filtered = Boolean(status || verificationStatus || payerId);

  let page: Awaited<ReturnType<typeof listJobPostings>> | null = null;
  let failed = false;
  /** A filter in the address the server could have refused (a value it does not accept). */
  const refusable =
    isUnknownValue(status, JOB_POSTING_STATUSES) ||
    isUnknownValue(verificationStatus, JOB_POSTING_VERIFICATION_STATUSES) ||
    isMalformedUuid(payerId);
  let refusal: ReadRefusal = null;
  try {
    page = await listJobPostings({ status, verificationStatus, payerId, cursor });
  } catch (err) {
    // Rendered inline either way; it does not take the screen down. A 400 is most likely a
    // malformed customer uuid — the operator's to correct. Anything else is our fault, and
    // telling them to correct a value over an outage blames a filter that is not broken.
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
  const listHref = queryHref("/jobs", { status, verificationStatus, payerId });
  /**
   * The ONE "Clear filters" on this screen (owner brief 2026-10-01): in the results head while
   * the list loads, and inside the refusal state when the server refused the filters — there it
   * is the recovery, so the head does not repeat it.
   */
  const clearFilters = filtered ? (
    <Link className="btn btn--ghost" href="/jobs">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
    </Link>
  ) : null;

  return (
    <div className="page">
      <PageHeader
        title="Postings"
        description="Every posting on the platform, with company and role text exactly as the poster typed it — the text workers see in the feed."
        filters={
          /* Folds behind a "Filters (n)" toggle on a phone (AW-08); unchanged above it. */
          <FilterPanel
            headingId="jf-heading"
            heading="Filter postings"
            filters={{ status, verificationStatus, payerId }}
          >
            <JobFilterBar
              status={status ?? ""}
              verificationStatus={verificationStatus ?? ""}
              payerId={payerId ?? ""}
            />
          </FilterPanel>
        }
      />

      <section className="panel" aria-labelledby="jr-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="jr-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? filtersRefused
                  ? "That filter combination was rejected."
                  : "Nothing was fetched."
                : `${page?.items.length ?? 0} posting${page?.items.length === 1 ? "" : "s"} on this page.`}
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
                ? "Nothing was fetched. A customer id must be a full UUID — a short id copied from a table cell will not do. Correct the value above, or clear the filters and start again."
                : CURSOR_REFUSAL.body}
            </p>
            {/* Repeating a refused request cannot succeed, so there is no Retry. The API refuses a
                page cursor only when it is longer than any it issues (a malformed one falls back
                to page one), so with a filter set the FILTER is what was refused — keeping it on
                the first page would be refused again, and the way out is Clear filters. With no
                filter, the cursor was refused: the first page. */}
            {filtersRefused ? (
              <div className="state__actions">{clearFilters}</div>
            ) : (
              <FirstPageAction href={listHref} cursor={cursor} />
            )}
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">Postings are unavailable</h3>
            <p className="state__body">
              The list did not load, and that is a fault on our side rather than anything in the
              filters.
            </p>
            {/* The SAME query — filters and cursor kept — and, past page one, the first page of
                it. Neither is "Clear filters", which the results head already offers. */}
            <RetryActions href={listHref} cursor={cursor} />
          </div>
        ) : page && page.items.length > 0 ? (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Postings, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Role title</th>
                  <th scope="col">Published as</th>
                  <th scope="col">Location</th>
                  <th scope="col">Pay</th>
                  <th scope="col">Status</th>
                  <th scope="col">Trust review</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link className="link" href={`/jobs/${j.id}`}>
                        {j.role_title}
                      </Link>
                      <span className="table__meta">{j.vacancy_band} openings</span>
                    </td>
                    <td>{j.org_label}</td>
                    <td className="table__meta">{j.city ?? j.location_label ?? "—"}</td>
                    <td className="table__meta">{formatPayBand(j.pay_min, j.pay_max)}</td>
                    <td>
                      <StatusPill value={j.status} />
                    </td>
                    <td>
                      <StatusPill value={j.verification_status} />
                    </td>
                    <td>
                      {j.payer_id ? (
                        <CustomerLink payerId={j.payer_id} payerRole={j.payer_role} />
                      ) : (
                        // No payer_id means ops created it directly — there is no customer
                        // account behind it, and saying so beats a dead link.
                        <span className="table__meta">ops-created</span>
                      )}
                    </td>
                    <td>
                      <time dateTime={j.created_at} title={formatTimestamp(j.created_at)}>
                        {formatRelative(j.created_at)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No postings match these filters</h3>
            <p className="state__body">
              Nothing matches the filters currently applied. Widen them, or clear them to
              see every posting on the platform.
            </p>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No postings created yet</h3>
            <p className="state__body">
              Postings appear here the moment a company, an agency or an operator publishes one.
              Until then there is nothing in the feed workers see either.
            </p>
            {/* `/events` is `read_events`; offered only to a reader who holds it. */}
            {mayReadEvents ? (
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/events">
                  <Icon name={ACTION_ICON.timeline} />
                  View events
                </Link>
              </div>
            ) : null}
          </div>
        )}

        <Pager
          basePath="/jobs"
          params={{ status, verificationStatus, payerId }}
          nextCursor={page?.nextCursor}
        />
      </section>
    </div>
  );
}
