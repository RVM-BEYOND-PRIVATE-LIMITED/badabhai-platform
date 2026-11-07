import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { searchCandidates } from "../../../lib/candidate-search-server";
import {
  candidateAvailabilityLabel,
  candidateExperienceLabel,
  candidateFilterSet,
  candidateListHeading,
  candidateResumeLabel,
  candidateSearchBody,
  candidateSearchHref,
  candidateSortLink,
  candidateTradeLabel,
  hasCandidateFilters,
  parseCandidateSearchParams,
  savedViewQuery,
  type CandidateSearchParams,
  type CandidateSearchResponse,
  type CandidateSearchRow,
} from "../../../lib/candidate-search";
import { readCandidateRecord } from "../../../lib/candidate-detail";
import { candidateIdTitle } from "../../../lib/candidate-view";
import { humanize } from "../../../lib/candidate-view";
import { isAdminRequestError } from "../../../lib/admin-http";
import { formatCount, formatRelative, shortId, timestampTitle } from "../../../lib/format";
import { displayName, identityPosture } from "../../../lib/identity";
import { CopyId } from "../../../components/copy-id";
import { StatusPill, statusLabel } from "../../../components/status-pill";
import { NameCell } from "../../../components/name-cell";
import { IdentityCapNotice } from "../../../components/identity-notice";
import { NumberedPager } from "../../../components/pager";
import { PageHeader } from "../../../components/page-header";
import { DataGrid, type GridColumn } from "../../../components/data-grid";
import { NavPendingCue } from "../../../components/nav-pending";
import { FilterChip } from "../../../components/filter-chip-link";
import { FilterPanel } from "../../../components/filter-panel";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { RetryActions } from "../../../components/retry-actions";
import { CandidateFilterBar } from "./filter-bar";
import { CandidateSearchBox } from "./candidate-search-box";
import { CandidateSavedViews } from "./saved-views";
import { CandidateDrawer, type InitialCandidateRecord } from "./candidate-drawer";
import { CANDIDATE_PARAM, type DrawerRow } from "./candidate-drawer-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Candidates" };

/**
 * Candidates — the data bank of every worker (A7, #2577): one universal search box over
 * every field, 20 filters, allow-list sorts, numbered pages over the search's exact total,
 * and a saved-views shelf — all on the `#2574` grid with the Identity / Work / Activity /
 * Account column chooser groups.
 *
 * ── THE TERM NEVER TOUCHES THE URL ────────────────────────────────────────────────
 * `POST /admin/candidates/search` carries the free-text `q` in the BODY ONLY (ADR-0062
 * §3.6: the term must never reach a log line, and access logs record URLs). This page
 * renders the bare-filters list from the address; the search box POSTs its debounced term
 * to the same-origin search route and answers a dropdown, each row opening the drawer.
 *
 * ── NAMES, SINCE THE 2026-08-18 RULING ──────────────────────────────────────────
 * Unchanged from the roster days: a Name column for a role holding `read_identity`, audited
 * and budgeted per read; `analyst` gets the rows with no Name column at all. `identityPosture`
 * reads the `name` key's PRESENCE on the search rows — absent ⇒ not disclosed — never the
 * capability alone.
 *
 * ── THE CANDIDATE DRAWER ──────────────────────────────────────────────────────────
 * Unchanged: for a session holding `read_candidates` a row opens the record in a drawer over
 * this list (`?c=<id>`, every filter and the page kept), read on the server beside the list.
 */
export default async function CandidatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireCapability("read_entities");

  const params = parseCandidateSearchParams(await searchParams);
  const { filters } = params;

  const mayOpenRecords = can(session.capabilities, "read_candidates");
  const openId = mayOpenRecords ? firstParam((await searchParams)[CANDIDATE_PARAM]) : undefined;
  const openRead = openId ? readCandidateRecord(openId) : null;

  const filtered = hasCandidateFilters(filters);

  let result: CandidateSearchResponse | null = null;
  let failed = false;
  /** A 400 from a `.strict()` search body names the address's filters — paging is sanitized. */
  let refused = false;
  try {
    result = await searchCandidates(candidateSearchBody(params));
  } catch (err) {
    failed = true;
    refused = isAdminRequestError(err) && err.status === 400;
  }
  const initialRecord: InitialCandidateRecord | null =
    openId && openRead ? { id: openId, result: await openRead } : null;

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
    (result?.candidates ?? []).map((c) => (Object.hasOwn(c, "name") ? { name: c.name } : {})),
    "name",
    can(session.capabilities, "read_identity"),
  );
  const named = posture === "named";

  const columns = candidateColumns(params, named);
  const pagerParams = pagerParamsFor(params);

  return (
    <div className="page page--list">
      <PageHeader
        title="Candidates"
        description={
          posture === "faceless"
            ? "Every worker, identified by id — your role does not include name access."
            : posture === "capped"
              ? "Every worker, identified by id while names are withheld (see below)."
              : "Names are shown to your role, and each name read is capped and audited."
        }
        info={
          <p>
            The search box matches every field at once — trade, city, skill, language and more —
            and a revealed contact is a separate, reason-gated action.
          </p>
        }
        filters={
          <>
            <CandidateSearchBox />
            {/* Folds behind a "Filters (n)" toggle on a phone (AW-08); unchanged above it. */}
            <FilterPanel
              headingId="wf-heading"
              heading="Filter candidates"
              filters={candidateFilterSet(filters)}
            >
              <CandidateFilterBar params={params} />
            </FilterPanel>
            <CandidateSavedViews currentQuery={savedViewQuery(params)} />
          </>
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
              {failed ? "Results" : candidateListHeading(result?.total ?? 0)}
            </h2>
            <p className="panel__sub">
              {failed
                ? refused
                  ? "That filter combination was rejected."
                  : "Nothing was fetched."
                : `${formatCount(result?.candidates.length ?? 0)} on this page · page ${formatCount(result?.page ?? 1)} of ${formatCount(result?.total_pages ?? 1)}.`}
            </p>
          </div>
          {refused ? null : clearFilters}
        </div>

        {filtered ? <ActiveFilterChips params={params} /> : null}
        <FacetChips params={params} counts={result?.counts ?? null} />

        {refused ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected these filters</h3>
            <p className="state__body">
              One of the values is not a filter combination this search serves, so nothing was
              fetched. Check the values in the filter bar above, or clear them and start again.
            </p>
            <div className="state__actions">{clearFilters}</div>
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">Candidates are unavailable</h3>
            <p className="state__body">
              The data bank did not load, and that is a fault on our side rather than anything in
              the filters.
            </p>
            {/* The SAME query — filters, sort, page and size kept. This list pages by
                number, so the page rides `href` itself and there is no opaque cursor to
                carry: `cursor` is passed explicitly as undefined for the fence. */}
            <RetryActions href={candidateSearchHref("/candidates", params)} cursor={undefined} />
          </div>
        ) : result && result.candidates.length > 0 ? (
          <DataGrid
            id="candidates"
            caption={`Candidates, ${sortLabel(params.sort)} ${params.dir === "asc" ? "ascending" : "descending"}`}
            columns={columns}
            rows={result.candidates}
            rowKey={(c) => c.worker_id}
            rowLink={{
              column: named ? "name" : "worker",
              href: (c) =>
                mayOpenRecords
                  ? candidateSearchHref("/candidates", params, { [CANDIDATE_PARAM]: c.worker_id })
                  : `/candidates/${c.worker_id}`,
              drawer: mayOpenRecords ? CANDIDATE_PARAM : undefined,
              name: (c) =>
                (named ? displayName(c.name ?? null) : null) ?? candidateIdTitle(c.worker_id),
              label: (c) =>
                named && displayName(c.name ?? null) === null
                  ? `Candidate ${shortId(c.worker_id)}, no name on record`
                  : undefined,
            }}
            pager={
              <NumberedPager
                basePath="/candidates"
                params={pagerParams}
                page={result.page}
                pageSize={result.page_size}
                total={result.total}
              />
            }
          />
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No candidates match these filters</h3>
            <p className="state__body">
              Nobody in the data bank is in this slice right now. Widen a filter, or clear them
              from the results head above to see every candidate.
            </p>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No candidates registered yet</h3>
            <p className="state__body">
              Workers appear here as soon as they finish signing up in the app. Until one does,
              the events log is where you confirm the sign-up path is running at all.
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

      {mayOpenRecords ? (
        <CandidateDrawer
          rows={drawerRows(result?.candidates ?? [], named)}
          initial={initialRecord}
          entitled={can(session.capabilities, "read_identity")}
          canReveal={can(session.capabilities, "reveal_pii")}
        />
      ) : null}
    </div>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  const one = Array.isArray(value) ? value[0] : value;
  const trimmed = one?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The numbered pager's params: every filter, and the sort, direction and page size — the page
 * number rides the pager's own `page` slot. Defaults ride bare, so the first page links short.
 */
function pagerParamsFor(params: CandidateSearchParams): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(candidateFilterSet(params.filters))) {
    out[key] = String(value);
  }
  if (params.sort !== "last_active_at") out.sort = params.sort;
  if (params.dir !== "desc") out.dir = params.dir;
  if (params.pageSize !== 50) out.page_size = String(params.pageSize);
  return out;
}

function ActiveFilterChips({ params }: { params: CandidateSearchParams }) {
  const chips: Array<{ key: string; label: string; href: string }> = [];
  const drop = (dropKey: string, dropValue?: string) => {
    const filters = { ...params.filters };
    const current = filters[dropKey as keyof typeof filters];
    if (Array.isArray(current) && dropValue !== undefined) {
      const kept = current.filter((v) => v !== dropValue);
      if (kept.length > 0) filters[dropKey as keyof typeof filters] = kept as never;
      else delete filters[dropKey as keyof typeof filters];
    } else {
      delete filters[dropKey as keyof typeof filters];
    }
    return candidateSearchHref("/candidates", { ...params, filters, page: 1 });
  };
  const RANGE_LABELS: Record<string, string> = {
    min_experience_years: "Min experience",
    max_experience_years: "Max experience",
    role_experience_months_min: "Min role experience",
    role_experience_months_max: "Max role experience",
    has_resume: "Has a Resume",
    last_active_from: "Active from",
    last_active_to: "Active to",
    registered_from: "Registered from",
    registered_to: "Registered to",
    deletion_scheduled: "Deletion scheduled",
    flagged: "Flagged",
    is_test_account: "Test account",
  };
  for (const [key, label] of Object.entries(RANGE_LABELS)) {
    const value = params.filters[key as keyof typeof params.filters];
    if (typeof value === "string" && value) {
      chips.push({ key, label: `${label}: ${value}`, href: drop(key) });
    }
  }
  for (const key of ["language", "form_level", "trade_id", "role_id", "state"] as const) {
    for (const value of params.filters[key] ?? []) {
      chips.push({ key: `${key}:${value}`, label: `${chipLabel(key)}: ${value}`, href: drop(key, value) });
    }
  }
  if (chips.length === 0) return null;
  return (
    <div className="segmented" role="group" aria-label="Active filters">
      {chips.map((chip) => (
        <Link key={chip.key} className="btn btn--ghost btn--sm" href={chip.href}>
          <Icon name={ACTION_ICON.dismiss} />
          Remove {chip.label}
          <NavPendingCue message={`Removing the ${chip.label} filter…`} />
        </Link>
      ))}
    </div>
  );
}

/**
 * The facet chips: what the search counted for this query (`by_status`, `by_trade`,
 * `by_city`, `by_profile_status`), each toggling its value — `All` clears the facet. The
 * counts describe the rows, so the chips say how narrowing each value is before the click.
 */
function FacetChips({
  params,
  counts,
}: {
  params: CandidateSearchParams;
  counts: CandidateSearchResponse["counts"] | null;
}) {
  if (!counts) return null;
  const groups: Array<{
    key: "status" | "trade_id" | "city" | "profile_status";
    title: string;
    facets: Array<{ value: string; count: number }>;
  }> = [
    { key: "status", title: "Status", facets: counts.by_status },
    { key: "trade_id", title: "Trade", facets: counts.by_trade },
    { key: "city", title: "City", facets: counts.by_city },
    { key: "profile_status", title: "Profile", facets: counts.by_profile_status },
  ];
  const toggle = (key: (typeof groups)[number]["key"], value: string) => {
    const filters = { ...params.filters };
    const current = filters[key] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    if (next.length > 0) filters[key] = next;
    else delete filters[key];
    return candidateSearchHref("/candidates", { ...params, filters, page: 1 });
  };
  const clearFacet = (key: (typeof groups)[number]["key"]) => {
    const filters = { ...params.filters };
    delete filters[key];
    return candidateSearchHref("/candidates", { ...params, filters, page: 1 });
  };
  return (
    <div role="group" aria-label="Narrow by the search's counts">
      {groups.map((group) => {
        if (group.facets.length === 0) return null;
        const active = params.filters[group.key] ?? [];
        return (
          <div key={group.key} className="segmented" role="group" aria-label={group.title}>
            <span className="table__meta">{group.title}</span>
            {active.length > 0 ? (
              <FilterChip selected={false} href={clearFacet(group.key)} cursor={undefined}>
                All {group.title}
              </FilterChip>
            ) : null}
            {group.facets.slice(0, 8).map((facet) => (
              <FilterChip
                key={facet.value}
                selected={active.includes(facet.value)}
                href={toggle(group.key, facet.value)}
                cursor={undefined}
              >
                {facetLabel(group.key, facet.value)} ({formatCount(facet.count)})
              </FilterChip>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function chipLabel(key: string): string {
  switch (key) {
    case "language":
      return "Language";
    case "form_level":
      return "Form level";
    case "trade_id":
      return "Trade";
    case "role_id":
      return "Role";
    case "state":
      return "State";
    default:
      return humanize(key);
  }
}

function facetLabel(key: string, value: string): string {
  if (key === "status" || key === "profile_status") return statusLabel(value);
  return value;
}

function sortLabel(sort: CandidateSearchParams["sort"]): string {
  return sort
    .split("_")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The roster's columns (A4, #2574) on the data-bank rows. Defaults are the #2577 spec —
 * Name · ID · Trade · Experience · City · Status · Profile · Resume · Last active ·
 * Registered — under the Identity / Work / Activity / Account chooser groups; the rest start
 * hidden. The row's link is its NAME in the `named` posture, else the id.
 */
function candidateColumns(
  params: CandidateSearchParams,
  named: boolean,
): GridColumn<CandidateSearchRow>[] {
  const sortFor = (sort: CandidateSearchParams["sort"]) => candidateSortLink("/candidates", params, sort);
  return [
    ...(named
      ? [
          {
            id: "name",
            header: "Name",
            group: "Identity" as const,
            cell: (c: CandidateSearchRow) => <NameCell value={c.name ?? null} />,
            title: (c: CandidateSearchRow) => displayName(c.name ?? null) ?? undefined,
          },
        ]
      : []),
    {
      id: "worker",
      header: "ID",
      width: "id" as const,
      group: "Identity",
      cell: (c) =>
        named ? (
          <span className="mono" title={c.worker_id}>
            {shortId(c.worker_id)}
          </span>
        ) : (
          <span className="mono">{shortId(c.worker_id)}</span>
        ),
      title: named ? undefined : (c: CandidateSearchRow) => c.worker_id,
      trail: (c: CandidateSearchRow) => <CopyId id={c.worker_id} label="worker id" />,
    },
    {
      id: "trade",
      header: "Trade",
      group: "Work",
      cell: (c) => candidateTradeLabel(c) ?? <span className="table__meta">—</span>,
      title: (c: CandidateSearchRow) => candidateTradeLabel(c) ?? undefined,
      sort: sortFor("trade_label"),
    },
    {
      id: "experience",
      header: "Experience",
      width: "short" as const,
      group: "Work",
      cell: (c) => candidateExperienceLabel(c) ?? <span className="table__meta">—</span>,
      title: (c: CandidateSearchRow) => candidateExperienceLabel(c) ?? undefined,
      sort: sortFor("total_experience_years"),
    },
    {
      id: "city",
      header: "City",
      group: "Identity",
      cell: (c) => c.current_city ?? <span className="table__meta">—</span>,
      title: (c: CandidateSearchRow) =>
        c.current_city && c.current_state ? `${c.current_city}, ${c.current_state}` : (c.current_city ?? undefined),
      sort: sortFor("current_city"),
    },
    {
      id: "status",
      header: "Status",
      width: "status" as const,
      group: "Activity",
      cell: (c) => <StatusPill value={c.status} />,
      sort: sortFor("status"),
    },
    {
      id: "profile",
      header: "Profile",
      width: "short" as const,
      group: "Activity",
      cell: (c) => <StatusPill value={c.profile_status} />,
      sort: sortFor("profile_status"),
    },
    {
      id: "resume",
      header: "Resume",
      width: "short" as const,
      text: "truncate" as const,
      className: "table__meta",
      group: "Activity",
      cell: (c) => candidateResumeLabel(c),
      title: (c: CandidateSearchRow) => candidateResumeLabel(c),
      sort: sortFor("resume_count"),
    },
    {
      id: "last_active",
      header: "Last active",
      width: "date" as const,
      group: "Activity",
      cell: (c) =>
        c.last_active_at ? (
          <time dateTime={c.last_active_at} title={timestampTitle(c.last_active_at)}>
            {formatRelative(c.last_active_at)}
          </time>
        ) : (
          <span className="table__meta">Never</span>
        ),
      sort: sortFor("last_active_at"),
    },
    {
      id: "registered",
      header: "Registered",
      width: "date" as const,
      group: "Account",
      cell: (c) => (
        <time dateTime={c.created_at} title={timestampTitle(c.created_at)}>
          {formatRelative(c.created_at)}
        </time>
      ),
      sort: sortFor("created_at"),
    },
    {
      id: "state",
      header: "State",
      group: "Identity",
      defaultHidden: true,
      cell: (c) => c.current_state ?? <span className="table__meta">—</span>,
      title: (c: CandidateSearchRow) => c.current_state ?? undefined,
    },
    {
      id: "availability",
      header: "Availability",
      group: "Work",
      defaultHidden: true,
      cell: (c) => candidateAvailabilityLabel(c) ?? <span className="table__meta">—</span>,
      title: (c: CandidateSearchRow) => candidateAvailabilityLabel(c) ?? undefined,
    },
    {
      id: "shift",
      header: "Shift",
      width: "short" as const,
      group: "Work",
      defaultHidden: true,
      cell: (c) => (c.shift_preference ? humanize(c.shift_preference) : <span className="table__meta">—</span>),
      title: (c: CandidateSearchRow) => (c.shift_preference ? humanize(c.shift_preference) : undefined),
    },
    {
      id: "languages",
      header: "Languages",
      width: "short" as const,
      text: "truncate" as const,
      group: "Work",
      defaultHidden: true,
      cell: (c) => (c.languages.length > 0 ? c.languages.join(", ") : <span className="table__meta">—</span>),
      title: (c: CandidateSearchRow) => (c.languages.length > 0 ? c.languages.join(", ") : undefined),
    },
    {
      id: "education",
      header: "Education",
      text: "truncate" as const,
      group: "Work",
      defaultHidden: true,
      cell: (c) => c.education_level ?? <span className="table__meta">—</span>,
      title: (c: CandidateSearchRow) => c.education_level ?? undefined,
    },
  ];
}

/**
 * The rows the drawer moves through with ↑/↓, in the list's order, each titled the way the list
 * names it — the name in the `named` posture, the short id otherwise — while its record loads.
 */
function drawerRows(items: readonly CandidateSearchRow[], named: boolean): DrawerRow[] {
  return items.map((c) => ({
    id: c.worker_id,
    title: (named ? displayName(c.name ?? null) : null) ?? candidateIdTitle(c.worker_id),
  }));
}
