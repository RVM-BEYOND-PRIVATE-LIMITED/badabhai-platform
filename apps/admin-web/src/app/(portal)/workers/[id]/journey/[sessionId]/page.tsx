import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../../../lib/auth";
import { getChatSession } from "../../../../../../lib/journey";
import { isAdminRequestError } from "../../../../../../lib/admin-http";
import {
  formatCount,
  formatDuration,
  formatExactRupees,
  formatRelative,
  formatTimestamp,
  shortId,
} from "../../../../../../lib/format";
import { CaveatList } from "../../../../../../components/caveat-list";
import { DetailList } from "../../../../../../components/detail-list";
import { Stat } from "../../../../../../components/stat";
import { StatusPill } from "../../../../../../components/status-pill";
import { StuckPanel } from "../../../../../../components/stuck-panel";
import { VoiceAttempts } from "../../../../../../components/voice-attempts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Interview session" };

/**
 * ONE interview session in depth — the stuck question, the voice retry chain, the settled
 * answers, the AI jobs, and what the session cost.
 *
 * ══ WHAT IS NOT HERE, AND WHY ══════════════════════════════════════════════════════════
 * No message bodies and no transcripts. `chat_messages.body_text` and
 * `voice_notes.transcript_text` hold the worker's own words UNMASKED — pseudonymization
 * happens transiently at the LLM-call boundary only — so serving them would be a materially
 * larger exposure than any capability this portal has, and it has had no security review. The
 * API does not return them, a static guard on the server blocks the columns, and this page does
 * not go looking. What it shows instead is question KEYS and outcomes, which is what answers
 * "where did this worker get stuck".
 *
 * ══ WHY IT LIVES UNDER THE WORKER ══════════════════════════════════════════════════════
 * A session id is globally unique and the API is not nested, but the operator arrived from one
 * worker and needs the way back. The response carries its own `worker_id`, and when that
 * disagrees with the id in the path the page SAYS so and links to the right worker rather than
 * silently rendering someone else's session under this breadcrumb.
 */
export default async function ChatSessionDetailPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  await requireCapability("read_entities");
  const { id, sessionId } = await params;

  let session: Awaited<ReturnType<typeof getChatSession>>;
  try {
    session = await getChatSession(sessionId);
  } catch (err) {
    // 404 (unknown id) and 400 (not a uuid) are both "no such session" to an operator who
    // pasted an id out of a log.
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  const journeyHref = `/workers/${id}/journey`;
  const mismatched = session.worker_id !== id;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="page__eyebrow">
            <Link className="link" href={journeyHref}>
              Journey · worker {shortId(id)}
            </Link>
          </p>
          <h1 className="page__title mono">{shortId(session.id, 12)}</h1>
          <p className="page__sub">
            One AI profiling interview — what was asked, what settled, and where it stopped.
            Started {formatRelative(session.started_at)} ·{" "}
            {formatTimestamp(session.started_at)}.
          </p>
        </div>
        <div className="page__actions">
          <Link className="btn btn--ghost" href={`/workers/${session.worker_id}`}>
            Worker record
          </Link>
        </div>
      </header>

      {mismatched ? (
        <p className="notice notice--warn" role="status">
          This session belongs to worker{" "}
          <Link className="link mono" href={`/workers/${session.worker_id}/journey`}>
            {shortId(session.worker_id)}
          </Link>
          , not to the worker in this URL. The figures below are that session&rsquo;s own; the
          breadcrumb above is not.
        </p>
      ) : null}

      <CaveatList caveats={session.caveats} headingId="session-caveats" />

      {/* ---- the headline: where it stopped ----------------------------- */}
      <StuckPanel stuck={session.stuck} />

      <div className="cols">
        <section className="panel" aria-labelledby="session-facts">
          <div className="panel__head">
            <h2 className="panel__title" id="session-facts">
              Session
            </h2>
            <p className="panel__sub">
              &ldquo;Abandoned&rdquo; is written by the idle sweep, not by the worker.
            </p>
          </div>
          <DetailList
            items={[
              { label: "Session id", value: <span className="mono">{session.id}</span> },
              {
                label: "Status",
                value: (
                  <StatusPill
                    value={session.status}
                    tone={
                      session.abandoned ? "warn" : session.status === "ended" ? "ok" : "muted"
                    }
                  />
                ),
              },
              {
                label: "Started",
                value: (
                  <time dateTime={session.started_at} title={formatTimestamp(session.started_at)}>
                    {formatRelative(session.started_at)}
                  </time>
                ),
              },
              {
                label: "Ended",
                value: session.ended_at ? (
                  <time dateTime={session.ended_at} title={formatTimestamp(session.ended_at)}>
                    {formatRelative(session.ended_at)}
                  </time>
                ) : (
                  "still open"
                ),
              },
              {
                label: "Worker last spoke",
                value: session.last_message_at ? (
                  <time
                    dateTime={session.last_message_at}
                    title={formatTimestamp(session.last_message_at)}
                  >
                    {formatRelative(session.last_message_at)}
                  </time>
                ) : (
                  // Not "0s ago". No message was ever sent — the strongest abandonment
                  // signal there is, and the sweep deliberately does not stamp this field.
                  "never — no message was sent"
                ),
              },
              {
                label: "Idle since last word",
                value:
                  session.idle_seconds === null
                    ? "not applicable — they never spoke"
                    : formatDuration(session.idle_seconds),
              },
              {
                label: "Occupation pack",
                value:
                  session.pack_id === null ? (
                    "not pinned"
                  ) : (
                    <span className="mono">
                      {session.pack_id} v{session.pack_version ?? "?"}
                    </span>
                  ),
              },
            ]}
          />
          <p className="field__help">
            Only the OCCUPATION pack is pinned to a session. The universal question tail every
            interview runs is resolved fresh each turn and is never recorded here.
          </p>
        </section>

        <section className="panel" aria-labelledby="session-cost">
          <div className="panel__head">
            <h2 className="panel__title" id="session-cost">
              What this session cost
            </h2>
            <p className="panel__sub">
              Per-session AI spend, off the running totals table.
            </p>
          </div>

          {session.ai_cost ? (
            <>
              <div className="stats stats--compact">
                <Stat
                  label={`Spend since ${formatTimestamp(session.ai_cost.first_recorded_at).slice(0, 10)}`}
                  value={formatExactRupees(session.ai_cost.total_cost_inr)}
                />
                <Stat label="Calls" value={formatCount(session.ai_cost.call_count)} />
                <Stat
                  label="…that reached a real provider"
                  value={formatCount(session.ai_cost.real_call_count)}
                  tone={
                    session.ai_cost.real_call_count < session.ai_cost.call_count
                      ? "warn"
                      : undefined
                  }
                />
              </div>
              <p className="field__help">
                Last updated {formatRelative(session.ai_cost.updated_at)} ·{" "}
                {formatTimestamp(session.ai_cost.updated_at)}.
              </p>
            </>
          ) : (
            /* NO ₹0 TILE. The totals accrue only from migration 0077 forward with no
               backfill, so a session with no row was never measured — which is a different
               fact from "it was free", and the caveat band above says so in full. */
            <div className="state">
              <h3 className="state__title">No cost was recorded for this session</h3>
              <p className="state__body">
                Per-session spend is only recorded from migration 0077 forward, and nothing was
                backfilled. This session has no row — so this is an absent measurement, not a
                measured ₹0.
              </p>
            </div>
          )}

          <h3 className="panel__title" id="session-jobs">
            Extraction jobs
          </h3>
          <p className="panel__sub">
            Profile-extraction jobs correlated to this session. Error messages are not served —
            they come from an external system.
          </p>
          {session.ai_jobs.length === 0 ? (
            <p className="empty">No extraction job ran for this session.</p>
          ) : (
            <div className="tablewrap">
              <table className="table" aria-labelledby="session-jobs">
                <caption className="sr-only">Extraction jobs for this session</caption>
                <thead>
                  <tr>
                    <th scope="col">Job</th>
                    <th scope="col">Status</th>
                    <th scope="col">Model</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {session.ai_jobs.map((job) => (
                    <tr key={job.id}>
                      <th className="table__rowhead mono" scope="row" title={job.id}>
                        {shortId(job.id)}
                      </th>
                      <td>
                        <StatusPill
                          value={job.status}
                          tone={job.has_error ? "bad" : undefined}
                          title={job.has_error ? "This job recorded an error" : undefined}
                        />
                      </td>
                      <td className="table__meta">
                        {job.model_name ?? "—"}
                        {job.real_call === false ? (
                          <span className="table__meta"> · mock, not a real provider call</span>
                        ) : null}
                      </td>
                      <td className="table__meta">
                        {job.total_tokens === null ? "—" : formatCount(job.total_tokens)}
                      </td>
                      <td className="table__meta mono">
                        {/* `ai_jobs.cost_inr` is `double precision`, unlike every other ₹ on
                            this surface — shown as the server sent it rather than dressed up
                            as an exact decimal it is not. */}
                        {job.cost_inr === null ? "—" : `₹${job.cost_inr}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* ---- voice attempts --------------------------------------------- */}
      <section className="panel" aria-labelledby="session-voice">
        <div className="panel__head">
          <h2 className="panel__title" id="session-voice">
            Where they had to repeat themselves
          </h2>
          <p className="panel__sub">
            Every recorded attempt, superseded ones included — a stamped row IS the evidence
            that the worker was asked to say it again. Capture failures and transcription
            failures are different repairs and are never collapsed.
          </p>
        </div>
        <VoiceAttempts rows={session.voice_answers} />
      </section>

      {/* ---- settled answers -------------------------------------------- */}
      <section className="panel" aria-labelledby="session-answers">
        <div className="panel__head">
          <h2 className="panel__title" id="session-answers">
            Questions this session settled
          </h2>
          <p className="panel__sub">
            {formatCount(session.answer_count)} distinct question
            {session.answer_count === 1 ? "" : "s"} settled. The ANSWERS themselves are never
            served — only which question settled, how, and from where.
          </p>
        </div>

        {session.answers.length === 0 ? (
          <div className="state">
            <h3 className="state__title">Nothing settled in this session</h3>
            <p className="state__body">
              No question reached a terminal answer here. Read that with the panel above: it
              says whether the engine was still serving one when the session ended, or whether
              the interview had already closed.
            </p>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Questions settled in this session</caption>
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">How it was captured</th>
                  <th scope="col">Pack</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {session.answers.map((a) => (
                  <tr key={`${a.question_key}:${a.answered_at}`}>
                    <th className="table__rowhead mono" scope="row">
                      {a.question_key}
                    </th>
                    <td>
                      <StatusPill
                        value={a.status}
                        tone={
                          a.status === "answered"
                            ? "ok"
                            : a.status === "declined"
                              ? "muted"
                              : "warn"
                        }
                      />
                    </td>
                    <td className="table__meta">{a.source.replace(/_/g, " ")}</td>
                    <td className="table__meta mono">
                      {a.pack_id} v{a.pack_version}
                    </td>
                    <td className="table__meta">
                      <time dateTime={a.answered_at} title={formatTimestamp(a.answered_at)}>
                        {formatRelative(a.answered_at)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
