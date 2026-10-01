import type { ReactNode } from "react";
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

/**
 * The longest run of a key rendered without a break opportunity. The mono face at the 22px
 * phone step is ~12.65px a character, so 16 characters is a ~236px tile with its 34px of padding
 * and border — inside the 254px row of a 320px phone. The longest segment of any pack key today
 * is 16 with its underscore (`troubleshooting_`), so real keys break only at underscores.
 */
const MAX_UNBROKEN = 16;

/**
 * A question key with a line-break opportunity after each `_` (and inside any run longer than
 * {@link MAX_UNBROKEN}, which no pack key has today).
 *
 * The key sits in a stat tile, and a tile never shrinks below its unbroken value (that is what
 * keeps a count from splitting). Underscores are not break points, so `maintenance_documentation`
 * was one 25-character word: a 350px tile at the 22px phone step, wider than a 309px row at
 * 375px, and the page scrolled sideways. `<wbr>` adds no text, so a copied key is intact.
 */
function breakableKey(key: string) {
  const out: ReactNode[] = [];
  key.split("_").forEach((segment, i, all) => {
    const text = i < all.length - 1 ? `${segment}_` : segment;
    for (let at = 0; at < text.length; at += MAX_UNBROKEN) {
      if (out.length > 0) out.push(<wbr key={out.length} />);
      out.push(text.slice(at, at + MAX_UNBROKEN));
    }
  });
  return out;
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
            <span className="stat__value mono">
              {breakableKey(view.question.question_key)}
            </span>
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
