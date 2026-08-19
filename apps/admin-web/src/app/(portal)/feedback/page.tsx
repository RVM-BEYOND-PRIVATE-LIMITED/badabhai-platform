import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
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
 */
export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Page-level gate. Belt and braces: the route enforces `read_entities` server-side too.
  await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const category = one(sp.category);
  const cursor = one(sp.cursor);

  let page: FeedbackPage | null = null;
  let rejected = false;
  try {
    page = await listFeedback({ category, cursor, limit: PAGE_SIZE });
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
  const filtered = Boolean(category);
  /** Something in the URL to undo. With a bare `/feedback` there is nothing to offer. */
  const resettable = Boolean(category || cursor);

  /**
   * The CURRENT query, rebuilt — so "Retry" repeats what failed instead of quietly
   * resetting it. `cursor` is included deliberately: an operator three pages into the list
   * who hits a transient failure should land back where they were, not on an unfiltered
   * page one that looks like a successful reload.
   */
  const retryHref = (() => {
    const q = new URLSearchParams();
    if (category) q.set("category", category);
    if (cursor) q.set("cursor", cursor);
    const s = q.toString();
    return s ? `/feedback?${s}` : "/feedback";
  })();

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Feedback</h1>
          <p className="page__sub">
            What workers typed into the app&apos;s Feedback button, newest first. This is the one
            screen here that shows a worker&apos;s own words, so a message may contain details they
            chose to include about themselves. Nothing else on the row is identifying — no name or
            number is looked up.
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
              Clear filter
            </Link>
          )}
        </div>

        <div className="filters filters--inline">
          {FEEDBACK_CATEGORIES.map((c) => (
            <Link
              aria-current={c === category ? "true" : undefined}
              className={`btn btn--sm ${c === category ? "btn--primary" : "btn--ghost"}`}
              href={`/feedback?category=${c}`}
              key={c}
            >
              {CATEGORY[c].chip}
            </Link>
          ))}
        </div>

        {rejected ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected this request</h3>
            <p className="state__body">
              Nothing was fetched. A category must be one of the three tags the app offers, and a
              page cursor is an opaque value that cannot be hand-edited — one of them, as it stands
              in the address bar, is not something this list accepts.
            </p>
            {resettable && (
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/feedback">
                  {filtered ? "Clear filter" : "Back to the first page"}
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
              <Link
                className="btn btn--ghost"
                href={filtered ? `/feedback?category=${category}` : "/feedback"}
              >
                Back to the newest
              </Link>
            </div>
          </div>
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No feedback carries this tag</h3>
            {/* The tag is not echoed into the copy: it comes straight off the query string,
                and the highlighted chip above already says which one is active. */}
            <p className="state__body">
              Nothing has been submitted under the selected tag. Tagging is optional in the app, so
              a message about exactly this may well be sitting in the list untagged — clear the
              filter to see every submission, newest first.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/feedback">
                Clear filter
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
          params={{ category }}
          nextCursor={page?.nextCursor}
          note="Paging uses a keyset cursor, so feedback arriving mid-scan cannot make rows skip or repeat."
        />
      </section>
    </div>
  );
}
