import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listPayers } from "../../../lib/entities";
import { readRefusal } from "../../../lib/read-refusal";
import { queryHref } from "../../../lib/query-href";
import { identityPosture } from "../../../lib/identity";
import { PayerList } from "../../../components/payer-list";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { Pager } from "../../../components/pager";
import { PayerFilterBar } from "../../../components/payer-filter-bar";
import { FilterPanel } from "../../../components/filter-panel";
import { PageHeader } from "../../../components/page-header";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  CURSOR_REFUSAL,
  FirstPageAction,
  RetryActions,
} from "../../../components/retry-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agencies" };

/**
 * Agencies — payer accounts with `role = agent`.
 *
 * The same table and the same projection as Companies; the split is `role`, decided by the
 * server. Agency-specific surfaces (KYC state, the payout ledger) are NOT here: that loop
 * is launch-gated OFF behind `AGENCY_PAYOUTS_ENABLED`, and rendering a KYC panel that can
 * never be true would misrepresent what the platform currently does.
 *
 * The organisation name shown since the 2026-08-18 ruling is `payers.org_name_enc` — the name
 * the agency registered under. It is emphatically NOT `agency_kyc.account_holder_name_enc`,
 * which sits behind the same ADR-0022 gate as the payout loop above and is not this ruling's to
 * disclose.
 */
export default async function AgenciesPage({
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
    page = await listPayers({ role: "agent", status, cursor });
  } catch (err) {
    // A REFUSED request (a 400: the address bar) and an UNAVAILABLE one (our fault) are
    // different screens — "pick a status" over an outage blames a filter that is not broken.
    failed = true;
    // A 400 is the operator's address only when the address holds something to refuse — a
    // filter, or a page cursor. With neither, it cannot be theirs: that is an outage too. The
    // console's one rule, `readRefusal`.
    refused = readRefusal(err, { filtered: Boolean(status), cursor }) !== null;
  }
  /** The current query without the cursor — what the recoveries below repeat. */
  const listHref = queryHref("/agencies", { status });
  /**
   * The ONE "Clear filters" on this screen (owner brief 2026-10-01): in the results head while
   * the list loads, and inside the refusal state when the server refused the filters — there it
   * is the recovery, so the head does not repeat it.
   */
  const clearFilters = status ? (
    <Link className="btn btn--ghost" href="/agencies">
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
        title="Agencies"
        description={
          <>
            {/* THREE-VALUED, like the detail panel's sub: "named by the organisation" directly
                above the notice saying names are withheld would contradict it. */}
            {posture === "faceless"
              ? "Agencies, identified by id — your role does not include name access, so find one through its postings"
              : posture === "capped"
                ? "Agencies, identified by id while names are withheld (see below)"
                : "Agencies, named by the organisation they registered as — self-declared at signup, not a verified legal name"}
            ; email, phone and KYC details stay encrypted at rest and are served to no one.
          </>
        }
        filters={
          /* Folds behind a "Filters (n)" toggle on a phone (AW-08); unchanged above it. */
          <FilterPanel headingId="af-heading" heading="Filter agencies" filters={{ status }}>
            <PayerFilterBar basePath="/agencies" status={status ?? ""} />
          </FilterPanel>
        }
      />

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see them, so this is a limit on the read: this admin account has spent
          its hourly name budget.
        </IdentityCapNotice>
      )}

      <section className="panel" aria-labelledby="ar-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="ar-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? refused && status
                  ? "That filter was rejected."
                  : "Nothing was fetched."
                : `${page?.items.length ?? 0} agenc${page?.items.length === 1 ? "y" : "ies"} on this page.`}
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
            <h3 className="state__title">Agencies are unavailable</h3>
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
            basePath="/agencies"
            posture={posture}
            emptyMessage={
              status ? "No agencies match this filter." : "No agencies registered yet."
            }
          />
        )}

        <Pager basePath="/agencies" params={{ status }} nextCursor={page?.nextCursor} />
      </section>
    </div>
  );
}
