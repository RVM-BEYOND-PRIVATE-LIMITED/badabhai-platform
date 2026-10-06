import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listPayers } from "../../../lib/entities";
import { isAdminRequestError } from "../../../lib/admin-http";
import { queryHref } from "../../../lib/query-href";
import { identityPosture } from "../../../lib/identity";
import { PayerList } from "../../../components/payer-list";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { Pager } from "../../../components/pager";
import { PayerFilterBar } from "../../../components/payer-filter-bar";
import { PageHeader } from "../../../components/page-header";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  CURSOR_REFUSAL,
  FirstPageAction,
  RetryActions,
} from "../../../components/retry-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Companies" };

/**
 * Companies — payer accounts with `role = employer`.
 *
 * Companies and Agencies are the same table split by role, which is why they share a list
 * component and a detail view. They are separate NAV sections because they are separate
 * operational populations: an employer hires, an agency supplies, and the questions an
 * operator asks about each are different.
 *
 * The organisation name is served behind `read_identity` since the 2026-08-18 ruling; the
 * posture is computed here and handed to the shared list, so both sections make the same
 * decision from the same rule rather than each deciding for itself.
 */
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
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof listPayers>> | null = null;
  let failed = false;
  let refused = false;
  try {
    page = await listPayers({ role: "employer", status, cursor });
  } catch (err) {
    // A REFUSED request (a 400: the address bar) and an UNAVAILABLE one (our fault) are
    // different screens — "pick a status" over an outage blames a filter that is not broken.
    failed = true;
    // A 400 is the operator's address only when the address holds something to refuse — a
    // filter, or a page cursor. With neither, it cannot be theirs: that is an outage too.
    refused = isAdminRequestError(err) && err.status === 400 && Boolean(status || cursor);
  }
  /** The current query without the cursor — what the recoveries below repeat. */
  const listHref = queryHref("/companies", { status });
  /**
   * The ONE "Clear filters" on this screen (owner brief 2026-10-01): in the results head while
   * the list loads, and inside the refusal state when the server refused the filters — there it
   * is the recovery, so the head does not repeat it.
   */
  const clearFilters = status ? (
    <Link className="btn btn--ghost" href="/companies">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
    </Link>
  ) : null;

  const posture = identityPosture(
    page?.items ?? [],
    "org_name",
    can(session.capabilities, "read_identity"),
  );

  return (
    <div className="page">
      <PageHeader
        title="Companies"
        description={
          <>
            {/* THREE-VALUED, like the detail panel's sub: "named by the organisation" directly
                above the notice saying names are withheld would contradict it. */}
            {posture === "faceless"
              ? "Companies, identified by id — your role does not include name access, so find one through its postings"
              : posture === "capped"
                ? "Companies, identified by id while names are withheld (see below)"
                : "Companies, named by the organisation they registered as — self-declared at signup, not a verified legal name"}
            ; email and phone stay encrypted at rest and are served to no one.
          </>
        }
        filters={
          <section className="panel" aria-labelledby="cf-heading">
            <h2 className="sr-only" id="cf-heading">
              Filter companies
            </h2>
            <PayerFilterBar basePath="/companies" status={status ?? ""} />
          </section>
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
                ? refused && status
                  ? "That filter was rejected."
                  : "Nothing was fetched."
                : `${page?.items.length ?? 0} compan${page?.items.length === 1 ? "y" : "ies"} on this page.`}
            </p>
          </div>
          {refused ? null : clearFilters}
        </div>

        {refused ? (
          <div className="state state--error">
            <h3 className="state__title">
              {status ? "The server rejected that filter" : CURSOR_REFUSAL.title}
            </h3>
            <p className="state__body">
              {status
                ? "That is not a customer status this portal recognises, so nothing was fetched. Pick a status from the list above, or clear the filter and start again."
                : CURSOR_REFUSAL.body}
            </p>
            {/* Repeating a refused request cannot succeed, so there is no Retry. The API refuses a
                page cursor only when it is longer than any it issues (a malformed one falls back
                to page one), so with a filter set the FILTER is what was refused — keeping it on
                the first page would be refused again, and the way out is Clear filters. With no
                filter, the cursor was refused: the first page. */}
            {status ? (
              <div className="state__actions">{clearFilters}</div>
            ) : (
              <FirstPageAction href={listHref} cursor={cursor} />
            )}
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">Companies are unavailable</h3>
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
            emptyMessage={
              status ? "No companies match this filter." : "No companies registered yet."
            }
          />
        )}

        <Pager basePath="/companies" params={{ status }} nextCursor={page?.nextCursor} />
      </section>
    </div>
  );
}
