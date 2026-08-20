import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { isAdminRequestError } from "../../../lib/admin-http";
import { listAiTraces, type AiTracePage } from "../../../lib/ai-traces";
import { aiTraceErrorLabel, outcomeTone, realCallLabel } from "../../../lib/ai-trace-view";
import { taskTypeLabel } from "../../../lib/ai-cost";
import {
  formatCount,
  formatRelative,
  formatTimestamp,
  healthTone,
  shortId,
} from "../../../lib/format";
import { StatusPill } from "../../../components/status-pill";
import { Pager } from "../../../components/pager";
import { AiCallFilterBar } from "./filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI calls" };

/**
 * Smaller than the server's own ceiling of 50, and for the reason that ceiling exists: read end
 * to end, this list is an index of which workers have said how much and when. A short page does
 * not make that untrue — it makes walking the whole index cost more requests, each of which is
 * one more line in the API log. It costs nothing on the screen the page exists for (one worker,
 * one session, one bad morning).
 */
const PAGE_SIZE = 25;

/**
 * AI calls — every provider call the platform made for a worker, newest first.
 *
 * ── WHAT IS ON THIS PAGE, AND WHY IT IS SAFE ON THE ORDINARY READ FLOOR ─────────────────
 * Scalars only: when, what the call was for, which model answered, whether a provider was
 * really called, whether it succeeded, the closed-set failure code, and the two character
 * COUNTS. No prompt, no reply, no ciphertext — the server's list projection does not select
 * those columns at all, so there is nothing here for a mapper to forget to strip. A length is
 * what a size question actually needs; `feedback.submitted` ships `message_length` and never
 * the message, for the same §2 reason.
 *
 * ── THE PAGE GATE IS `read_ai_traces`, MIRRORING THE ROUTE ──────────────────────────────
 * Both legs of `/admin/ai-traces` sit on `read_ai_traces` behind a default-off flag, per the
 * owner ruling — the list included, because walked end to end it is an index of which worker
 * spoke, in which interview, when, and how much. An earlier build gated this page on
 * `read_entities` and matched an API that did the same; both moved together.
 *
 * ── THE ONE COLUMN THAT MOVES WITH THE SESSION ──────────────────────────────────────────
 * The Text column is still derived from the capability rather than assumed, and that is NOT
 * redundant with the page gate: the two are the same value today and the reason each exists is
 * different. The page gate mirrors the route; the column mirrors what the DETAIL screen will
 * accept. The day an owner reopens the list to ops, the page gate moves and this one does not —
 * so a control that read `mayReadText = true` because "we got here" would silently start
 * offering three roles a link to a 404. The COLUMN is dropped, not filled with dashes: a "Text"
 * heading over em dashes would say these calls have no text stored, which is the opposite of
 * true and is exactly what the two character counts beside it disprove. (The Workers roster
 * makes the identical ruling about its Name column.)
 *
 * ── AND THERE IS NO SEARCH ──────────────────────────────────────────────────────────────
 * See `filter-bar.tsx`. Task, outcome and one worker id — all lookups, all narrowing a page the
 * operator could already reach. Nothing searches the text, here or on the server.
 */
export default async function AiCallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Page-level gate, and the same one the list route enforces server-side. Belt and braces:
  // hiding a control is a convenience, never the boundary.
  const session = await requireCapability("read_ai_traces");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  /**
   * All three forwarded RAW. The server's query schema is `.strict()`, so a hand-edited value
   * earns a 400 that this page renders as a refusal; narrowing them here would drop them and
   * show the WHOLE list under a URL claiming a filter.
   */
  const taskType = one(sp.taskType);
  const success = one(sp.success);
  const workerId = one(sp.workerId);
  const cursor = one(sp.cursor);

  /**
   * May this session turn a stored call back into words? Read from the server-resolved
   * capability list, which `currentSession()` filters to the known vocabulary and which fails
   * closed on a malformed `/admin/me`.
   */
  const mayReadText = can(session.capabilities, "read_ai_traces");

  let page: AiTracePage | null = null;
  let rejected = false;
  try {
    page = await listAiTraces({ taskType, success, workerId, cursor, limit: PAGE_SIZE });
  } catch (err) {
    /**
     * A REFUSED REQUEST AND AN UNAVAILABLE ONE ARE DIFFERENT SCREENS. A 400 means something in
     * the address bar is not a value this list accepts — a user error, rendered inline rather
     * than tripping the error boundary. Anything else is our failure, and saying "check your
     * filters" while the API is down sends an operator to fix something that is not broken.
     */
    rejected = isAdminRequestError(err) && err.status === 400;
  }

  const failed = page === null;
  const filtered = Boolean(taskType || success || workerId);
  /** Something in the URL to undo. With a bare `/ai-calls` there is nothing to offer. */
  const resettable = Boolean(taskType || success || workerId || cursor);

  /**
   * One builder for every link back into this list, so a filter cannot be dropped by a control
   * that forgot it existed — the lesson the feedback list paid for with three hand-rolled hrefs.
   * `cursor` is dropped unless asked for: a cursor from one query applied to another returns an
   * arbitrary slice of it, which looks like data rather than an error.
   */
  const listHref = (over: { cursor?: string } = {}) => {
    const q = new URLSearchParams();
    if (taskType) q.set("taskType", taskType);
    if (success) q.set("success", success);
    if (workerId) q.set("workerId", workerId);
    if (over.cursor) q.set("cursor", over.cursor);
    const s = q.toString();
    return s ? `/ai-calls?${s}` : "/ai-calls";
  };

  /**
   * The CURRENT query, rebuilt — so "Retry" repeats what failed instead of quietly resetting
   * it. The cursor is included on purpose: an operator three pages in who hits a transient
   * failure should land back where they were, not on an unfiltered page one that looks like a
   * successful reload.
   */
  const retryHref = listHref({ cursor });

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">AI calls</h1>
          <p className="page__sub">
            Every AI call the platform made on a worker&apos;s behalf, newest first — what it was
            for, which model answered, whether a provider was really called, and how long the
            request and the reply were. The two counts are characters, not the characters
            themselves.{" "}
            {mayReadText
              ? "The text of each call is stored encrypted; opening one is a separate read, capped and recorded."
              : "The text of each call is stored encrypted and cannot be read from your role — what is on this page are its measurements."}
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="ac-filters">
        <h2 className="sr-only" id="ac-filters">
          Filter AI calls
        </h2>
        <AiCallFilterBar
          taskType={taskType ?? ""}
          success={success ?? ""}
          workerId={workerId ?? ""}
        />
      </section>

      <section className="panel" aria-labelledby="ac-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="ac-heading">
              Calls
            </h2>
            <p className="panel__sub">
              {failed
                ? "Nothing was fetched."
                : `${page?.items.length ?? 0} call${page?.items.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {filtered && (
            <Link className="btn btn--ghost" href="/ai-calls">
              Clear filters
            </Link>
          )}
        </div>

        {workerId && !failed ? (
          /* A narrowing an operator cannot SEE is one URL away from being read as the whole
             list. Rendered only when something was actually fetched: "showing only worker X"
             over a refusal or an outage is a sentence about a list that does not exist, and the
             empty screen under it would be read as an answer about that worker. */
          <p className="field__help">
            Showing only the calls made for worker{" "}
            <span className="mono">{shortId(workerId)}</span>.{" "}
            <Link className="link" href={`/workers/${encodeURIComponent(workerId)}`}>
              Open their record
            </Link>
            {" · "}
            <Link className="link" href="/ai-calls">
              Show every worker
            </Link>
          </p>
        ) : null}

        {rejected ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected this request</h3>
            <p className="state__body">
              Nothing was fetched. A task must be one this platform actually runs, an outcome is
              either succeeded or failed, a worker filter must be a full worker id, and a page
              cursor is an opaque value that cannot be hand-edited — one of them, as it stands in
              the address bar, is not something this list accepts.
            </p>
            {resettable && (
              <div className="state__actions">
                <Link className="btn btn--ghost" href="/ai-calls">
                  {filtered ? "Clear filters" : "Back to the first page"}
                </Link>
              </div>
            )}
          </div>
        ) : failed ? (
          <div className="state state--error">
            <h3 className="state__title">AI calls are unavailable</h3>
            <p className="state__body">
              The list did not load, and that is a fault on our side rather than anything in the
              filters. Nothing has been lost: traces are written as calls complete and will all be
              here once the read succeeds.
            </p>
            <div className="state__actions">
              {/* The SAME query. A retry pointed at the bare route silently drops the filters
                  and the cursor, returning an operator to page one while claiming to retry. */}
              <Link className="btn btn--ghost" href={retryHref}>
                Retry
              </Link>
            </div>
          </div>
        ) : page && page.items.length > 0 ? (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">AI calls, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Task</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Provider call</th>
                  <th scope="col">Request</th>
                  <th scope="col">Reply</th>
                  <th scope="col">Worker</th>
                  {/* Only for a session that may actually open one — see the page header for
                      why the column is dropped rather than filled with dashes. */}
                  {mayReadText && <th scope="col">Text</th>}
                </tr>
              </thead>
              <tbody>
                {page.items.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <time dateTime={t.created_at} title={formatTimestamp(t.created_at)}>
                        {formatRelative(t.created_at)}
                      </time>
                    </td>
                    <td>
                      {taskTypeLabel(t.task_type)}
                      <br />
                      {/* The model is the second thing an operator needs on a triage row and
                          the first thing they compare across rows. Null when the metadata
                          carried no label — shown as "model not labelled" rather than blank,
                          because "we do not know which model" is a fact worth reading. */}
                      <span className="table__meta mono">
                        {t.model_name ?? "model not labelled"}
                      </span>
                    </td>
                    <td>
                      <StatusPill
                        value={t.success ? "succeeded" : "failed"}
                        tone={outcomeTone(t.success)}
                      />
                      {t.error_code ? (
                        <>
                          <br />
                          <span className="table__meta" title={t.error_code}>
                            {aiTraceErrorLabel(t.error_code)}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {/* `real` reads ok and `mock` reads warn — the TD81 ruling this console
                          already applies to money and to dependency health. Simulated work must
                          never render in the same type as the real thing. */}
                      <StatusPill
                        value={realCallLabel(t.real_call)}
                        tone={healthTone(realCallLabel(t.real_call))}
                        title={
                          t.real_call
                            ? "A provider was really called for this."
                            : "No provider was called — the mock adapter answered."
                        }
                      />
                    </td>
                    <td className="table__meta">
                      <Chars value={t.prompt_chars} half="request" />
                    </td>
                    <td className="table__meta">
                      <Chars value={t.response_chars} half="reply" />
                    </td>
                    <td>
                      <Link
                        className="link mono"
                        href={`/workers/${t.worker_id}`}
                        title={t.worker_id}
                      >
                        {shortId(t.worker_id)}
                      </Link>
                      {t.session_id ? (
                        <>
                          <br />
                          {/* The interview this call belongs to. A session id is globally
                              unique but the route is nested under its worker, which is also
                              the way back — and `worker_id` comes off THIS row, so the link
                              cannot point at a session under somebody else's id. */}
                          <Link
                            className="link table__meta"
                            href={`/workers/${t.worker_id}/journey/${t.session_id}`}
                            title={`Interview session ${t.session_id}`}
                          >
                            Session
                          </Link>
                        </>
                      ) : (
                        <>
                          <br />
                          {/* Not every call belongs to an interview: a résumé generation and a
                              profile extraction are worker-owned with no chat session behind
                              them. A dash here says "no session", not "session unknown". */}
                          <span className="table__meta" title="This call was not part of an interview session.">
                            no session
                          </span>
                        </>
                      )}
                    </td>
                    {mayReadText && (
                      <td>
                        <Link className="link" href={`/ai-calls/${t.id}`}>
                          Read
                        </Link>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : cursor ? (
          /* A page PAST the first that came back empty. "No AI calls recorded yet" would be a
             claim about the whole table made from its tail, and the tail is exactly where it is
             wrong: `ai_call_traces` is an `ON DELETE cascade` child of `workers`, so an
             account-deletion sweep between two requests empties the page an operator is
             standing on while the list ahead of the cursor is still full. */
          <div className="state">
            <h3 className="state__title">Nothing further on this page</h3>
            <p className="state__body">
              This page of the list came back empty — either you have reached the end, or the rows
              behind this cursor were removed while you were reading (deleting a worker account
              erases their AI calls with it, which is how erasure works here). The list itself is
              unaffected; start again from the newest call.
            </p>
            <div className="state__actions">
              {/* KEEPS every active filter and drops only the cursor. Widening the query on the
                  way back would answer a different question than the one being paged. */}
              <Link className="btn btn--ghost" href={listHref()}>
                Back to the newest
              </Link>
            </div>
          </div>
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No AI calls match these filters</h3>
            <p className="state__body">
              Nothing on this page of the table satisfies every narrowing at once. Read an empty
              result carefully here: a task type that has never run in this environment and a task
              type that ran without a single failure produce exactly the same empty screen.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/ai-calls">
                Clear filters
              </Link>
            </div>
          </div>
        ) : (
          /* ── THE EMPTY STATE THAT MUST NOT READ AS A FAULT ───────────────────────────────
             In the default posture no provider is called at all, and a call that never reached
             a provider records nothing. So on staging and on every developer machine this table
             is permanently empty and the platform is working exactly as configured. Sending an
             operator to debug a healthy write path is the failure this copy exists to avoid. */
          <div className="state">
            <h3 className="state__title">No AI calls recorded yet</h3>
            <p className="state__body">
              A trace is written only when a call actually reaches a provider. If this environment
              is still answering AI calls from the mock adapter, nothing reaches one, nothing is
              recorded, and an empty table here is the expected result rather than a broken
              writer. Check the posture on the System screen before reading this as a fault; the
              event timeline is where you confirm AI calls are happening at all.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/system">
                Check the AI posture
              </Link>
              <Link className="btn btn--ghost" href="/events?eventName=ai.cost_recorded">
                Open the event timeline
              </Link>
            </div>
          </div>
        )}

        <Pager
          basePath="/ai-calls"
          /* Every active filter travels with the cursor. A pager carrying only the task type
             would page a worker-narrowed view straight into everyone else's calls on the second
             page, with the line above still claiming one worker. */
          params={{ taskType, success, workerId }}
          nextCursor={page?.nextCursor}
          note="Paging uses a keyset cursor, so calls completing mid-scan cannot make rows skip or repeat."
        />

        {/* A standing footnote rather than a banner: it is true on every render, and a warning
            at the top of every page load is how an operator learns to skip the one that matters.
            It belongs on the page all the same — every count made from this table is a count of
            SOME calls, and the two exclusions below are both systematic. */}
        <div className="alert alert--info">
          <div className="alert__text">
            <p className="alert__title">This is not every AI call</p>
            <p className="alert__body">
              A call that never reached a provider — the mock adapter, a spend cap, an unreachable
              AI service — leaves nothing here, because there was no provider call to record. And
              a call with no worker behind it is dropped on purpose: the payer job-posting chat and
              the skill embedding run on a posting write are both traced nowhere, because a record
              that cannot be attributed to a worker also cannot be erased with them.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * A character count, or an honest absence.
 *
 * Null does NOT mean zero and must never render as one: a zero here would say "the request was
 * empty", while null says "nothing was stored for this half of the call" — speech-to-text sends
 * audio and has no request text, and a call that failed before answering has no reply. The same
 * ruling `formatSuppressible` makes about a floored statistic.
 */
function Chars({ value, half }: { value: number | null; half: "request" | "reply" }) {
  if (value === null) {
    return (
      <span title={`Nothing was stored for the ${half} of this call.`}>—</span>
    );
  }
  return (
    <span title={`${formatCount(value)} characters`}>{formatCount(value)}</span>
  );
}
