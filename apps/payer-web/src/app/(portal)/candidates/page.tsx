import { notFound } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requirePayer } from "../../../lib/auth";
import { agencyFlags } from "../../../lib/config";
import {
  getCandidateInbox,
  getCredits,
  getPostings,
  getUnlocks,
  listAgencyJobs,
} from "../../../lib/payer-api";
import { isPayerBadRequest, isPayerRateLimited } from "../../../lib/payer-errors";
import type { CandidateInbox, UnlockHistoryItem } from "../../../lib/contracts";
import {
  hasSavedStages,
  STAGE_LABEL,
  type ApplicantStage,
} from "../../../lib/applicant-stages";
import { liveUnlocksFor } from "../../../lib/unlock-history";
import { postingRoutes } from "../../../lib/posting-routes";
import {
  agencyPostingOptions,
  candidatePosting,
  candidatesHref,
  companyPostingOptions,
  inboxRefusal,
  parseCandidatesQuery,
  selectedPosting,
  stagesOffered,
  withSelectedOption,
  type CandidatesQuery,
  type PostingOption,
} from "../../../lib/candidate-inbox";
import { Card } from "../../../components/ds";
import { PageHeader } from "../../../components/page-header";
import { PortalLink } from "../../../components/portal-link";
import { RetryButton } from "../../../components/retry-button";
import { ApplicantActions } from "../postings/[id]/applicants/applicant-actions";
import { CandidateFilter } from "./candidate-filter";

export const dynamic = "force-dynamic";

/**
 * CANDIDATES — every applicant to every posting the payer owns, newest application first, in one
 * list (owner request 2026-10-07). Both personas. A posting's own feed stays "Applicants".
 *
 * GATE FIRST: `requirePayer()` runs before anything is read. An AGENCY's Candidates sits in its
 * Demand group beside Postings and, like every agency page, behind the agency-portal flag (off →
 * the neutral 404, and the rail does not offer it).
 *
 * THE SAME CARD AND UNLOCK as a posting's Applicants page: {@link ApplicantActions} in its inbox
 * mode — faceless cards, the ONE ConfirmSpendDialog, the balance as an affordance (`?? 1`: an
 * unread balance never disables Unlock). Each card names the posting it applied to, linked to its
 * details, and its unlock / resume disclosure name THAT posting. The inbox filters by posting
 * (`?postingId=`), server-side.
 *
 * SAVED STAGES (owner ruling 2026-10-07; API #2137). While the server saves the New / Shortlist /
 * Passed board — a flag the portal cannot read — every row carries its `stage`: each card shows it
 * and offers that posting's Keep / Pass / Move to New (saved; see applicant-actions.tsx), and the
 * filter gains a Stage select (`?stage=`, the same plain GET form, server-side). The filter is
 * drawn only when an ANSWERED read showed stages are saved (`stagesOffered`): with the flag off the
 * API refuses `?stage=` with a 400, so a filter there could only ever fail. A `?stage=` in the
 * address the API refuses (a stale link, the flag since turned off) is not an error: the page reads
 * again WITHOUT it and shows the unfiltered list, with one calm line by the filter saying so. A new
 * stage starts from the first page (the form carries no cursor); paging keeps it.
 *
 * READS — four, side by side, each with its own degraded state so none blanks another:
 *  - the inbox page (`GET /payer/reach/applicants`) — the page's content. A failure is an in-place
 *    error card with Retry under the head; a 429 (the hourly reach cap it shares with the
 *    per-posting feed) is a neutral "too many requests" instead; and a page cursor the server
 *    REFUSED (a 400 — one it never minted, e.g. hand-edited) is a calm "this page link isn't
 *    valid" whose way out is the first page, filter kept — never Retry, which could only be
 *    refused again (`inboxRefusal`). Never blanks the head or filter;
 *  - the payer's OWN postings (company postings or agency jobs) — only the filter's options;
 *    unread, the filter still offers "All postings";
 *  - the balance — the Unlock affordance only (the shell's chip prints it);
 *  - the unlock history — LIVE grants for this page's workers start those rows unlocked
 *    (`liveUnlocksFor`); unread is none (every row starts locked; the server never debits twice).
 *
 * A `postingId` that matches nothing — another payer's, unknown, or not an id at all — is the same
 * "no applicants for this posting" state as an owned posting nobody applied to (the server answers
 * all of them with one empty page; a non-id is decided here, before any read). Paging is keyset:
 * "Next page" carries the server's `nextCursor` verbatim, keeping the filter.
 *
 * LOADING: no route `loading.tsx`, no Suspense, no `next/dynamic` here — a navigation keeps the
 * current page on screen until this one has rendered (app/no-suspense-above-a-page.test.ts). Every
 * link this page draws that only changes the query (First page, Next page, All postings) carries
 * the navigation pending cue (components/nav-pending.tsx), so a slow page still answers the click.
 */
const HEAD = {
  title: "Candidates",
  description:
    "Everyone who applied to your postings, newest first — each ranked on its own posting and faceless until you unlock a contact.",
};

type InboxRead =
  /**
   * `stage`: the stage filter the SERVER applied — null when none was asked, or it refused one.
   * `stageRefused`: a stage WAS asked and the server refused it (stages not saved), so this page
   * is the unfiltered re-read.
   */
  | { kind: "ok"; inbox: CandidateInbox; stage: ApplicantStage | null; stageRefused: boolean }
  | { kind: "rate-limited" }
  /** The server refused the page cursor (see `inboxRefusal`): no Retry, the first page instead. */
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

  const query = parseCandidatesQuery((await searchParams) ?? {});
  const [read, options, balance, unlocks] = await Promise.all([
    readInbox(query),
    readPostingOptions(isAgency),
    readBalance(),
    readUnlocks(),
  ]);

  const selected = selectedPosting(query.filter);
  const inboxRows = read.kind === "ok" ? read.inbox.applicants : [];
  // The stage filter the server applied (an answered read), else the one the address asks for —
  // kept by the error states' links, which re-ask (a refused one is re-read without it).
  const stage = read.kind === "ok" ? read.stage : query.stage;
  const offerStages = read.kind === "ok" && stagesOffered(read.stage, hasSavedStages(inboxRows));
  const header = {
    ...HEAD,
    toolbar: (
      <CandidateFilter
        // A query-only navigation keeps this mounted, and a kept <select> ignores a new
        // defaultValue — so a new selection remounts it, or it would show the old choice.
        key={`${selected ?? ""}|${offerStages ? (stage ?? "") : "-"}`}
        options={withSelectedOption(options ?? [], selected, inboxRows)}
        selected={selected}
        unavailable={options === null}
        stage={offerStages ? { selected: stage } : null}
        stageRefused={read.kind === "ok" && read.stageRefused}
      />
    ),
  };
  // The filter the pager keeps: a real posting id only (a non-id never leaves this page).
  const keep = query.filter.kind === "posting" ? query.filter.postingId : null;

  // `.applicants-page` carries the shared card + touch-target rules (globals.css "APPLICANT FEED");
  // `.candidates-page` only namespaces this screen's own (the filter, the posting line, the pager).
  if (read.kind === "ok" && inboxRows.length > 0) {
    const viewer = { isAgency, agencyPortalEnabled };
    const rows = inboxRows.map((row) => ({ ...row, posting: candidatePosting(row.posting, viewer) }));
    return (
      <div className="applicants-page candidates-page">
        <ApplicantActions
          // One list per page of results: a new page or filter starts with no session state. The
          // stage is the one the ADDRESS asked for, not the one the server applied: a failed
          // move's re-read can come back refused (stages no longer saved) and re-read unfiltered,
          // and that must not remount the list — its toast says why the move did not stick.
          key={`${keep ?? "all"}|${query.stage ?? "all"}|${query.cursor ?? ""}`}
          header={header}
          applicants={rows}
          // An affordance only — an unread balance keeps Unlock enabled (the server decides).
          balance={balance ?? 1}
          // Only this page's workers, only live grants. Request time: this page is force-dynamic.
          unlocked={liveUnlocksFor(
            unlocks,
            rows.map((r) => r.workerId),
            Date.now(),
          )}
        />
        <Pager
          postingId={keep}
          stage={stage}
          cursor={query.cursor}
          nextCursor={read.inbox.nextCursor}
        />
      </div>
    );
  }

  return (
    <div className="applicants-page candidates-page">
      <PageHeader {...header} />
      {read.kind === "rate-limited" ? (
        <RateLimitedState />
      ) : read.kind === "cursor-refused" ? (
        <CursorRefusedState firstPage={candidatesHref({ postingId: keep, stage })} />
      ) : read.kind === "error" ? (
        <LoadErrorState
          firstPage={query.cursor ? candidatesHref({ postingId: keep, stage }) : null}
        />
      ) : query.filter.kind === "unknown" ? (
        <FilteredEmptyState stage={stage} />
      ) : query.cursor ? (
        <EndOfListState />
      ) : read.stage !== null ? (
        <StageEmptyState stage={read.stage} postingId={keep} />
      ) : query.filter.kind === "posting" ? (
        <FilteredEmptyState stage={stage} />
      ) : (
        <EmptyState isAgency={isAgency} hasPostings={options === null || options.length > 0} />
      )}
      {/* Paging follows a page the SERVER answered — never the unread one of a non-id filter. */}
      {read.kind === "ok" && query.filter.kind !== "unknown" ? (
        <Pager
          postingId={keep}
          stage={stage}
          cursor={query.cursor}
          nextCursor={read.inbox.nextCursor}
        />
      ) : null}
    </div>
  );
}

/**
 * The inbox page. A filter that cannot be an id matches nothing — no read is made for it.
 *
 * A stage filter is sent only when the address asks for one. The API refuses it with a 400 while
 * it does not save stages; that 400 is not this page's error — it is read again WITHOUT the stage
 * (a refused request spends none of the reach budget), and the page shows every stage with no
 * stage filter. A 400 on that second read is the cursor's (the posting filter is always an id).
 */
async function readInbox({ filter, cursor, stage }: CandidatesQuery): Promise<InboxRead> {
  if (filter.kind === "unknown") {
    return { kind: "ok", inbox: { applicants: [], nextCursor: null }, stage: null, stageRefused: false };
  }
  const base = {
    ...(filter.kind === "posting" ? { postingId: filter.postingId } : {}),
    ...(cursor ? { cursor } : {}),
  };
  try {
    if (stage !== null) {
      try {
        const inbox = await getCandidateInbox({ ...base, stage });
        return { kind: "ok", inbox, stage, stageRefused: false };
      } catch (e) {
        if (!isPayerBadRequest(e)) throw e;
      }
    }
    return {
      kind: "ok",
      inbox: await getCandidateInbox(base),
      stage: null,
      stageRefused: stage !== null,
    };
  } catch (e) {
    if (isPayerRateLimited(e)) return { kind: "rate-limited" };
    return inboxRefusal(e, { cursor }) === "cursor" ? { kind: "cursor-refused" } : { kind: "error" };
  }
}

/** The payer's OWN postings as filter options; null when the list read failed. */
async function readPostingOptions(isAgency: boolean): Promise<PostingOption[] | null> {
  try {
    return isAgency
      ? agencyPostingOptions(await listAgencyJobs())
      : companyPostingOptions(await getPostings());
  } catch {
    return null;
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

/** The caller's OWN unlock history; unread is no grants (every row starts locked). */
async function readUnlocks(): Promise<UnlockHistoryItem[]> {
  try {
    return await getUnlocks();
  } catch {
    return [];
  }
}

/**
 * Keyset paging: "Next page" carries the server's cursor verbatim; "First page" returns to the
 * newest. Both keep the posting and stage filters. Nothing when the list is one page.
 */
function Pager({
  postingId,
  stage,
  cursor,
  nextCursor,
}: {
  postingId: string | null;
  stage: ApplicantStage | null;
  cursor: string | null;
  nextCursor: string | null;
}) {
  if (!cursor && !nextCursor) return null;
  return (
    <nav className="candidates-pager" aria-label="Candidate pages">
      {cursor ? (
        <PortalLink
          className="bb-btn bb-btn--secondary"
          href={candidatesHref({ postingId, stage })}
          pendingLabel="First page"
        >
          <Icon name={ACTION_ICON.back} />
          <span>First page</span>
        </PortalLink>
      ) : null}
      {nextCursor ? (
        <PortalLink
          className="bb-btn bb-btn--secondary"
          href={candidatesHref({ postingId, stage, cursor: nextCursor })}
          pendingLabel="Next page"
        >
          <span>Next page</span>
          <Icon name={ACTION_ICON.next} />
        </PortalLink>
      ) : null}
    </nav>
  );
}

/** A failed inbox read: in place, under the head and filter, with Retry. */
function LoadErrorState({ firstPage }: { firstPage: string | null }) {
  return (
    <Card>
      <div className="state state--error">
        <span className="state__icon">
          <Icon name="warning-circle" />
        </span>
        <h2 className="state__title">We couldn&rsquo;t load candidates</h2>
        <p className="state__body">
          This is usually temporary — nothing about your postings has changed. Please retry.
        </p>
        <div className="state__actions">
          <RetryButton />
          {/* A later page's link can go stale; the newest page is always a way back in. */}
          {firstPage ? (
            <PortalLink
              className="bb-btn bb-btn--secondary"
              href={firstPage}
              pendingLabel="First page"
            >
              <Icon name={ACTION_ICON.back} />
              <span>First page</span>
            </PortalLink>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * The server refused the page cursor in the address (a 400 — one it never minted). Calm, not an
 * error: nothing is down, and Retry would only be refused again, so the one way out is the first
 * page, the posting filter kept. The pager is not drawn under it (it follows an answered page), so
 * this is the screen's only "First page".
 */
function CursorRefusedState({ firstPage }: { firstPage: string }) {
  return (
    <Card>
      <div className="state">
        <span className="state__icon">
          <Icon name="link-break" />
        </span>
        <h2 className="state__title">This page link isn&rsquo;t valid</h2>
        <p className="state__body">
          It isn&rsquo;t one this list gave out, so there is nothing to show. Start again from the
          first page.
        </p>
        <div className="state__actions">
          <PortalLink className="bb-btn bb-btn--secondary" href={firstPage} pendingLabel="First page">
            <Icon name={ACTION_ICON.back} />
            <span>First page</span>
          </PortalLink>
        </div>
      </div>
    </Card>
  );
}

/** A 429 — the payer's own hourly read cap (or its fail-closed path). Neutral: no cause, no count. */
function RateLimitedState() {
  return (
    <Card>
      <div className="state">
        <span className="state__icon">
          <Icon name="hourglass" />
        </span>
        <h2 className="state__title">Too many requests</h2>
        <p className="state__body">Try again shortly.</p>
        <div className="state__actions">
          <RetryButton label="Try again" />
        </div>
      </div>
    </Card>
  );
}

/**
 * A posting filter that matched nothing. ONE copy for an owned posting nobody applied to and an id
 * that is not the payer's (the server answers both with the same empty page — no oracle). Its way
 * out clears the posting and keeps a stage filter the server applied.
 */
function FilteredEmptyState({ stage }: { stage: ApplicantStage | null }) {
  return (
    <Card>
      <div className="state">
        <span className="state__icon">
          <Icon name="tray" />
        </span>
        <h2 className="state__title">No applicants for this posting</h2>
        <p className="state__body">
          Nobody has applied to it yet, or it isn&rsquo;t one of your postings.
        </p>
        <div className="state__actions">
          <PortalLink
            className="bb-btn bb-btn--secondary"
            href={candidatesHref({ stage })}
            pendingLabel="All postings"
          >
            <Icon name={ACTION_ICON.clearFilters} />
            <span>All postings</span>
          </PortalLink>
        </div>
      </div>
    </Card>
  );
}

/**
 * A stage filter (applied by the server, so stages are saved) with no applicant in that stage — on
 * every posting, or on the one the posting filter names. Its way out is every stage, the posting
 * filter kept.
 */
function StageEmptyState({
  stage,
  postingId,
}: {
  stage: ApplicantStage;
  postingId: string | null;
}) {
  return (
    <Card>
      <div className="state">
        <span className="state__icon">
          <Icon name="tray" />
        </span>
        <h2 className="state__title">No applicants in {STAGE_LABEL[stage]}</h2>
        <p className="state__body">
          {postingId
            ? "Nobody who applied to this posting is in that stage right now."
            : "Nobody who applied to your postings is in that stage right now."}
        </p>
        <div className="state__actions">
          <PortalLink
            className="bb-btn bb-btn--secondary"
            href={candidatesHref({ postingId })}
            pendingLabel="All stages"
          >
            <Icon name={ACTION_ICON.clearFilters} />
            <span>All stages</span>
          </PortalLink>
        </div>
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
        <h2 className="state__title">No more applicants</h2>
        <p className="state__body">You have reached the end of this list.</p>
      </div>
    </Card>
  );
}

/**
 * Nobody has applied to any of the payer's postings yet. The way forward is the payer's own
 * postings — or, with none at all, a new one (per persona: an agency posts agency jobs).
 */
function EmptyState({ isAgency, hasPostings }: { isAgency: boolean; hasPostings: boolean }) {
  // Non-null here: an agency with the portal off never reaches this page (notFound above).
  const routes = postingRoutes(isAgency);
  return (
    <Card>
      <div className="state">
        <span className="state__icon">
          <Icon name={ACTION_ICON.candidate} />
        </span>
        <h2 className="state__title">No applicants yet</h2>
        <p className="state__body">
          Workers who apply to your postings appear here — faceless — newest first.
        </p>
        {routes ? (
          <div className="state__actions">
            {hasPostings ? (
              <PortalLink
                className="bb-btn bb-btn--secondary"
                href={routes.list}
                pendingLabel="Postings"
              >
                <Icon name={ACTION_ICON.posting} />
                <span>Postings</span>
              </PortalLink>
            ) : (
              <PortalLink
                className="bb-btn bb-btn--secondary"
                href={routes.create}
                pendingLabel="New posting"
              >
                <Icon name={ACTION_ICON.create} />
                <span>New posting</span>
              </PortalLink>
            )}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
