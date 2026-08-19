import type { SessionStuck, StuckCandidate } from "../lib/journey";
import { describeStuck } from "../lib/journey-view";
import { formatCount } from "../lib/format";
import { StatusPill } from "./status-pill";

/**
 * WHERE THIS SESSION STOPPED — the stuck question, and the ranked list behind it.
 *
 * ══ THE ONE RULE ═══════════════════════════════════════════════════════════════════════
 * A question is NAMED only when {@link describeStuck} returns one, which happens only when the
 * server reported `outcome: "resolved"` AND sent a `stuck_question`. Every other outcome
 * renders an explanation and NO question — including `engine_advanced_past_all`, which is the
 * MODAL shape for a session that finished: a `close` decision carries `questionKey: null`, so
 * the orchestrator records "advanced past" for whatever was on screen and every unsettled
 * question ends up flagged that way. Naming one of them as "where the worker got stuck" would
 * accuse a question the worker met on their way to COMPLETING the interview, on most sessions.
 *
 * The ranked `candidates[]` are still shown in that shape, and are worth reading — they are the
 * questions this worker never settled. They are SUBORDINATE to the headline by construction:
 * the headline comes from `outcome`, the table is captioned by `candidatesTitle`, and the table
 * can never promote a row into the headline.
 *
 * PRESENTATIONAL ONLY. The branching lives in `lib/journey-view.ts`, tested without a DOM.
 */

/** `.notice` has two modifiers; `info`/`muted` are the neutral base. */
function noticeClass(tone: "warn" | "info" | "muted"): string {
  return tone === "warn" ? "notice notice--warn" : "notice";
}

/** How servable the engine judged a candidate — leg 2 of the server's ranking, three-valued. */
function servabilityPill(candidate: StuckCandidate) {
  if (candidate.unservable === false) {
    return <StatusPill value="servable" label="could be re-served" tone="warn" />;
  }
  if (candidate.unservable === true) {
    return <StatusPill value="unservable" label="never again" tone="muted" />;
  }
  // NULL is not "fine" and not "bad": the item resolved to no pack row, so `is_mandatory` was
  // unknown and the ranking could not judge it on this leg at all. Said, not defaulted.
  return <StatusPill value="unknown" label="unknown" tone="warn" />;
}

export function StuckPanel({ stuck }: { stuck: SessionStuck }) {
  const view = describeStuck(stuck);

  return (
    <section className="panel" aria-labelledby="stuck-heading">
      <div className="panel__head">
        <h2 className="panel__title" id="stuck-heading">
          Where this session stopped
        </h2>
        <p className="panel__sub">{view.progress}</p>
      </div>

      <p className={noticeClass(view.tone)} role="note">
        <strong>{view.headline}.</strong> {view.body}
      </p>

      {view.question ? (
        <div className="stats stats--compact">
          <div className="stat">
            <span className="stat__value mono">{view.question.question_key}</span>
            <span className="stat__label">The question on screen when it ended</span>
          </div>
          <div className="stat">
            <span className="stat__value">
              {formatCount(view.question.asks)} / {formatCount(view.question.ask_ceiling)}
            </span>
            <span className="stat__label">Times asked, against the ceiling applied</span>
          </div>
          <div className="stat">
            <span className="stat__value">
              {view.question.unservable === false
                ? "yes"
                : view.question.unservable === true
                  ? "no"
                  : "unknown"}
            </span>
            <span className="stat__label">Could the engine have served it again?</span>
          </div>
        </div>
      ) : null}

      {view.candidatesTitle && stuck.candidates.length > 0 ? (
        <>
          <h3 className="panel__title" id="stuck-candidates">
            {view.candidatesTitle}
          </h3>
          <p className="panel__sub">
            Ranked by the server, best-first. {formatCount(stuck.unresolved_count)} of them
            resolved to no pack item, so the ranking could not judge those on servability or
            position.
          </p>
          <div className="tablewrap">
            <table className="table" aria-labelledby="stuck-candidates">
              <caption className="sr-only">{view.candidatesTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col">Asked</th>
                  <th scope="col">Re-servable</th>
                  <th scope="col">Engine moved on</th>
                  <th scope="col">Pack</th>
                </tr>
              </thead>
              <tbody>
                {stuck.candidates.map((c) => (
                  <tr key={c.question_key}>
                    <th className="table__rowhead mono" scope="row">
                      {c.question_key}
                    </th>
                    <td>
                      {formatCount(c.asks)} / {formatCount(c.ask_ceiling)}
                      {c.exhausted ? (
                        <span className="table__meta"> · ceiling reached</span>
                      ) : null}
                    </td>
                    <td>{servabilityPill(c)}</td>
                    <td className="table__meta">
                      {c.engine_advanced_past ? "yes — recorded unanswered" : "no"}
                    </td>
                    <td className="table__meta mono">
                      {c.pack_id === null
                        ? "unresolved"
                        : `${c.pack_id} v${c.pack_version ?? "?"}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
