import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { listWorkers, type WorkerListItem } from "../../../lib/entities";
import {
  isUnknownValue,
  readRefusal,
  type ReadRefusal,
} from "../../../lib/read-refusal";
import { WORKER_STATUSES } from "@badabhai/types";
import { queryHref } from "../../../lib/query-href";
import { displayName, identityPosture } from "../../../lib/identity";
import { formatRelative, shortId, timestampTitle } from "../../../lib/format";
import { CopyId } from "../../../components/copy-id";
import { StatusPill } from "../../../components/status-pill";
import { NameCell } from "../../../components/name-cell";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { Pager } from "../../../components/pager";
import { PageHeader } from "../../../components/page-header";
import { DataGrid, type GridColumn } from "../../../components/data-grid";
import { NavPendingCue } from "../../../components/nav-pending";
import { WorkerFilterBar } from "./filter-bar";
import { FilterPanel } from "../../../components/filter-panel";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  CURSOR_REFUSAL,
  FirstPageAction,
  RetryActions,
} from "../../../components/retry-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Candidates" };

/**
 * Candidates — the supply-side roster: every registered worker (Directory, A6 #2576 — the
 * section was "Workers"; `/workers/*` redirects here). A7 (#2577) rebuilds this screen on the
 * candidate data bank; until then it is the worker roster as it was, under its new name.
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
export default async function CandidatesPage({
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
  /** A filter in the address the server could have refused (a value it does not accept). */
  const refusable = isUnknownValue(status, WORKER_STATUSES);
  let refusal: ReadRefusal = null;
  try {
    page = await listWorkers({ status, pendingDeletion: pendingDeletion || undefined, cursor });
  } catch (err) {
    // Rendered inline either way, rather than tripping the error boundary and losing the whole
    // screen. But a REFUSED request (a 400: something in the address bar) and an UNAVAILABLE one
    // (anything else: our fault) are different screens — "check your filters" over an outage
    // sends the operator to fix filters that are not broken, or not even set.
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
  const listHref = queryHref("/candidates", {
    status,
    pendingDeletion: pendingDeletion ? "true" : undefined,
  });
  /**
   * The ONE "Clear filters" on this screen (owner brief 2026-10-01): in the results head while
   * the list loads, and inside the refusal state when the server refused the filters — there it
   * is the recovery, so the head does not repeat it.
   */
  const clearFilters = filtered ? (
    <Link className="btn btn--ghost" href="/candidates">
      <Icon name={ACTION_ICON.clearFilters} />
      Clear filters
      <NavPendingCue message="Clearing the filters…" />
    </Link>
  ) : null;
  const mayReadEvents = can(session.capabilities, "read_events");

  const posture = identityPosture(
    page?.items ?? [],
    "full_name",
    can(session.capabilities, "read_identity"),
  );
  const named = posture === "named";

  /**
   * The roster's columns (A4, #2574). The row's link is its NAME — in the `named` posture the Name
   * column, otherwise the id, which is then the only handle the row has. Only in the `named`
   * posture is there a Name column at all: a Name heading over dashes would state that these
   * workers have no name on record, which is what a dash MEANS here.
   */
  const columns: GridColumn<WorkerListItem>[] = [
    ...(named
      ? [
          {
            id: "name",
            header: "Name",
            cell: (w: WorkerListItem) => <NameCell value={w.full_name} />,
            title: (w: WorkerListItem) => displayName(w.full_name) ?? undefined,
          },
        ]
      : []),
    /* The id column stays even when a name is beside it: it is the join key onto the audit
       spine, the value an operator copies into a query, and the only stable handle for a worker
       who has never given us a name. */
    {
      id: "worker",
      header: "Worker",
      width: "id",
      cell: (w) =>
        named ? (
          <span className="mono" title={w.id}>
            {shortId(w.id)}
          </span>
        ) : (
          <span className="mono">{shortId(w.id)}</span>
        ),
      title: named ? undefined : (w) => w.id,
      trail: (w) => <CopyId id={w.id} label="worker id" />,
    },
    { id: "status", header: "Status", width: "status", cell: (w) => <StatusPill value={w.status} /> },
    {
      id: "language",
      header: "Language",
      // A language code ("hi", "mr"): the narrow kind, cut (with its title) if one is ever longer.
      width: "number",
      text: "truncate",
      cell: (w) => w.preferred_language ?? "—",
      title: (w) => w.preferred_language ?? undefined,
    },
    {
      id: "resume",
      header: "Resume prefs",
      width: "short",
      text: "truncate",
      className: "table__meta",
      cell: (w) => resumePrefs(w),
      title: (w) => resumePrefs(w),
    },
    {
      id: "deletion",
      header: "Deletion",
      width: "short",
      cell: (w) =>
        w.deletion_scheduled_at ? (
          // A scheduled hard delete is the highest-urgency thing on this row: it is reversible,
          // but only until it runs.
          <span
            className="pill pill--bad"
            title={`Hard delete due ${timestampTitle(w.deletion_scheduled_at)}`}
          >
            due {formatRelative(w.deletion_scheduled_at)}
          </span>
        ) : (
          <span className="table__meta">—</span>
        ),
    },
    {
      id: "registered",
      header: "Registered",
      width: "date",
      cell: (w) => (
        <time dateTime={w.created_at} title={timestampTitle(w.created_at)}>
          {formatRelative(w.created_at)}
        </time>
      ),
    },
  ];

  return (
    <div className="page page--list">
      <PageHeader
        title="Candidates"
        description={
          /* THREE-VALUED, like the detail page's panel subs: "names are shown" directly above
             the notice saying they are withheld would contradict it. */
          posture === "faceless"
            ? "Candidates, identified by id — your role does not include name access."
            : posture === "capped"
              ? "Candidates, identified by id while names are withheld (see below)."
              : "Names are shown to your role, and each name read is capped and audited."
        }
        info={
          <p>
            Contact details are never listed, and revealing one worker&apos;s contact is a
            separate, reason-gated action.
          </p>
        }
        filters={
          /* Folds behind a "Filters (n)" toggle on a phone (AW-08); unchanged above it. */
          <FilterPanel
            headingId="wf-heading"
            heading="Filter candidates"
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
                ? filtersRefused
                  ? "That filter combination was rejected."
                  : "Nothing was fetched."
                : `${page?.items.length ?? 0} worker${page?.items.length === 1 ? "" : "s"} on this page.`}
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
                ? "One of the values is not a worker status this portal recognises, so nothing was fetched. Check the values in the filter bar above, or clear them and start again."
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
          <DataGrid
            id="workers"
            caption="Workers, newest first"
            columns={columns}
            rows={page.items}
            rowKey={(w) => w.id}
            rowLink={{
              column: named ? "name" : "worker",
              href: (w) => `/candidates/${w.id}`,
              name: (w) =>
                (named ? displayName(w.full_name) : null) ?? `worker ${shortId(w.id)}`,
              // A dash says "no name on record"; as a link's whole name it would say nothing.
              label: (w) =>
                named && displayName(w.full_name) === null
                  ? `Worker ${shortId(w.id)}, no name on record`
                  : undefined,
            }}
            pager={
              <Pager
                basePath="/candidates"
                params={{ status, pendingDeletion: pendingDeletion ? "true" : undefined }}
                cursor={cursor}
                nextCursor={page.nextCursor}
              />
            }
          />
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
      </section>
    </div>
  );
}

/** The worker's resume preferences in a few words: "no photo · night shift". */
function resumePrefs(w: WorkerListItem): string {
  return `${w.has_photo ? "photo" : "no photo"}${w.resume_night_shift_ready ? " · night shift" : ""}`;
}
