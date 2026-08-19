import type { SessionVoiceAnswer } from "../lib/journey";
import { describeVoiceAttempt, summariseVoiceAttempts } from "../lib/journey-view";
import { formatCount, formatDuration, formatRelative, formatTimestamp } from "../lib/format";
import { StatusPill } from "./status-pill";
import { Stat } from "./stat";

/**
 * WHERE THE WORKER HAD TO REPEAT THEMSELVES — every recorded voice attempt, superseded ones
 * included.
 *
 * ══ SUPERSEDED ROWS ARE THE POINT, NOT NOISE ═══════════════════════════════════════════
 * "Phir se bolein" writes a NEW attempt row and stamps the old one. Hiding the stamped row
 * would erase the only evidence that the worker had to say it twice — which is the single most
 * useful signal this table carries for tuning the capture. So every attempt renders, and the
 * supersession is shown as a fact about the row rather than as a reason to drop it.
 *
 * ══ CAPTURE FAILURE AND TRANSCRIPTION FAILURE ARE DIFFERENT REPAIRS ════════════════════
 * "The clip never reached storage" and "the clip became no text" fail independently, for
 * different reasons, and are fixed in different places. `describeVoiceAttempt` checks capture
 * FIRST and never collapses the two; this component only renders its verdict.
 *
 * ══ NO AUDIO, NO TRANSCRIPT ════════════════════════════════════════════════════════════
 * `has_clip` is a boolean the server derived in Postgres — the voice-note id is deliberately
 * not served, because it addresses the row holding `transcript_text`, the worker's own words
 * unmasked. There is nothing to play and nothing to read here, by design.
 */
export function VoiceAttempts({ rows }: { rows: readonly SessionVoiceAnswer[] }) {
  const summary = summariseVoiceAttempts(rows);

  if (rows.length === 0) {
    return (
      <p className="empty">
        No voice attempt was recorded in this session. That is the normal shape of a text-mode
        interview — it does not mean the worker was silent.
      </p>
    );
  }

  return (
    <>
      <div className="stats stats--compact">
        <Stat label="Attempts recorded" value={formatCount(summary.totalAttempts)} />
        <Stat
          label="Questions asked twice or more"
          value={formatCount(summary.questionsRetried)}
          tone={summary.questionsRetried > 0 ? "warn" : undefined}
        />
        <Stat
          label="Repeat recordings"
          value={formatCount(summary.extraAttempts)}
          tone={summary.extraAttempts > 0 ? "warn" : undefined}
        />
        <Stat
          label="Capture failures"
          value={formatCount(summary.captureFailures)}
          tone={summary.captureFailures > 0 ? "warn" : undefined}
        />
        <Stat
          label="Transcription failures"
          value={formatCount(summary.transcriptFailures)}
          tone={summary.transcriptFailures > 0 ? "warn" : undefined}
        />
      </div>

      <div className="tablewrap">
        <table className="table">
          <caption className="sr-only">
            Voice attempts in this session, in the order the questions were served
          </caption>
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">Attempt</th>
              <th scope="col">Outcome</th>
              <th scope="col">Why</th>
              <th scope="col">Length</th>
              <th scope="col">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const view = describeVoiceAttempt(row);
              return (
                <tr key={row.id}>
                  <th className="table__rowhead mono" scope="row">
                    {row.question_key}
                  </th>
                  <td>
                    #{row.attempt_no}
                    {row.attempt_no > 1 ? (
                      <span className="table__meta"> · they were asked to repeat</span>
                    ) : null}
                    {row.superseded_at ? (
                      <span className="table__meta"> · replaced by a later attempt</span>
                    ) : null}
                  </td>
                  <td>
                    <StatusPill value={view.label} label={view.label} tone={view.tone} />
                  </td>
                  <td className="table__meta">{view.why ?? "—"}</td>
                  <td className="table__meta">
                    {row.duration_seconds === null
                      ? "—"
                      : formatDuration(row.duration_seconds)}
                  </td>
                  <td className="table__meta">
                    <time dateTime={row.created_at} title={formatTimestamp(row.created_at)}>
                      {formatRelative(row.created_at)}
                    </time>
                    {row.purged_at ? (
                      <span className="table__meta"> · clip purged</span>
                    ) : row.has_clip ? null : (
                      <span className="table__meta"> · no clip stored</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
