import { notFound, redirect } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requirePayer } from "../../../lib/auth";
import { agencyFlags } from "../../../lib/config";
import { getCandidateFilters, getCredits, getUnlocks, searchCandidates } from "../../../lib/payer-api";
import { isPayerRateLimited } from "../../../lib/payer-errors";
import type {
  CandidateFilters,
  CandidateSearchPage,
  UnlockHistoryItem,
} from "../../../lib/contracts";
import { liveUnlocksFor } from "../../../lib/unlock-history";
// The inbox's rule, word for word: a 400 with a cursor in the address is the CURSOR's refusal.
import { inboxRefusal as cursorRefusal } from "../../../lib/candidate-inbox";
import {
  addressHasFilters,
  asksForOptions,
  candidateSearchBody,
  candidateSearchHref,
  countSummary,
  inboxRedirectHref,
  parseCandidateSearchAddress,
  pickedRoleLabel,
  resolveCandidateSearch,
  searchFiltersKey,
  type CandidateSearchQuery,
  type ResolvedSearch,
} from "../../../lib/candidate-search";
import { Card } from "../../../components/ds";
import { PageHeader } from "../../../components/page-header";
import { PortalLink } from "../../../components/portal-link";
import { CandidateSearchFilter } from "./candidate-search-filter";
import { CandidateSearchList } from "./candidate-search-list";
import { CandidatesViews } from "./candidates-views";
import {
  CandidatesPager,
  CursorRefusedState,
  LoadErrorState,
  RateLimitedState,
} from "./candidates-states";

export const dynamic = "force-dynamic";

/**
 * CANDIDATES — ALL CANDIDATES (owner rulings 2026-11-03; ADR-0040 phase E2). The Candidates tab
 * opens here: everyone in the eligible pool — the API decides who (consented to employer sharing,
 * a wanted skill, not pending deletion) — ranked, faceless, with a full filter set. The applicant
 * inbox is one click away ("Applied", `/candidates/applied`). Both personas.
 *
 * GATE FIRST, as the inbox: `requirePayer()` runs before anything is read; an AGENCY's Candidates
 * sits behind the agency-portal flag like the rest of its Demand group (off → the neutral 404).
 * Then OLD INBOX LINKS: `/candidates?postingId=…` / `?stage=…` (the inbox lived here) go on to
 * `/candidates/applied` with their whole query.
 *
 * READS — side by side, each with its own degraded state so none blanks another:
 *  - the filter OPTIONS (`GET /payer/candidates/filters`) — the controls only. Unread, every control
 *    offers only "Any …" and one calm line says so;
 *  - one SEARCH page (`POST /payer/candidates/search`) — the content. The address's filters are
 *    checked against the options FIRST and only offered values are sent (lib/candidate-search.ts:
 *    a stale or hand-edited value is dropped, and one calm line says it was ignored — never a 400
 *    and a Retry that cannot succeed). So a FILTERED search waits for the options; with no filter in
 *    the address there is nothing to check and the list is read beside them. A failure is an
 *    in-place error card with Retry under the kept head and filter; a 429 (the payer's hourly cap)
 *    a neutral "too many requests"; a page cursor the server REFUSED (a 400 with a cursor) a calm
 *    "this page link isn't valid" whose way out is the first page, filters kept — never Retry;
 *  - the balance — the Unlock affordance only (`?? 1`: unread never disables Unlock);
 *  - the unlock history — LIVE grants for this page's workers start those cards unlocked.
 *
 * THE LIST: CandidateSearchList — the applicant card's family, masked, the same unlock and reveal,
 * with `job_id` / `job_posting_id` null (no posting). THE COUNTS come from the same response as
 * the rows (ADR-0040 Decision 3) and the screen is never empty without saying why: an empty pool
 * is a calm "No candidates to show yet" (no zero shouted); a strict search that matches nobody
 * shows its counts and the way back to everyone (strict dropped, filters kept); a later page with
 * nothing left says so. Paging is keyset: "Next page" carries `nextCursor` and the filters.
 *
 * LOADING: no route `loading.tsx`, no Suspense, no `next/dynamic` here — a navigation keeps the
 * current page on screen until this one has rendered (app/no-suspense-above-a-page.test.ts); every
 * link drawn here is a PortalLink and carries the navigation pending cue.
 */
const HEAD = {
  title: "Candidates",
  description:
    "Everyone you can unlock on BadaBhai — matches to your filters first, and faceless until you unlock a contact.",
};

/** What a search outage says (the inbox's copy names its postings; this list has none). */
const LOAD_ERROR_BODY =
  "This is usually temporary — nothing you have unlocked has changed. Please retry.";

type SearchRead =
  | { kind: "ok"; page: CandidateSearchPage }
  | { kind: "rate-limited" }
  /** The server refused the page cursor (see `cursorRefusal`): no Retry, the first page instead. */
  | { kind: "cursor-refused" }
  | { kind: "error" };

export default async function CandidatesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  const { agencyPortalEnabled } = agencyFlags();
  if (isAgency && !agencyPortalEnabled) notFound();

  const params = (await searchParams) ?? {};
  // An old inbox link keeps landing on the inbox (before any read).
  const inbox = inboxRedirectHref(params);
  if (inbox !== null) redirect(inbox);

  const address = parseCandidateSearchAddress(params);
  const optionsRead = readOptions();
  // A filter in the address is sent only once the options say it is offered; with none there is
  // nothing to check, so the search does not wait.
  const resolving: Promise<ResolvedSearch> = asksForOptions(address)
    ? optionsRead.then((options) => resolveCandidateSearch(address, options))
    : Promise.resolve(resolveCandidateSearch(address, null));
  const [options, { query, ignored }, read, balance, unlocks] = await Promise.all([
    optionsRead,
    resolving,
    resolving.then(({ query: q }) => readSearch(q)),
    readBalance(),
    readUnlocks(),
  ]);

  const header = {
    ...HEAD,
    toolbar: (
      <div className="candidates-toolbar">
        <CandidatesViews current="all" />
        <CandidateSearchFilter
          // A query-only navigation keeps this mounted, and a kept <select> (or checkbox) ignores
          // a new default — so a new selection remounts it, or it would show the old choice.
          key={`${searchFiltersKey(query)}|${options === null ? "-" : "+"}`}
          options={options}
          selected={query}
          ignored={ignored}
          clearable={addressHasFilters(address)}
        />
      </div>
    ),
  };

  // `.applicants-page` carries the shared card + touch-target rules (globals.css "APPLICANT FEED");
  // `.candidates-page` the Candidates tab's own (the filter, the views, the pager).
  if (read.kind === "ok" && read.page.candidates.length > 0) {
    const { candidates: rows, total, matched, unrecorded, filtered, strict } = read.page;
    return (
      <div className="applicants-page candidates-page">
        <CandidateSearchList
          // One list per page of results: a new page or filter starts with no session state.
          key={`${searchFiltersKey(query)}|${query.cursor ?? ""}`}
          header={header}
          counts={{ total, matched, unrecorded, filtered, strict, unrecordable: unrecordable(query) }}
          candidates={rows}
          relatedTo={pickedRoleLabel(query, options)}
          // An affordance only — an unread balance keeps Unlock enabled (the server decides).
          balance={balance ?? 1}
          // Only this page's workers, only live grants. Request time: this page is force-dynamic.
          unlocked={liveUnlocksFor(
            unlocks,
            rows.map((r) => r.workerId),
            Date.now(),
          )}
        />
        <Pager query={query} nextCursor={read.page.nextCursor} />
      </div>
    );
  }

  return (
    <div className="applicants-page candidates-page">
      <PageHeader {...header} />
      {read.kind === "rate-limited" ? (
        <RateLimitedState />
      ) : read.kind === "cursor-refused" ? (
        <CursorRefusedState firstPage={candidateSearchHref({ ...query, cursor: null })} />
      ) : read.kind === "error" ? (
        <LoadErrorState
          firstPage={query.cursor ? candidateSearchHref({ ...query, cursor: null }) : null}
          body={LOAD_ERROR_BODY}
        />
      ) : read.page.total === 0 ? (
        <EmptyPoolState />
      ) : query.cursor ? (
        <EndOfListState />
      ) : read.page.filtered ? (
        <NoMatchState page={read.page} query={query} />
      ) : (
        // An unfiltered first page with nobody on it while the pool counts people is not an
        // answer the API gives; if it ever were, it reads as calmly as an empty pool.
        <EmptyPoolState />
      )}
      {/* Paging follows a page the SERVER answered. */}
      {read.kind === "ok" ? <Pager query={query} nextCursor={read.page.nextCursor} /> : null}
    </div>
  );
}

/** The filter options; null when that read failed (the controls then offer only "Any …"). */
async function readOptions(): Promise<CandidateFilters | null> {
  try {
    return await getCandidateFilters();
  } catch {
    return null;
  }
}

/**
 * One search page. A 400 is the CURSOR's refusal only when the address carried one (the body is
 * built from offered values, so nothing else in it is the payer's to fix); any other 400 — or any
 * other failure — is an outage, with Retry.
 */
async function readSearch(query: CandidateSearchQuery): Promise<SearchRead> {
  try {
    return { kind: "ok", page: await searchCandidates(candidateSearchBody(query)) };
  } catch (e) {
    if (isPayerRateLimited(e)) return { kind: "rate-limited" };
    return cursorRefusal(e, { cursor: query.cursor }) === "cursor"
      ? { kind: "cursor-refused" }
      : { kind: "error" };
  }
}

/** The caller's OWN balance — an affordance only; unread (null) keeps Unlock enabled. */
async function readBalance(): Promise<number | null> {
  try {
    return (await getCredits()).balance;
  } catch {
    return null;
  }
}

/** The caller's OWN unlock history; unread is no grants (every card starts locked). */
async function readUnlocks(): Promise<UnlockHistoryItem[]> {
  try {
    return await getUnlocks();
  } catch {
    return [];
  }
}

/** "Next page" (the server's cursor, filters kept) and "First page" (filters kept, no cursor). */
function Pager({ query, nextCursor }: { query: CandidateSearchQuery; nextCursor: string | null }) {
  return (
    <CandidatesPager
      firstPage={query.cursor ? candidateSearchHref({ ...query, cursor: null }) : null}
      nextPage={nextCursor ? candidateSearchHref({ ...query, cursor: nextCursor }) : null}
    />
  );
}

/**
 * Nobody is in the pool yet (`total` 0). Calm: no blame, no counts shouting zero, no way "out" —
 * the filters are not the reason, and the Applied view is right above.
 */
function EmptyPoolState() {
  return (
    <Card>
      <div className="state">
        <span className="state__icon">
          <Icon name={ACTION_ICON.candidate} />
        </span>
        <h2 className="state__title">No candidates to show yet</h2>
        <p className="state__body">
          Workers appear here — faceless — once they are on BadaBhai and open to employers.
        </p>
      </div>
    </Card>
  );
}

/** A later page with nothing left on it (the pager below still offers the way back). */
function EndOfListState() {
  return (
    <Card>
      <div className="state">
        <span className="state__icon">
          <Icon name="tray" />
        </span>
        <h2 className="state__title">No more candidates</h2>
        <p className="state__body">You have reached the end of this list.</p>
      </div>
    </Card>
  );
}

/**
 * The pool has people and a FILTERED first page holds none of them: a STRICT search that matched
 * nobody (without strict, filters reorder — nobody is removed). Never a bare empty screen: it says
 * the counts from the same response, and its way out is everyone again — the SAME filters without
 * "Only show matches", where the matches would lead and nobody is dropped. (A non-strict empty
 * first page is not an answer the API gives; if it ever were, the counts are said all the same
 * and the way out is to clear the filters.)
 */
function NoMatchState({ page, query }: { page: CandidateSearchPage; query: CandidateSearchQuery }) {
  const summary = countSummary({ ...page, unrecordable: unrecordable(query) });
  const strict = page.strict;
  const way = strict
    ? {
        href: candidateSearchHref({ ...query, strict: false, cursor: null }),
        label: "Show all candidates",
      }
    : { href: candidateSearchHref({}), label: "Clear filters" };
  return (
    <Card>
      <div className="state">
        <span className="state__icon">
          <Icon name={ACTION_ICON.filter} />
        </span>
        <h2 className="state__title">No candidates match every filter</h2>
        {summary ? <p className="state__body candidate-search__count">{summary.line}</p> : null}
        <p className="state__body">
          {strict
            ? "“Only show matches” hides everyone else — show all candidates to see them, with any matches first."
            : "Clear the filters to see everyone."}
        </p>
        <div className="state__actions">
          <PortalLink
            className="bb-btn bb-btn--secondary"
            href={way.href}
            pendingLabel="All candidates"
          >
            <Icon name={ACTION_ICON.clearFilters} />
            <span>{way.label}</span>
          </PortalLink>
        </div>
      </div>
    </Card>
  );
}

/** A filter on a field that can be unrecorded was asked for (ADR-0040 §4: the badge says the 3rd number). */
function unrecordable(query: CandidateSearchQuery): boolean {
  return query.city !== null || query.experience !== null || query.industryExperience !== null;
}
