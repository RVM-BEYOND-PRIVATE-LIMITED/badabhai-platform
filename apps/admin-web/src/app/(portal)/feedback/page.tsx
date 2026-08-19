import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { isAdminRequestError } from "../../../lib/admin-http";
import {
  FEEDBACK_CATEGORIES,
  listFeedback,
  type FeedbackCategory,
  type FeedbackPage,
} from "../../../lib/feedback";
import { formatRelative, formatTimestamp, shortId } from "../../../lib/format";
import { StatusPill, type Tone } from "../../../components/status-pill";
import { Pager } from "../../../components/pager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Feedback" };

/**
 * Smaller than the 50 the route would default to. Every other list on this console is a row
 * of ids and enums; here one row can be a paragraph, and fifty paragraphs is a wall rather
 * than a page. The keyset pager makes a short page cheap.
 */
const PAGE_SIZE = 25;

/**
 * How each tag reads, and how loudly.
 *
 * The tone is passed EXPLICITLY. `StatusPill`'s own map keys off the VALUE and knows none of
 * these three, so all of them would fall through to `warn` — an amber pill on every row,
 * which makes the one tag that is a fault report indistinguishable from a compliment. Only
 * `problem` claims that tone; a suggestion and an untyped "other" are neutral, and neither
 * claims `ok` either, because "a worker wrote in" is not by itself good news.
 *
 * The chip label is PLURAL and the pill is not, deliberately: a chip filters a set ("show me
 * the problems"), a pill describes the single row it sits on.
 */
const CATEGORY: Record<FeedbackCategory, { chip: string; tone: Tone; hint: string }> = {
  suggestion: {
    chip: "Suggestions",
    tone: "muted",
    hint: "The worker tagged this as a suggestion.",
  },
  problem: { chip: "Problems", tone: "warn", hint: "The worker tagged this as a problem." },
  other: { chip: "Other", tone: "muted", hint: "The worker tagged this as neither." },
};

/**
 * Feedback — what workers typed into the app's Feedback button, newest first.
 *
 * ── THE ONE SCREEN ON THIS CONSOLE THAT SHOWS A WORKER'S OWN WORDS ──────────────────────
 * Every other list here is faceless because the server sends nothing else. This one prints
 * `message`, and a worker writing to us in free text may well name themselves, their
 * employer, or a phone number inside it. That is sanctioned (#997): they chose to say it to
 * us, and reading it is the entire point of the feature.
 *
 * What is NOT sanctioned, and is absent by construction rather than by discipline: the
 * worker is the same opaque id the rest of the portal shows — no name, no phone, no join
 * that could grow one — and there is no search over the message body. Category is the only
 * filter, because a substring search across worker free text is a PII discovery tool, not a
 * convenience. Identity still has exactly one door, on the worker detail screen, behind its
 * own capability and its own audit record.
 *
 * There is no reply, no status and no assignment here either. #997 asked for a way for a
 * worker to reach us and a way for ops to read it; inventing a triage lifecycle on the
 * screen would be inventing business logic nobody has ruled on.
 *
 * ── THE HALF THIS SCREEN WAS MISSING ────────────────────────────────────────────────────
 * Feedback is WORDS WITH NO BEHAVIOUR: a worker says the apply button is broken and this
 * page cannot say whether they ever reached a job, how far the interview got, or where they
 * stopped. The journey screen is the mirror image — behaviour with no words. So every row
 * now links to its worker's journey, and the journey screen links back here narrowed to that
 * worker. Neither link crosses a capability boundary: `/workers/:id/journey` declares the
 * same `read_entities` this page is already behind.
 */
export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Page-level gate. Belt and braces: the route enforces `read_entities` server-side too.
  const session = await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const category = one(sp.category);
  /**
   * Forwarded RAW, exactly like `category` and for the same reason: the server's schema is
   * `.uuid()`, so a hand-edited value earns a 400 this page renders as a refusal. Narrowing
   * it here would drop it and show every worker's messages under a URL claiming to show one
   * worker's — and an operator reading a stranger's complaints would have no way to know.
   */
  const workerId = one(sp.workerId);
  const cursor = one(sp.cursor);

  /**
   * The journey screen declares the SAME `read_entities` this page is already behind, so in
   * practice this is always true. Derived from the session anyway, never hardcoded, and
   * passed down per row: the day either side's capability narrows, the link moves with it
   * instead of becoming a control that redirects. (The worker detail header makes exactly
   * this call for exactly this reason.)
   */
  const mayOpenJourney = can(session.capabilities, "read_entities");

  let page: FeedbackPage | null = null;
  let rejected = false;
  try {
    page = await listFeedback({ category, workerId, cursor, limit: PAGE_SIZE });
  } catch (err) {
    /**
     * A REFUSED REQUEST AND AN UNAVAILABLE ONE ARE DIFFERENT SCREENS.
     *
     * A 400 means something in the address bar is not a value this list accepts — a user
     * error, rendered inline rather than tripping the error boundary and losing the whole
     * page. Anything else is our failure, and saying "check your filters" while the API is
     * down would send an operator to fix something that is not broken.
     */
    rejected = isAdminRequestError(err) && err.status === 400;
  }

  const failed = page === null;
  const filtered = Boolean(category || workerId);
  /** Something in the URL to undo. With a bare `/feedback` there is nothing to offer. */
  const resettable = Boolean(category || workerId || cursor);

  /**
   * One builder for every link back into this list, so a filter cannot be dropped by a
   * control that forgot it existed. That is not hypothetical: this page shipped with three
   * hand-rolled hrefs, and adding a second filter to them one at a time is exactly how the
   * "Back to the newest" link would have quietly widened a worker-narrowed view into
   * everyone's messages.
   *
   * Named arguments over the CURRENT query — pass `undefined` to keep a filter, `null` to
   * drop it. `cursor` is dropped unless asked for, because a cursor from one query applied
   * to another returns an arbitrary slice of it, which looks like data rather than an error.
   */
  const listHref = (over: {
    category?: string | null;
    workerId?: string | null;
    cursor?: string | null;
  } = {}) => {
    const pick = (next: string | null | undefined, current: string | undefined) =>
      next === undefined ? current : (next ?? undefined);
    const q = new URLSearchParams();
    const c = pick(over.category, category);
    const w = pick(over.workerId, workerId);
    const k = over.cursor ?? undefined;
    if (c) q.set("category", c);
    if (w) q.set("workerId", w);
    if (k) q.set("cursor", k);
    const s = q.toString();
    return s ? `/feedback?${s}` : "/feedback";
  };

  /**
   * The CURRENT query, rebuilt — so "Retry" repeats what failed instead of quietly
   * resetting it. `cursor` is included deliberately: an operator three pages into the list
   * who hits a transient failure should land back where they were, not on an unfiltered
   * page one that looks like a successful reload.
   */
  const retryHref = listHref({ cursor });

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Feedback</h1>
          <p className="page__sub">
            What workers typed into the app&apos;s Feedback button, newest first. This is the one
            screen here that shows a worker&apos;s own words, so a message may contain details they
            chose to include about themselves. Nothing else on the row is identifying — no name or
            number is looked up, and the screen a message is about is stored as a route pattern
            with ids stripped out of it, so it says where the worker was rather than what they
            were looking at.
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="fb-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="fb-heading">
              Messages
            </h2>
            <p className="panel__sub">
              {failed
                ? "Nothing was fetched."
                : `${page?.items.length ?? 0} message${page?.items.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {filtered && (
            <Link className="btn btn--ghost" href="/feedback">
              {category && workerId ? "Clear filters" : "Clear filter"}
            </Link>
          )}
        </div>

        <div className="filters filters--inline">
          {FEEDBACK_CATEGORIES.map((c) => (
            <Link
              aria-current={c === category ? "true" : undefined}
              className={`btn btn--sm ${c === category ? "btn--primary" : "btn--ghost"}`}
              /* KEEPS an active worker narrowing and DROPS the cursor. Picking a tag while
                 looking at one worker means "this worker's problems", not "everyone's". */
              href={listHref({ category: c })}
              key={c}
            >
              {CATEGORY[c].chip}
            </Link>
          ))}
        </div>

        {workerId && !failed ? (
          /* The worker narrowing has no chip, because its value is a uuid rather than one of
             a closed set — so it is stated in words instead, with the id visible and a way
             back out. An operator who cannot see WHICH narrowing is applied is one URL away
             from reading a filtered page as the whole list.
             AND ONLY WHEN SOMETHING WAS FETCHED. "Showing only what worker X sent" over a
             refusal or an outage is a sentence about a list that does not exist — the reader
             would take an empty screen for an answer about that worker. */
          <p className="field__help">
            Showing only what worker <span className="mono">{shortId(workerId)}</span> sent.{" "}
            <Link className="link" href={`/workers/${encodeURIComponent(workerId)}`}>
              Open their record
            </Link>
            {mayOpenJourney ? (
              <>
                {" · "}
                <Link className="link" href={`/workers/${encodeURIComponent(workerId)}/journey`}>
                  See what they did
                </Link>
              </>
            ) : null}
            {" · "}
            <Link className="link" href={listHref({ workerId: null })}>
              Show every worker
            </Link>
          </p>
        ) : null}

        {rejected ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected this request</h3>
            <p className="state__body">
              Nothing was fetched. A category must be one of the three tags the app offers, a
              worker filter must be a full worker id, and a page cursor is an opaque value that
              cannot be hand-edited — one of them, as it stands in the address bar, is not
              something this list accepts.
            </p>
            {resettable && (
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/feedback">
                  {filtered
                    ? category && workerId
                      ? "Clear filters"
                      : "Clear filter"
                    : "Back to the first page"}
                </Link>
              </div>
            )}
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">Feedback is unavailable</h3>
            <p className="state__body">
              The list did not load, and that is a fault on our side rather than anything in the
              filters. Nothing has been lost: submissions are stored as they arrive and will all be
              here once the read succeeds.
            </p>
            <div className="state__actions">
              {/* Repeat the SAME query. Pointing a retry at the bare route silently drops
                  the filter and the cursor, so a transient failure would return an operator
                  to page one while claiming to have retried. */}
              <Link className="btn btn--ghost" href={retryHref}>
                Retry
              </Link>
            </div>
          </div>
        ) : page && page.items.length > 0 ? (
          <div className="tablewrap">
            {/* `table--prose` widens the row rhythm for the message column — see the rule
                in globals.css, and the `cell--message` note with it. */}
            <table className="table table--prose">
              <caption className="sr-only">Worker feedback, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Worker</th>
                  <th scope="col">Category</th>
                  <th scope="col">Build</th>
                  <th scope="col">Screen</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <time dateTime={f.created_at} title={formatTimestamp(f.created_at)}>
                        {formatRelative(f.created_at)}
                      </time>
                    </td>
                    <td>
                      <Link
                        className="link mono"
                        href={`/workers/${f.worker_id}`}
                        title={f.worker_id}
                      >
                        {shortId(f.worker_id)}
                      </Link>
                      {mayOpenJourney ? (
                        /* THE OTHER HALF OF THIS ROW. The message is what the worker said;
                           the journey is what they did. Reading "the apply button does not
                           work" without knowing whether they ever reached a job, or where
                           the interview stopped, is guessing — and the alternative today is
                           copying the id into another screen by hand. */
                        <>
                          <br />
                          <Link
                            className="link table__meta"
                            href={`/workers/${f.worker_id}/journey`}
                            title="What this worker completed, and where they stopped"
                          >
                            Journey
                          </Link>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {f.category ? (
                        <StatusPill
                          value={f.category}
                          tone={CATEGORY[f.category].tone}
                          title={CATEGORY[f.category].hint}
                        />
                      ) : (
                        // UNTAGGED IS NOT "OTHER". The app omits the tag entirely when the
                        // worker skips it, and rendering the third chip here would turn
                        // "did not say" into "said neither" on a screen ops will count.
                        <span className="table__meta" title="The worker did not tag this.">
                          —
                        </span>
                      )}
                    </td>
                    <td className="table__meta">
                      {f.app_build ? (
                        <span className="mono" title={`x-app-build: ${f.app_build}`}>
                          {f.app_build}
                        </span>
                      ) : (
                        // The stamp was missing or malformed at submit time and the server
                        // stored null rather than losing a worker's feedback over a header
                        // nobody asked them for. "Unknown build" is the honest reading.
                        <span title="No usable build stamp arrived with this submission.">—</span>
                      )}
                    </td>
                    <td className="table__meta cell--screen">
                      {f.screen_context ? (
                        /* The tooltip states what the server DOES, not an absolute. It
                           substitutes id-shaped values (uuids, long hex, long number runs)
                           before storing, which is why the column is allowed here at all —
                           but it is a denylist, so telling an operator the value "can never
                           identify anyone" would be telling them a stripped value is safe to
                           trust when a hostile client could still park a token in it. */
                        <span
                          className="mono"
                          title="The route the worker was on. Ids in it — uuids and long number runs — are replaced with :id before it is stored, so it says which SCREEN rather than which job. It is a label, not a lookup key."
                        >
                          {f.screen_context}
                        </span>
                      ) : (
                        // Three different causes — an app older than the field, a client that
                        // sent nothing, and a value the server refused to normalise — and this
                        // page can tell them apart from none of them. "We do not know which
                        // screen" is the only claim the row supports, so it is the one made:
                        // the same dash the untagged category renders, for the same reason.
                        <span title="This submission arrived without a screen — an older app build, or a value that could not be normalised.">
                          —
                        </span>
                      )}
                    </td>
                    <td className="cell--message">{f.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : cursor ? (
          /* A page PAST the first that came back empty. "No feedback submitted yet" would be a
             claim about the whole table made from its tail — and the tail is exactly where it is
             wrong, because rows behind a cursor disappear routinely: `worker_feedback` is an
             `ON DELETE cascade` child of `workers`, so an account-deletion sweep between two
             requests empties the page an operator is standing on while the list ahead of the
             cursor is still full. Sending them to debug a healthy submit path is the failure. */
          <div className="state">
            <h3 className="state__title">Nothing further on this page</h3>
            <p className="state__body">
              This page of the list came back empty — either you have reached the end, or the rows
              behind this cursor were removed while you were reading (deleting a worker account
              removes their feedback with it). The list itself is unaffected; start again from the
              newest submission.
            </p>
            <div className="state__actions">
              {/* KEEPS every active filter and drops only the cursor. Widening the query on
                  the way back would answer a different question than the one being paged —
                  and on a worker-narrowed view it would hand the operator everyone else's
                  messages while the copy still said "start again from the newest". */}
              <Link className="btn btn--ghost" href={listHref()}>
                Back to the newest
              </Link>
            </div>
          </div>
        ) : filtered ? (
          /* AN EMPTY FILTERED PAGE IS NOT ONE CLAIM BUT THREE. "No feedback carries this tag"
             under a worker narrowing would answer a question nobody asked and hide the one
             they did — and "this worker has sent nothing" said while a tag is also applied
             would be flatly false the moment they had written in untagged. Neither value is
             echoed into the copy: the tag is named by the highlighted chip and the worker by
             the line above, both of which are already on screen. */
          <div className="state">
            <h3 className="state__title">
              {workerId && category
                ? "Nothing from this worker carries this tag"
                : workerId
                  ? "This worker has sent no feedback"
                  : "No feedback carries this tag"}
            </h3>
            <p className="state__body">
              {workerId && category
                ? "They have submitted nothing under the selected tag. Tagging is optional in the app, so a message from them about exactly this may be sitting untagged — drop the tag to see everything they sent."
                : workerId
                  ? "Nothing has arrived from this worker. Read that as silence and nothing more: most workers never open the Feedback button at all, so this is the ordinary case rather than evidence that anything went well. What they actually did is on their journey."
                  : "Nothing has been submitted under the selected tag. Tagging is optional in the app, so a message about exactly this may well be sitting in the list untagged — clear the filter to see every submission, newest first."}
            </p>
            <div className="state__actions">
              {workerId && category ? (
                <Link className="btn btn--ghost" href={listHref({ category: null })}>
                  Drop the tag
                </Link>
              ) : null}
              {workerId && mayOpenJourney ? (
                <Link
                  className="btn btn--ghost"
                  href={`/workers/${encodeURIComponent(workerId)}/journey`}
                >
                  Open their journey
                </Link>
              ) : null}
              <Link className="btn btn--ghost" href="/feedback">
                {category && workerId ? "Clear filters" : "Clear filter"}
              </Link>
            </div>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No feedback submitted yet</h3>
            <p className="state__body">
              Workers reach this from the Feedback button in the app, and their messages appear here
              the moment they send one. If you expected some, the audit spine is where you confirm
              the submit path is running at all — every submission records an event, whether or not
              anyone has read the message.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/events?eventName=feedback.submitted">
                Open the event timeline
              </Link>
            </div>
          </div>
        )}

        <Pager
          basePath="/feedback"
          /* Every active filter travels with the cursor. A pager that carried only the tag
             would page a worker-narrowed view straight into everyone else's messages on the
             second page, with the heading still claiming one worker. */
          params={{ category, workerId }}
          nextCursor={page?.nextCursor}
          note="Paging uses a keyset cursor, so feedback arriving mid-scan cannot make rows skip or repeat."
        />
      </section>
    </div>
  );
}
