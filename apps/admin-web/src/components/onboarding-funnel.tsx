import { CountUp } from "./count-up";
import { stepTitle } from "../lib/journey-view";
import type { AdminFunnelStepCounts } from "../lib/funnel";
import { formatCount } from "../lib/format";

/**
 * The all-workers onboarding funnel (A10, #2580) — the 7 journey steps counted across
 * the whole base.
 *
 * PRESENTATIONAL ONLY. Order, keys and counts come from the server already sorted; this
 * renders them as received — a client-side order is a second definition of the funnel
 * that drifts the first time a step is inserted (the same rule `JourneyFunnel` holds).
 * Every step renders, including zeros: hiding a zero row would turn a funnel into a list
 * of achievements and remove exactly the information this screen exists for.
 *
 * MOTION: each bar grows from zero once on first render — `funnel-bar-grow` over
 * `calc(var(--duration-slow) + var(--duration-instant))` (= 400ms exactly) with
 * `var(--ease-out)`, via `transform: scaleX` (opacity + transform only, ≤6px-equivalent
 * travel is none — a scale has no travel). The first eight rows stagger by
 * `var(--stagger-step)` (30ms); the rest enter together (`--stagger-max`). Figures count
 * up over `var(--duration-count)` (600ms) through `CountUp`, which lands on the server's
 * exact text. Reduced motion zeroes the tokens, leaving bars full and figures final.
 *
 * ACCESSIBLE: the bar is decorative (`aria-hidden`) — the counts beside it are the
 * content, so colour is never the only channel. Fills use the structure token
 * (`--blue-500`, Shift Blue) on the card surface; text carries the value.
 */
export function OnboardingFunnel({
  steps,
  total,
}: {
  steps: readonly AdminFunnelStepCounts[];
  total: number;
}) {
  if (steps.length === 0) {
    return (
      <p className="empty">
        The funnel read returned no steps. That is a gap in the response, not a cohort with nothing
        in it.
      </p>
    );
  }
  return (
    <ol className="funnel funnel--bars">
      {steps.map((step, i) => {
        const share = total > 0 ? step.done / total : 0;
        const stagger = i < 8 ? { animationDelay: `calc(var(--stagger-step) * ${i})` } : undefined;
        return (
          <li className="funnel__row funnel__row--bar" key={step.key}>
            <span className="funnel__label">
              <strong>
                {step.order}. {stepTitle(step.key as Parameters<typeof stepTitle>[0])}
              </strong>
              <span className="funnel__bar" aria-hidden="true" style={stagger}>
                <span
                  className="funnel__fill"
                  style={{ transform: `scaleX(${share.toFixed(4)})` }}
                />
              </span>
            </span>
            <span className="funnel__nums">
              <span className="funnel__distinct">
                <CountUp to={step.done} text={formatCount(step.done)} kind="count" />
              </span>
              <span className="funnel__events">
                {formatCount(step.in_progress)} in progress · {formatCount(step.not_done)} not done
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
