import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../../lib/auth";
import { getWorkerJourney, listWorkerChatSessions } from "../../../../../lib/journey";
import { isAdminRequestError } from "../../../../../lib/admin-http";
import { formatCount, formatDuration, formatRelative, formatTimestamp, shortId } from "../../../../../lib/format";
import { CaveatList } from "../../../../../components/caveat-list";
import { JourneyFunnel } from "../../../../../components/journey-funnel";
import { Pager } from "../../../../../components/pager";
import { StatusPill } from "../../../../../components/status-pill";

export const dynamic = "force-dynamic";
export const metadata = { title: "Worker journey" };

/** The three `chat_sessions.status` values the API's list filter accepts. */
const SESSION_STATUS_FILTERS = ["active", "ended", "abandoned"] as const;

/**
 * ONE worker's journey — the 7-step funnel, and their interview sessions.
 *
 * WHY IT EXISTS. The portal could already list workers and their aggregate counters; it could
 * not answer, for one worker, which steps they finished and where they stopped. "We are
 * building this app for users who are not habituated with apps" — so seeing where a real person
 * fell out of the product is the whole job of this screen.
 *
 * ══ NO TRANSCRIPT, ANYWHERE ON THIS SCREEN ═════════════════════════════════════════════
 * The API serves question KEYS, statuses, counts, timings and opaque ids — never
 * `chat_messages.body_text` and never `voice_notes.transcript_text`, which hold the worker's
 * own words unmasked and have had no security review for an admin read. Nothing here reaches
 * for another endpoint to fill that gap, and no screen built on this one should.
 *
 * ══ TWO INDEPENDENT READS ══════════════════════════════════════════════════════════════
 * The funnel and the session list are separate endpoints, fetched concurrently and settled
 * independently: one failing must not blank the other, and each renders its own honest failure
 * state rather than an empty section that reads as "this worker did nothing".
 */
export default async function WorkerJourneyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Both journey routes declare `read_entities` (an owner ruling, recorded in the controller).
  // Page-level gate; the API enforces it again server-side.
  await requireCapability("read_entities");

  const { id } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const cursor = one(sp.cursor);
  const rawStatus = one(sp.status);
  // Only a value the API's `.strict()` enum accepts is forwarded. An unknown one would 400 the
  // whole list read, turning a mistyped URL into a broken page.
  const status = SESSION_STATUS_FILTERS.find((s) => s === rawStatus);

  const [journeyRes, sessionsRes] = await Promise.allSettled([
    getWorkerJourney(id),
    listWorkerChatSessions(id, { cursor, status, limit: 25 }),
  ]);

  // A 404/400 on the FUNNEL read is the authoritative "no such worker" — it is the read that
  // takes the worker id directly. Both reads 404 together, but only one needs to decide.
  if (journeyRes.status === "rejected") {
    const err = journeyRes.reason;
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
  }

  const journey = journeyRes.status === "fulfilled" ? journeyRes.value : null;
  const sessions = sessionsRes.status === "fulfilled" ? sessionsRes.value : null;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="page__eyebrow">
            <Link className="link" href={`/workers/${id}`}>
              Worker {shortId(id)}
            </Link>
          </p>
          <h1 className="page__title">Journey</h1>
          <p className="page__sub">
            What this worker completed, and where they stopped. Question keys and outcomes
            only — none of their words are served to this portal.
          </p>
        </div>
        <div className="page__actions">
          <Link className="btn btn--ghost" href={`/workers/${id}/timeline`}>
            View event timeline
          </Link>
        </div>
      </header>

      {/* The honest-absence channel, above the figures it qualifies. */}
      {journey ? <CaveatList caveats={journey.caveats} headingId="journey-caveats" /> : null}

      <section className="panel" aria-labelledby="journey-funnel-heading">
        <div className="panel__head">
          <h2 className="panel__title" id="journey-funnel-heading">
            The seven steps
          </h2>
          <p className="panel__sub">
            {journey
              ? `Computed live at ${formatTimestamp(journey.generated_at)}. Every step is always reported — a step that has not happened reads "not done", never nothing.`
              : "Every step is always reported — a step that has not happened reads “not done”, never nothing."}
          </p>
        </div>

        {journey ? (
          <JourneyFunnel steps={journey.steps} />
        ) : (
          <div className="state state--error">
            <h3 className="state__title">The funnel could not be loaded</h3>
            <p className="state__body">
              The journey read failed, so these seven steps are MISSING rather than empty — do
              not read their absence as a worker who did nothing. Reload this page; the
              worker&rsquo;s own record and event timeline are separate reads and are
              unaffected.
            </p>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="journey-sessions-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="journey-sessions-heading">
              Interview sessions
            </h2>
            <p className="panel__sub">
              Newest first. <strong>Abandoned</strong> is the idle sweep&rsquo;s verdict, not
              something the worker did — and &ldquo;idle&rdquo; is measured from when they last
              spoke, so a session they opened and dropped without a word has no idle figure at
              all.
            </p>
          </div>
          {/* Status filter as plain links, not a client form: the filter belongs in the URL
              (shareable mid-incident) and this screen needs no JavaScript to apply it.
              `aria-current` marks the active one — a class alone would be invisible to a
              screen reader. */}
          <nav aria-label="Filter sessions by status" className="page__actions">
            <Link
              aria-current={status ? undefined : "page"}
              className="btn btn--ghost btn--sm"
              href={`/workers/${id}/journey`}
            >
              All
            </Link>
            {SESSION_STATUS_FILTERS.map((s) => (
              <Link
                aria-current={status === s ? "page" : undefined}
                className="btn btn--ghost btn--sm"
                href={`/workers/${id}/journey?status=${s}`}
                key={s}
              >
                {s}
              </Link>
            ))}
          </nav>
        </div>

        {sessions === null ? (
          <div className="state state--error">
            <h3 className="state__title">The session list could not be loaded</h3>
            <p className="state__body">
              The chat-sessions read failed. The funnel above came from a separate read and is
              unaffected — but the interview count it shows has no list beside it right now.
              Reload this page to try again.
            </p>
          </div>
        ) : sessions.items.length === 0 ? (
          <div className="state">
            <h3 className="state__title">
              {status ? `No ${status} sessions` : "No interview sessions yet"}
            </h3>
            <p className="state__body">
              {status
                ? "This worker has sessions in other states. Clear the filter to see them."
                : "This worker has never started the AI profiling interview. Nothing is broken — but it also means there is no profile to extract and no résumé to generate for them yet."}
            </p>
            {status ? (
              <div className="state__actions">
                <Link className="btn btn--ghost" href={`/workers/${id}/journey`}>
                  Clear filter
                </Link>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Interview sessions for this worker</caption>
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Status</th>
                  <th scope="col">Messages</th>
                  <th scope="col">Questions settled</th>
                  <th scope="col">Idle since last word</th>
                  <th scope="col">Pack</th>
                </tr>
              </thead>
              <tbody>
                {sessions.items.map((s) => (
                  <tr key={s.id}>
                    <th className="table__rowhead" scope="row">
                      <Link className="link" href={`/workers/${id}/journey/${s.id}`}>
                        <time dateTime={s.started_at} title={formatTimestamp(s.started_at)}>
                          {formatRelative(s.started_at)}
                        </time>
                      </Link>
                      <br />
                      <span className="table__meta mono">{shortId(s.id)}</span>
                    </th>
                    <td>
                      <StatusPill
                        value={s.status}
                        tone={s.abandoned ? "warn" : s.status === "ended" ? "ok" : "muted"}
                        title={
                          s.abandoned
                            ? "Written by the idle sweep — the worker did not end this session"
                            : undefined
                        }
                      />
                    </td>
                    <td>{formatCount(s.message_count)}</td>
                    <td>{formatCount(s.answer_count)}</td>
                    <td className="table__meta">
                      {s.idle_seconds === null ? (
                        // NOT "0s". Null means the worker never spoke — the strongest
                        // abandonment signal there is, and rendering it as zero would make
                        // that worker look like they had just been active.
                        <span title="This worker never sent a message in this session">
                          never spoke
                        </span>
                      ) : (
                        formatDuration(s.idle_seconds)
                      )}
                    </td>
                    <td className="table__meta mono">
                      {s.pack_id === null ? "—" : `${s.pack_id} v${s.pack_version ?? "?"}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Pager
          basePath={`/workers/${id}/journey`}
          params={{ status }}
          nextCursor={sessions?.nextCursor}
          note="Paging uses a keyset cursor on (started_at, id), so a session starting mid-scan cannot make rows skip or repeat."
        />
      </section>
    </div>
  );
}
