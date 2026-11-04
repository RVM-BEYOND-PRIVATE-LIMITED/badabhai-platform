"use client";

import { Icon } from "@badabhai/icons";
import { CountUp } from "./ds/count-up";
import { formatReach, reachUnit } from "../lib/published-reach";

/**
 * The post-publish confirmation on the page a publish lands on: "Posting published — Reached N
 * workers". Renders NOTHING without a count — the landing page is also reached by plain links,
 * and a publish whose reach read failed shows no number rather than a made-up one.
 *
 * ZERO is not a success to celebrate: a posting that reaches nobody yet gets the neutral info
 * alert and says so plainly, never a green "Reached 0 workers".
 *
 * THE COUNT COUNTS UP (#2585): N is the real reach the publish read back (`?reached=`, see
 * lib/published-reach.ts), and on the publish's own landing it counts up from 0 over
 * --duration-count — once, no loop, nothing under reduced motion. The server's HTML and a reload
 * print N settled (components/ds/count-up.tsx), and the unit is N's own, so "worker(s)" never
 * flips mid-count. A client component only because the count's formatter is a function.
 *
 * The portal's page-level `alert` (as the draft notice beside it), `role="status"` so a screen
 * reader announces it once on arrival — the final figure only (the moving digits are hidden).
 */
export function PublishedReachNotice({ reached }: { reached: number | null }) {
  if (reached === null) return null;
  if (reached === 0) {
    return (
      <div className="alert alert--info" role="status">
        <Icon name="info" className="alert__icon" />
        <div className="alert__text">
          <p className="alert__title">Posting published</p>
          <p className="alert__body">No matching workers yet — they will see it as they join.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="alert alert--success" role="status">
      <Icon name="check-circle" className="alert__icon" />
      <div className="alert__text">
        <p className="alert__title">Posting published</p>
        <p className="alert__body">
          Reached{" "}
          <span className="ui-num">
            <CountUp from={0} to={reached} format={formatReach} />
          </span>{" "}
          {reachUnit(reached)}
        </p>
      </div>
    </div>
  );
}
