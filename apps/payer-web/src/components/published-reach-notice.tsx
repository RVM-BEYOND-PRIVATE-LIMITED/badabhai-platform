import { Icon } from "@badabhai/icons";
import { publishedReachMessage } from "../lib/published-reach";

/**
 * The post-publish confirmation on the page a publish lands on: "Posting published — Reached N
 * workers". Renders NOTHING without a count — the landing page is also reached by plain links,
 * and a publish whose reach read failed shows no number rather than a made-up one.
 *
 * The portal's page-level `alert` (as the draft notice beside it), `role="status"` so a screen
 * reader announces it once on arrival.
 */
export function PublishedReachNotice({ reached }: { reached: number | null }) {
  if (reached === null) return null;
  return (
    <div className="alert alert--success" role="status">
      <Icon name="check-circle" className="alert__icon" />
      <div className="alert__text">
        <p className="alert__title">Posting published</p>
        <p className="alert__body">{publishedReachMessage(reached)}</p>
      </div>
    </div>
  );
}
