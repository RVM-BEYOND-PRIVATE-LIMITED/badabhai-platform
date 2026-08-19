import type { JourneyStep } from "../lib/journey";
import {
  describeStepDetail,
  describeStepProgress,
  stepBlurb,
  stepStatusLabel,
  stepTitle,
  stepTone,
} from "../lib/journey-view";
import { formatRelative, formatTimestamp } from "../lib/format";
import { StatusPill } from "./status-pill";

/**
 * ONE worker's 7-step funnel: login → profiling → résumé → profile confirmed → search/apply →
 * photo → interview kit.
 *
 * ── THE ORDER IS THE SERVER'S ───────────────────────────────────────────────────────────
 * Every step carries `order` (1..7) and the API returns them already sorted, so this renders
 * them as received rather than sorting on a key list of its own — a client-side order is a
 * second definition of the funnel that drifts the first time a step is inserted.
 *
 * ── EVERY STEP IS ALWAYS RENDERED, INCLUDING `not_done` ─────────────────────────────────
 * The API never omits a step; it reports `not_done`. Hiding those rows would turn a funnel into
 * a list of achievements and remove exactly the information an operator opens this page for —
 * where the worker stopped. `not_done` is toned MUTED, not bad: most workers have simply not
 * got there yet, and a column of red reads as seven failures.
 *
 * PRESENTATIONAL ONLY. Titles, blurbs, progress strings and per-step chips all come from
 * `lib/journey-view.ts`, where they are unit-tested without a DOM.
 */
export function JourneyFunnel({ steps }: { steps: readonly JourneyStep[] }) {
  if (steps.length === 0) {
    return (
      <p className="empty">
        The journey read returned no steps. That is a gap in the response, not a worker who
        has done nothing.
      </p>
    );
  }

  return (
    <ol className="funnel">
      {steps.map((step) => {
        const progress = describeStepProgress(step);
        const details = describeStepDetail(step);
        return (
          <li className="funnel__row" key={step.key}>
            <span className="funnel__label">
              <strong>
                {step.order}. {stepTitle(step.key)}
              </strong>
              <br />
              <span className="funnel__events">{stepBlurb(step.key)}</span>
              {details.length > 0 ? (
                <ul className="chips">
                  {details.map((chip) => (
                    <li className="chip" key={chip}>
                      {chip}
                    </li>
                  ))}
                </ul>
              ) : null}
            </span>
            <span className="funnel__nums">
              {progress ? <span className="funnel__distinct">{progress}</span> : null}
              {step.last_at ? (
                <time
                  className="funnel__events"
                  dateTime={step.last_at}
                  title={formatTimestamp(step.last_at)}
                >
                  {formatRelative(step.last_at)}
                </time>
              ) : null}
              <StatusPill
                value={step.status}
                label={stepStatusLabel(step.status)}
                tone={stepTone(step.status)}
              />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
