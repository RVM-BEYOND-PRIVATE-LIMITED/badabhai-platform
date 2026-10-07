import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listWorkers } from "../../../lib/entities";
import { isAdminRequestError } from "../../../lib/admin-http";
import { queryHref } from "../../../lib/query-href";
import { identityPosture } from "../../../lib/identity";
import { formatRelative, formatTimestamp, shortId } from "../../../lib/format";
import { StatusPill } from "../../../components/status-pill";
import { NameCell } from "../../../components/name-cell";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { Pager } from "../../../components/pager";
import { PageHeader } from "../../../components/page-header";
import { WorkerFilterBar } from "./filter-bar";
import { FilterPanel } from "../../../components/filter-panel";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  CURSOR_REFUSAL,
  FirstPageAction,
  RetryActions,
} from "../../../components/retry-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Workers" };

/**
 * Workers — the supply-side roster.
 *
 * ── NAMES, SINCE THE 2026-08-18 RULING ──────────────────────────────────────────────────
 * A Name column is rendered to a role holding `read_identity` (super_admin / ops_admin /
 * support), and the server audits every one of those reads and charges them against an hourly
 * per-admin budget. An `analyst` is denied, and their screen is the roster exactly as it shipped
 * before the ruling — no column, no dashes, no header promising data they will never be shown.
 * Which of the three states this render is in is decided by `identityPosture`, from the rows
 * that actually arrived rather than from the capability alone.
 *
 * ── WHAT IS STILL NOT HERE, AND WHY THAT IS NOT THE SAME QUESTION ───────────────────────
 * NO phone, no photo, and — the load-bearing one — no search box of any kind. The ruling
 * reversed "the roster is anonymous"; it did not reverse "the roster is not a lookup tool". A
 * field that turns a name into a row is what makes a roster of contactable workers bulk
 * queryable by identity, and contact itself stays on the separate, reason-gated, audited,
 * single-subject `reveal_pii` path rather than becoming a column on a list.
 *
 * So this screen still answers operational questions — how many, in what state, how far through
 * profiling, who is pending deletion — and now says who each row is while doing it.
 */
export default async function WorkersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const status = one(sp.status);
  const pendingDeletion = one(sp.pendingDeletion) === "true";
  const cursor = one(sp.cursor);

  const filtered = Boolean(status) || pendingDeletion;

  let page: Awaited<ReturnType<typeof listWorkers>> | null = null;
  let failed = false;
  let refused = false;
  try {
    page = await listWorkers({ status, pendingDeletion: pendingDeletion || undefined, cursor });
  } catch (err) {
    // Rendered inline either way, rather than tripping the error boundary and losing the whole
    // screen. But a REFUSED request (a 400: something in the address bar) and an UNAVAILABLE one
    // (anything else: our fault) are different screens — "check your filters" over an outage
    // sends the operator to fix filters that are not broken, or not even set.
    failed = true;
    // A 400 is the operator's address only when the address holds something to refuse — a
    // filter, or a page cursor. With neither, it cannot be theirs: that is an outage too.
    refused = isAdminRequestError(err) && err.status === 400 && Boolean(filtered || cursor);
  }

  /** The current query without the cursor — what the recoveries below repeat. */
  const listHref = queryHref("/workers", {
    status,
    pendingDeletion: pendingDeletion ? "true" : undefined,
  });
  /**
   * The ONE "Clear filters" on this screen (owner brief 2026-10-01): in the results head while
   * the list loads, and inside the refusal state when the server refused the filters — there it
   * is the recovery, so the head does not repeat it.
   */
  const clearFilters = filtered ? (
    <Link className="btn btn--ghost" href="/workers">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
    </Link>
  ) : null;
  const mayReadEvents = can(session.capabilities, "read_events");

  const posture = identityPosture(
    page?.items ?? [],
    "full_name",
    can(session.capabilities, "read_identity"),
  );

  return (
    <div className="page">
      <PageHeader
        title="Workers"
        description={
          <>
            {/* THREE-VALUED, like the detail page's panel subs: "names are shown" directly
                above the notice saying they are withheld would contradict it. */}
            {posture === "faceless"
              ? "Workers are identified by id here — your role does not include name access"
              : posture === "capped"
                ? "Workers are identified by id while names are withheld (see below)"
                : "Names are shown to your role, and each name read is capped and audited"}
            ; contact details are never listed, and revealing one worker&apos;s contact is a
            separate, reason-gated action.
          </>
        }
        filters={
          /* Folds behind a "Filters (n)" toggle on a phone (AW-08); unchanged above it. */
          <FilterPanel
            headingId="wf-heading"
            heading="Filter workers"
            filters={{ status, pendingDeletion }}
          >
            <WorkerFilterBar status={status ?? ""} pendingDeletion={pendingDeletion} />
          </FilterPanel>
        }
      />

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see them, so this is a limit on the read: this admin account has spent
          its hourly name budget.
        </IdentityCapNotice>
      )}

      <section className="panel" aria-labelledby="wr-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="wr-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? refused && filtered
                  ? "That filter combination was rejected."
                  : "Nothing was fetched."
                : `${page?.items.length ?? 0} worker${page?.items.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {refused ? null : clearFilters}
        </div>

        {refused ? (
          <div className="state state--error">
            <h3 className="state__title">
              {filtered ? "The server rejected these filters" : CURSOR_REFUSAL.title}
            </h3>
            <p className="state__body">
              {filtered
                ? "One of the values is not a worker status this portal recognises, so nothing was fetched. Check the values in the filter bar above, or clear them and start again."
                : CURSOR_REFUSAL.body}
            </p>
            {/* Repeating a refused request cannot succeed, so there is no Retry. The API refuses a
                page cursor only when it is longer than any it issues (a malformed one falls back
                to page one), so with a filter set the FILTER is what was refused — keeping it on
                the first page would be refused again, and the way out is Clear filters. With no
                filter, the cursor was refused: the first page. */}
            {filtered ? (
              <div className="state__actions">{clearFilters}</div>
            ) : (
              <FirstPageAction href={listHref} cursor={cursor} />
            )}
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">Workers are unavailable</h3>
            <p className="state__body">
              The roster did not load, and that is a fault on our side rather than anything in
              the filters.
            </p>
            {/* The SAME query — filters and cursor kept — and, past page one, the first page of
                it. Neither is "Clear filters", which the results head already offers. */}
            <RetryActions href={listHref} cursor={cursor} />
          </div>
        ) : page && page.items.length > 0 ? (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Workers, newest first</caption>
              <thead>
                <tr>
                  {/* Only in the `named` posture. A Name heading over dashes would state that
                      these workers have no name on record, which is what a dash MEANS here. */}
                  {posture === "named" && <th scope="col">Name</th>}
                  <th scope="col">Worker</th>
                  <th scope="col">Status</th>
                  <th scope="col">Language</th>
                  <th scope="col">Resume prefs</th>
                  <th scope="col">Deletion</th>
                  <th scope="col">Registered</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((w) => (
                  <tr key={w.id}>
                    {posture === "named" && (
                      <td>
                        <NameCell value={w.full_name} />
                      </td>
                    )}
                    {/* The id column stays even when a name is beside it: it is the join key
                        onto the audit spine, the value an operator copies into a query, and
                        the only stable handle for a worker who has never given us a name. */}
                    <td>
                      <Link className="link mono" href={`/workers/${w.id}`} title={w.id}>
                        {shortId(w.id)}
                      </Link>
                    </td>
                    <td>
                      <StatusPill value={w.status} />
                    </td>
                    <td>{w.preferred_language ?? "—"}</td>
                    <td className="table__meta">
                      {w.has_photo ? "photo" : "no photo"}
                      {w.resume_night_shift_ready ? " · night shift" : ""}
                    </td>
                    <td>
                      {w.deletion_scheduled_at ? (
                        // A scheduled hard delete is the highest-urgency thing on this row:
                        // it is reversible, but only until it runs.
                        <span
                          className="pill pill--bad"
                          title={`Hard delete due ${formatTimestamp(w.deletion_scheduled_at)}`}
                        >
                          due {formatRelative(w.deletion_scheduled_at)}
                        </span>
                      ) : (
                        <span className="table__meta">—</span>
                      )}
                    </td>
                    <td>
                      <time dateTime={w.created_at} title={formatTimestamp(w.created_at)}>
                        {formatRelative(w.created_at)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No workers match these filters</h3>
            <p className="state__body">
              Nobody on the roster is in this state right now. Widen the filter, or clear it
              to see every registered worker.
            </p>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No workers registered yet</h3>
            <p className="state__body">
              Workers appear here as soon as they finish signing up in the app. Until one
              does, the events log is where you confirm the sign-up path is running at all.
            </p>
            {/* Only for a reader who may open the events log — /events is `read_events`, and
                this page is `read_entities`. An affordance; the route keeps its own gate. */}
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
          basePath="/workers"
          params={{ status, pendingDeletion: pendingDeletion ? "true" : undefined }}
          nextCursor={page?.nextCursor}
        />
      </section>
    </div>
  );
}
