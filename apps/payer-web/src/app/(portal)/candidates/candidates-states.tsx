import { ACTION_ICON, Icon } from "@badabhai/icons";
import { Card } from "../../../components/ds";
import { PagerLink } from "../../../components/paged-list";
import { RetryButton } from "../../../components/retry-button";

/**
 * The Candidates tab's SHARED list chrome — both views (All candidates, `/candidates`; Applied,
 * `/candidates/applied`) are keyset-paged server lists with the same refusal and outage rules, so
 * they say them the same way (docs/design/NAVIGATION.md, "A refused read is not an outage"):
 *  - a FAILED read is an in-place error card with Retry (and, on a later page, the first page —
 *    a stale link is never a dead end);
 *  - a 429 (the payer's own hourly cap, or its fail-closed path) is a neutral "too many requests";
 *  - a page cursor the server REFUSED (a 400 with a cursor in the address — one it never minted)
 *    is calm, not an error: Retry would only be refused again, so the one way out is the first
 *    page, filters kept;
 *  - the pager: "Next page" carries the server's cursor verbatim (and where its page starts);
 *    "First page" drops both. It says which rows are on screen ("Showing 21–40 of 57").
 * Server-safe (no hooks). Every link is a `PagerLink` — a `PortalLink`, so each carries the
 * navigation pending cue (no loading boundary — app/no-suspense-above-a-page.test.ts) — and the
 * heading of the list it opens takes focus when that list is drawn (#2588).
 */

/**
 * Keyset paging: "Next page" (the server's `nextCursor`, filters kept) and "First page" (no
 * cursor, filters kept) — each only when it leads somewhere — after the rows this page shows
 * (lib/list-range.ts), when that is known. Nothing when the list is one page.
 */
export function CandidatesPager({
  firstPage,
  nextPage,
  range = null,
}: {
  /** The first page of the same list — null on the first page itself. */
  firstPage: string | null;
  /** The next page — null on the last page. */
  nextPage: string | null;
  /** "Showing 21–40 of 57" — null when this page's start is not known. */
  range?: string | null;
}) {
  if (!firstPage && !nextPage) return null;
  return (
    <nav className="candidates-pager" aria-label="Candidate pages">
      {range ? <p className="candidates-pager__range">{range}</p> : null}
      {firstPage ? (
        <PagerLink className="bb-btn bb-btn--secondary" href={firstPage} pendingLabel="First page">
          <Icon name={ACTION_ICON.back} />
          <span>First page</span>
        </PagerLink>
      ) : null}
      {nextPage ? (
        <PagerLink className="bb-btn bb-btn--secondary" href={nextPage} pendingLabel="Next page">
          <span>Next page</span>
          <Icon name={ACTION_ICON.next} />
        </PagerLink>
      ) : null}
    </nav>
  );
}

/** A failed list read: in place, under the head and filter, with Retry. */
export function LoadErrorState({ firstPage, body }: { firstPage: string | null; body: string }) {
  return (
    <Card>
      <div className="state state--error">
        <span className="state__icon">
          <Icon name="warning-circle" />
        </span>
        <h2 className="state__title">We couldn&rsquo;t load candidates</h2>
        <p className="state__body">{body}</p>
        <div className="state__actions">
          <RetryButton />
          {/* A later page's link can go stale; the newest page is always a way back in. */}
          {firstPage ? (
            <PagerLink
              className="bb-btn bb-btn--secondary"
              href={firstPage}
              pendingLabel="First page"
            >
              <Icon name={ACTION_ICON.back} />
              <span>First page</span>
            </PagerLink>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * The server refused the page cursor in the address (a 400 — one it never minted). Calm, not an
 * error: nothing is down, and Retry would only be refused again, so the one way out is the first
 * page, the filters kept. The pager is not drawn under it (it follows an answered page), so this
 * is the screen's only "First page".
 */
export function CursorRefusedState({ firstPage }: { firstPage: string }) {
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
          <PagerLink className="bb-btn bb-btn--secondary" href={firstPage} pendingLabel="First page">
            <Icon name={ACTION_ICON.back} />
            <span>First page</span>
          </PagerLink>
        </div>
      </div>
    </Card>
  );
}

/** A 429 — the payer's own hourly read cap (or its fail-closed path). Neutral: no cause, no count. */
export function RateLimitedState() {
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
