"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { PageHeader } from "../../../components/page-header";
import { DataGrid, type GridColumn, type GridSort } from "../../../components/data-grid";
import { NumberedPager } from "../../../components/pager";
import { StatusPill, statusLabel } from "../../../components/status-pill";
import { NameCell } from "../../../components/name-cell";
import { CopyId } from "../../../components/copy-id";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { displayName, identityPosture } from "../../../lib/identity";
import {
  formatCount,
  formatPayBand,
  formatRelative,
  shortId,
  timestampTitle,
} from "../../../lib/format";
import {
  CANDIDATE_SORT_COLUMNS,
  CANDIDATE_PAGE_SIZES,
  candidateViewHref,
  candidateViewParams,
  hasCandidateFilters,
  nextCandidateSort,
  parseCandidateQuery,
  type CandidatePageSize,
  type CandidateRow,
  type CandidateSearchQuery,
  type CandidateSearchResponse,
  type CandidateSearchSort,
} from "../../../lib/candidate-search-model";
import { fetchCandidateSearch } from "../../../lib/candidate-search-client";
import {
  SAVED_VIEWS_KEY,
  newSavedViewId,
  parseSavedViews,
  removeSavedView,
  saveCandidateView,
  type SavedCandidateView,
} from "../../../lib/candidate-saved-views";
import { candidateIdTitle } from "../../../lib/candidate-view";
import { CANDIDATE_PARAM, type DrawerRow } from "./candidate-drawer-model";
import { CandidateDrawer, type InitialCandidateRecord } from "./candidate-drawer";
import { CandidateSearchBar } from "./candidate-search-bar";
import { CandidateFilters } from "./candidate-filters";
import { CandidateSavedViews } from "./candidate-saved-views";

/**
 * THE CANDIDATES DATA BANK (A7, #2577) — the client half of the screen.
 *
 * The server renders the capability gate and the drawer's initial record; this component owns
 * the LIST, because the universal term is body-only: a page navigation would put it in the
 * address, while a `POST /candidates/search` from the browser keeps it out of every URL (ADR-0062
 * §3.6). Every filter, order and page is also mirrored into the address with
 * `history.replaceState` — shallow, so the server list is not re-read and the open drawer
 * survives — which is what makes a view linkable and reloadable.
 *
 * The first read shows SKELETON rows; every later read dims the rows already on screen and runs
 * a progress line under the header, never replacing them with a skeleton. Empty, refused, capped,
 * ended-session and outage states each say what happened and offer the one useful way out.
 */
export function CandidatesBank({
  initialParams,
  initialRecord,
  entitled,
  canReveal,
  canEdit,
  canReadEvents = false,
  canManageAccount = false,
}: {
  /** The address's parameters, read on the server so the first client render matches it. */
  initialParams: Record<string, string>;
  /** The record the page read for `?c=` (a reload, a shared drawer link). */
  initialRecord: InitialCandidateRecord | null;
  /** The session holds `read_identity`. */
  entitled: boolean;
  /** The session holds `reveal_pii`. */
  canReveal: boolean;
  /** The session holds `edit_candidates`. */
  canEdit: boolean;
  /** The session holds `read_events` — the empty state may offer the whole log. */
  canReadEvents?: boolean;
  /** The session holds `manage_worker_account` (sign out, PIN reset, suspend/unsuspend). */
  canManageAccount?: boolean;
}) {
  const [query, setQuery] = useState<CandidateSearchQuery>(() =>
    parseCandidateQuery(new URLSearchParams(initialParams)),
  );
  const [result, setResult] = useState<CandidateSearchResponse | null>(null);
  const [error, setError] = useState<{
    reason: "refused" | "limited" | "forbidden" | "signed_out" | "error";
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [views, setViews] = useState<SavedCandidateView[]>([]);
  const requestSeq = useRef(0);

  // The reader's saved views, parsed defensively. A storage-disabled browser simply starts empty.
  useEffect(() => {
    try {
      setViews(parseSavedViews(window.localStorage.getItem(SAVED_VIEWS_KEY)));
    } catch {
      setViews([]);
    }
  }, []);

  function persistViews(next: SavedCandidateView[]) {
    setViews(next);
    try {
      window.localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(next));
    } catch {
      // Disabled or full: the views live in memory for this page's life.
    }
  }

  // Every read of the list — a term, a filter, a sort, a page, a retry.
  useEffect(() => {
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    fetchCandidateSearch(query, controller.signal).then(
      (outcome) => {
        if (seq !== requestSeq.current) return;
        if (outcome.ok) {
          setResult(outcome.data);
          setFirstLoad(false);
        } else {
          setError({ reason: outcome.reason, message: outcome.error });
          setFirstLoad(false);
        }
        setBusy(false);
      },
      () => {
        /* aborted: a newer query is already on its way */
      },
    );
    return () => controller.abort();
  }, [query, attempt]);

  // Keep the address in step with the view — never the term (body-only), always the drawer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const open = new URLSearchParams(window.location.search).get(CANDIDATE_PARAM);
    const href = candidateViewHref(query, { [CANDIDATE_PARAM]: open ?? undefined });
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== href) window.history.replaceState(window.history.state, "", href);
    // `q` is deliberately absent: it never enters the URL.
  }, [query.filters, query.sort, query.dir, query.page, query.page_size]);

  // Back/Forward to another filter entry (a full navigation, not our replace) updates the view.
  // Closing the drawer pops to the same filters and changes nothing, so no list read happens.
  useEffect(() => {
    function onPop() {
      const parsed = parseCandidateQuery(window.location.search);
      setQuery((current) => (sameView(current, parsed) ? current : { ...parsed, q: current.q }));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const rows = result?.candidates ?? [];
  const posture = identityPosture(rows, "name", entitled);
  const named = posture === "named";
  const filtered = hasCandidateFilters(query.filters) || Boolean(query.q);

  function applySearch(q: string) {
    setQuery((current) => (current.q === q ? current : { ...current, q, page: 1 }));
  }

  function applyFilters(filters: CandidateSearchQuery["filters"]) {
    setQuery((current) => ({ ...current, filters, page: 1 }));
  }

  function applySort(column: CandidateSearchSort) {
    setQuery((current) => ({ ...current, ...nextCandidateSort(current, column), page: 1 }));
  }

  function clearAll() {
    setQuery((current) => ({ ...current, q: "", filters: {}, page: 1 }));
  }

  function applyView(view: SavedCandidateView) {
    setQuery((current) => ({
      ...current,
      q: view.q ?? "",
      filters: view.filters,
      sort: view.sort,
      dir: view.dir,
      page_size: view.page_size,
      page: 1,
    }));
  }

  function saveView(name: string) {
    const view = {
      id: newSavedViewId(),
      name,
      saved_at: new Date().toISOString(),
      ...(query.q ? { q: query.q } : {}),
      filters: query.filters,
      sort: query.sort,
      dir: query.dir,
      page_size: query.page_size,
    };
    persistViews(saveCandidateView(views, view));
  }

  const columns = bankColumns(query, named, applySort);
  const drawerRows: DrawerRow[] = drawerRowsFor(rows, named);

  const title = result ? (
    <>
      Candidates <span className="bank-total">· {formatCount(result.total)}</span>
    </>
  ) : (
    "Candidates"
  );

  return (
    <div className="bank">
      <PageHeader
        title={title}
        description={
          posture === "faceless"
            ? "Candidates, identified by id — your role does not include name access."
            : posture === "capped"
              ? "Candidates, identified by id while names are withheld (see below)."
              : "Names are shown to your role, and each name read is capped and audited."
        }
        info={
          <p>
            Search, filters, order and page live in the address. The search term is sent only in the
            request body, so it never appears in a URL or a log line. Contact details are never
            listed; revealing one worker&apos;s contact is a separate, reason-gated action.
          </p>
        }
        secondaryActions={
          <CandidateSavedViews
            query={query}
            views={views}
            onApply={applyView}
            onSave={saveView}
            onRemove={(id) => persistViews(removeSavedView(views, id))}
          />
        }
        filters={
          <>
            <CandidateSearchBar value={query.q ?? ""} onSearch={applySearch} />
            <CandidateFilters
              filters={query.filters}
              counts={result?.counts}
              onApply={applyFilters}
            />
          </>
        }
      />

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see them, so this is a limit on the read: this admin account has spent its
          hourly name budget.
        </IdentityCapNotice>
      )}

      <section className="panel bank__panel" aria-labelledby="bank-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="bank-heading">
              Results
            </h2>
            <p className="panel__sub">
              {result
                ? `${formatCount(result.total)} candidate${result.total === 1 ? "" : "s"}${
                    query.q ? ` matching “${query.q}”` : ""
                  }${filtered && !query.q ? " under these filters" : ""}.`
                : busy
                  ? "Reading the data bank…"
                  : "Nothing was fetched."}
            </p>
          </div>
          {filtered ? (
            <button type="button" className="btn btn--ghost" onClick={clearAll}>
              <Icon name={ACTION_ICON.clearFilters} />
              Clear filters
            </button>
          ) : null}
        </div>

        {error ? (
          <BankError error={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : firstLoad && busy ? (
          <CandidateGridSkeleton
            headers={columns.filter((c) => !c.defaultHidden).map((c) => c.header)}
          />
        ) : !result ? (
          <CandidateGridSkeleton
            headers={columns.filter((c) => !c.defaultHidden).map((c) => c.header)}
          />
        ) : result.candidates.length === 0 ? (
          <BankEmpty
            total={result.total}
            filtered={filtered}
            canReadEvents={canReadEvents}
            onFirstPage={() => setQuery((current) => ({ ...current, page: 1 }))}
          />
        ) : (
          <div
            className={busy ? "bank__results bank__results--busy" : "bank__results"}
            aria-busy={busy ? true : undefined}
          >
            {busy ? (
              <div className="bank__progress" role="progressbar" aria-label="Loading candidates" />
            ) : null}
            <DataGrid
              id="candidates"
              caption={`Candidates${named ? ", names shown" : ", identified by id"}${
                query.q ? `, matching the search` : ""
              }`}
              columns={columns}
              rows={result.candidates}
              rowKey={(row) => row.worker_id}
              rowLink={{
                column: named ? "name" : "worker",
                href: (row) => candidateViewHref(query, { [CANDIDATE_PARAM]: row.worker_id }),
                drawer: CANDIDATE_PARAM,
                name: (row) =>
                  (named ? displayName(row.name) : null) ?? `worker ${shortId(row.worker_id)}`,
                label: (row) =>
                  named && displayName(row.name) === null
                    ? `Worker ${shortId(row.worker_id)}, no name on record`
                    : undefined,
              }}
              pager={
                <div className="bank__pager">
                  <NumberedPager
                    basePath="/candidates"
                    params={candidateViewParams(query)}
                    page={result.page}
                    pageSize={result.page_size}
                    total={result.total}
                    onSelectPage={(page) => setQuery((current) => ({ ...current, page }))}
                  />
                  <label className="bank__pagesize">
                    <span className="field__label">Rows per page</span>
                    <select
                      className="field__input"
                      value={query.page_size}
                      onChange={(e) =>
                        setQuery((current) => ({
                          ...current,
                          page_size: Number(e.target.value) as CandidatePageSize,
                          page: 1,
                        }))
                      }
                    >
                      {CANDIDATE_PAGE_SIZES.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              }
            />
          </div>
        )}
      </section>

      <CandidateDrawer
        rows={drawerRows}
        initial={initialRecord}
        entitled={entitled}
        canReveal={canReveal}
        canEdit={canEdit}
        canManageAccount={canManageAccount}
        onChanged={() => setAttempt((n) => n + 1)}
      />
    </div>
  );
}

/** Do two views describe the same list? The term is NOT part of the address, so it is not here. */
function sameView(a: CandidateSearchQuery, b: CandidateSearchQuery): boolean {
  return (
    JSON.stringify(candidateViewParams(a)) === JSON.stringify(candidateViewParams(b)) &&
    a.page === b.page
  );
}

// ---------------------------------------------------------------------------
// columns
// ---------------------------------------------------------------------------

/**
 * The rows the drawer moves through (A7, #2577), in the list's order, each titled as the list
 * names it — the name in the `named` posture, the short id otherwise.
 */
export function drawerRowsFor(rows: readonly CandidateRow[], named: boolean): DrawerRow[] {
  return rows.map((row) => ({
    id: row.worker_id,
    title: (named ? displayName(row.name) : null) ?? candidateIdTitle(row.worker_id),
  }));
}

/** A sortable header wired to the client list rather than a navigation. */
function sortHeader(
  query: CandidateSearchQuery,
  column: CandidateSearchSort,
  apply: (column: CandidateSearchSort) => void,
): GridSort {
  const active = query.sort === column;
  const next = nextCandidateSort(query, column);
  return {
    href: candidateViewHref({ ...query, sort: next.sort, dir: next.dir, page: 1 }),
    direction: active ? (query.dir === "asc" ? "ascending" : "descending") : undefined,
    label: active
      ? query.dir === "asc"
        ? "sorted ascending; click for descending"
        : "sorted descending; click for ascending"
      : CANDIDATE_SORT_COLUMNS[column].label,
    onSelect: () => apply(column),
  };
}

function relative(iso: string | null): ReactNode {
  if (iso === null) return <span className="table__meta">—</span>;
  return (
    <time dateTime={iso} title={timestampTitle(iso)}>
      {formatRelative(iso)}
    </time>
  );
}

function years(value: string | null): string | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? `${n} ${n === 1 ? "yr" : "yrs"}` : value;
}

function months(value: number | null): string | null {
  if (value === null) return null;
  const yearsPart = Math.floor(value / 12);
  const rest = value % 12;
  if (yearsPart === 0) return `${rest} mo`;
  return rest === 0 ? `${yearsPart} yr` : `${yearsPart} yr ${rest} mo`;
}

function money(value: string | number | null): string | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? formatCount(Math.round(n)) : String(value);
}

function salaryBand(row: CandidateRow): string | null {
  const min = row.salary_min_inr === null ? null : Number(row.salary_min_inr);
  const max = row.salary_max_inr === null ? null : Number(row.salary_max_inr);
  if (min === null && max === null) return null;
  return formatPayBand(Number.isFinite(min!) ? min : null, Number.isFinite(max!) ? max : null);
}

function textCell(value: string | null): ReactNode {
  return value === null || value.trim() === "" ? <span className="table__meta">—</span> : value;
}

/**
 * The data bank's columns. The default ten are the issue's list; the rest are a chooser away,
 * grouped Identity / Work / Activity / Account exactly as #2577 asks.
 */
export function bankColumns(
  query: CandidateSearchQuery,
  named: boolean,
  applySort: (column: CandidateSearchSort) => void,
): GridColumn<CandidateRow>[] {
  const sort = (column: CandidateSearchSort) => sortHeader(query, column, applySort);
  return [
    ...(named
      ? [
          {
            id: "name",
            header: "Name",
            group: "Identity",
            cell: (row: CandidateRow) => <NameCell value={row.name} />,
            title: (row: CandidateRow) => displayName(row.name) ?? undefined,
          } satisfies GridColumn<CandidateRow>,
        ]
      : []),
    {
      id: "worker",
      header: named ? "ID" : "Candidate",
      width: "id",
      group: "Identity",
      cell: (row) => (
        <span className="mono" title={row.worker_id}>
          {shortId(row.worker_id)}
        </span>
      ),
      title: (row) => (named ? undefined : row.worker_id),
      trail: (row) => <CopyId id={row.worker_id} label="candidate id" />,
    },
    {
      id: "trade",
      header: "Trade",
      width: "short",
      text: "truncate",
      group: "Work",
      sort: sort("trade_label"),
      cell: (row) => textCell(row.trade_label ?? row.domain_label),
      title: (row) => row.role_label ?? undefined,
    },
    {
      id: "experience",
      header: "Experience",
      width: "number",
      group: "Work",
      sort: sort("total_experience_years"),
      cell: (row) => years(row.total_experience_years) ?? <span className="table__meta">—</span>,
    },
    {
      id: "city",
      header: "City",
      width: "short",
      group: "Identity",
      sort: sort("current_city"),
      cell: (row) => textCell(row.current_city),
      title: (row) => row.current_state ?? undefined,
    },
    {
      id: "status",
      header: "Status",
      width: "status",
      group: "Account",
      sort: sort("status"),
      cell: (row) =>
        row.status ? <StatusPill value={row.status} /> : <span className="table__meta">—</span>,
    },
    {
      id: "profile",
      header: "Profile",
      width: "short",
      group: "Activity",
      sort: sort("profile_status"),
      cell: (row) =>
        row.profile_status ? (
          <span title={row.profile_source ? `Made by ${row.profile_source}` : undefined}>
            {statusLabel(row.profile_status)}
          </span>
        ) : (
          <span className="table__meta">—</span>
        ),
    },
    {
      id: "resume",
      header: "Resume",
      width: "number",
      group: "Activity",
      sort: sort("resume_count"),
      cell: (row) =>
        row.resume_count === 0 ? (
          <span className="table__meta">None</span>
        ) : (
          <span
            title={`${row.resume_count} version${row.resume_count === 1 ? "" : "s"}${
              row.latest_resume_status ? ` · ${row.latest_resume_status}` : ""
            }`}
          >
            {row.latest_resume_version ? `v${row.latest_resume_version}` : `${row.resume_count}`}
          </span>
        ),
    },
    {
      id: "lastActive",
      header: "Last active",
      width: "date",
      group: "Activity",
      sort: sort("last_active_at"),
      cell: (row) => relative(row.last_active_at),
    },
    {
      id: "registered",
      header: "Registered",
      width: "date",
      group: "Activity",
      sort: sort("created_at"),
      cell: (row) => relative(row.created_at),
    },

    // ---- the rest of the record, hidden until the chooser reveals it --------------------
    {
      id: "state",
      header: "State",
      width: "short",
      group: "Identity",
      defaultHidden: true,
      sort: sort("current_state"),
      cell: (row) => textCell(row.current_state),
    },
    {
      id: "role",
      header: "Role",
      width: "short",
      group: "Work",
      defaultHidden: true,
      sort: sort("role_label"),
      cell: (row) => textCell(row.role_label),
    },
    {
      id: "domain",
      header: "Domain",
      width: "short",
      group: "Work",
      defaultHidden: true,
      sort: sort("domain_label"),
      cell: (row) => textCell(row.domain_label),
    },
    {
      id: "roleMonths",
      header: "Role experience",
      width: "number",
      group: "Work",
      defaultHidden: true,
      sort: sort("role_experience_months"),
      cell: (row) => months(row.role_experience_months) ?? <span className="table__meta">—</span>,
    },
    {
      id: "salary",
      header: "Expected pay",
      width: "money",
      group: "Work",
      defaultHidden: true,
      sort: sort("salary_min_inr"),
      cell: (row) => salaryBand(row) ?? <span className="table__meta">—</span>,
      title: (row) => row.salary_period ?? undefined,
    },
    {
      id: "availability",
      header: "Availability",
      width: "short",
      group: "Work",
      defaultHidden: true,
      sort: sort("availability_status"),
      cell: (row) => textCell(row.availability_status),
    },
    {
      id: "shift",
      header: "Shift",
      width: "short",
      group: "Work",
      defaultHidden: true,
      sort: sort("shift_preference"),
      cell: (row) => textCell(row.shift_preference),
    },
    {
      id: "formLevel",
      header: "Form level",
      width: "short",
      group: "Work",
      defaultHidden: true,
      sort: sort("form_level"),
      cell: (row) => textCell(row.form_level),
    },
    {
      id: "education",
      header: "Education",
      width: "short",
      group: "Work",
      defaultHidden: true,
      sort: sort("education_level"),
      cell: (row) => textCell(row.education_level),
    },
    {
      id: "skills",
      header: "Skills",
      group: "Identity",
      defaultHidden: true,
      cell: (row) =>
        row.skills.length > 0 ? row.skills.join(", ") : <span className="table__meta">—</span>,
      title: (row) => (row.skills.length > 0 ? row.skills.join(", ") : undefined),
    },
    {
      id: "languages",
      header: "Languages",
      width: "short",
      group: "Identity",
      defaultHidden: true,
      cell: (row) =>
        row.languages.length > 0 ? (
          row.languages.join(", ")
        ) : (
          <span className="table__meta">—</span>
        ),
    },
    {
      id: "aiCost",
      header: "AI cost",
      width: "money",
      group: "Activity",
      defaultHidden: true,
      sort: sort("ai_cost_inr"),
      cell: (row) => `₹${money(row.ai_cost_inr) ?? "0"}`,
    },
    {
      id: "referral",
      header: "Referral",
      width: "short",
      group: "Activity",
      defaultHidden: true,
      cell: (row) => textCell(row.referral_source),
    },
    {
      id: "updated",
      header: "Last updated",
      width: "date",
      group: "Activity",
      defaultHidden: true,
      sort: sort("updated_at"),
      cell: (row) => relative(row.updated_at),
    },
    {
      id: "flagged",
      header: "Flagged",
      width: "short",
      group: "Account",
      defaultHidden: true,
      cell: (row) => (row.flagged ? "Yes" : "No"),
    },
    {
      id: "deletion",
      header: "Deletion",
      width: "date",
      group: "Account",
      defaultHidden: true,
      cell: (row) =>
        row.deletion_scheduled_at ? (
          <span className="pill pill--bad" title={timestampTitle(row.deletion_scheduled_at)}>
            due {formatRelative(row.deletion_scheduled_at)}
          </span>
        ) : (
          <span className="table__meta">—</span>
        ),
    },
    {
      id: "test",
      header: "Test account",
      width: "short",
      group: "Account",
      defaultHidden: true,
      cell: (row) => (row.is_test_account ? "Yes" : "No"),
    },
    {
      id: "consent",
      header: "Shares with employers",
      width: "short",
      group: "Account",
      defaultHidden: true,
      cell: (row) => (row.employer_sharing_consent ? "Yes" : "No"),
    },
    {
      id: "appVersion",
      header: "App version",
      width: "short",
      group: "Account",
      defaultHidden: true,
      cell: (row) => textCell(row.app_version),
    },
  ];
}

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

function CandidateGridSkeleton({ headers }: { headers: string[] }) {
  return (
    <div className="bank__skeleton" aria-hidden="true">
      <div className="bank__skeleton-head">
        {headers.map((header) => (
          <span className="grid__head" key={header}>
            {header}
          </span>
        ))}
      </div>
      {Array.from({ length: 8 }, (_, row) => (
        <div className="bank__skeleton-row" key={row}>
          {headers.map((header, cell) => (
            <span
              key={header}
              className={cell === 0 ? "skeleton skeleton--title" : "skeleton skeleton--value"}
            />
          ))}
        </div>
      ))}
      <p className="sr-only" role="status">
        Loading candidates…
      </p>
    </div>
  );
}

function BankError({
  error,
  onRetry,
}: {
  error: { reason: string; message: string };
  onRetry: () => void;
}) {
  if (error.reason === "signed_out") {
    return (
      <div className="state state--error">
        <h3 className="state__title">Your session has ended</h3>
        <p className="state__body">Sign in again to search the candidate data bank.</p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/login">
            <Icon name="sign-in" />
            Sign in
          </Link>
        </div>
      </div>
    );
  }
  if (error.reason === "forbidden") {
    return (
      <div className="state state--error">
        <h3 className="state__title">This search is not allowed for your role</h3>
        <p className="state__body">{error.message}</p>
      </div>
    );
  }
  const refused = error.reason === "refused";
  return (
    <div className="state state--error">
      <h3 className="state__title">
        {refused ? "The search was rejected" : "Candidates are unavailable"}
      </h3>
      <p className="state__body">
        {refused
          ? error.message
          : error.reason === "limited"
            ? error.message
            : "The data bank did not answer, and that is a fault on our side rather than anything in the filters."}
      </p>
      <div className="state__actions">
        {refused ? null : (
          <button type="button" className="btn btn--ghost" onClick={onRetry}>
            <Icon name={ACTION_ICON.retry} />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

function BankEmpty({
  total,
  filtered,
  canReadEvents,
  onFirstPage,
}: {
  total: number;
  filtered: boolean;
  canReadEvents: boolean;
  onFirstPage: () => void;
}) {
  if (total > 0) {
    return (
      <div className="state">
        <h3 className="state__title">No rows on this page</h3>
        <p className="state__body">
          These filters still match {formatCount(total)} candidate{total === 1 ? "" : "s"}, but this
          page is past the end of them.
        </p>
        <div className="state__actions">
          <button type="button" className="btn btn--ghost" onClick={onFirstPage}>
            Back to the first page
          </button>
        </div>
      </div>
    );
  }
  if (filtered) {
    return (
      <div className="state">
        <h3 className="state__title">No candidates match</h3>
        <p className="state__body">
          Nothing in the data bank matches this search and these filters. The results head above
          clears them and shows every candidate.
        </p>
      </div>
    );
  }
  return (
    <div className="state">
      <h3 className="state__title">No candidates yet</h3>
      <p className="state__body">
        Candidates appear here as soon as they finish signing up in the app. Until one does, the
        events log is where you confirm the sign-up path is running at all.
      </p>
      {canReadEvents ? (
        <div className="state__actions">
          <Link className="btn btn--ghost" href="/events">
            <Icon name={ACTION_ICON.timeline} />
            View events
          </Link>
        </div>
      ) : null}
    </div>
  );
}
