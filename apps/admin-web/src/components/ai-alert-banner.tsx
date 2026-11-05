import Link from "next/link";
import { Icon } from "@badabhai/icons";
import type { AdminAiAlertsStatus } from "../lib/ai-alerts";

/**
 * The AI alert banner (A10, #2580) — one slim band on EVERY portal page while an
 * alert is active, linking to the alerts list (#2567).
 *
 * SERVER-RENDERED, in the portal layout beside the session read. It shows only when
 * something is actually breaching (`tasks[].active` or `spend_cap.active`) — an empty
 * render is a good outcome, and a console that always shows a banner teaches operators
 * to stop reading banners (the same silence rule `attention.ts` holds).
 *
 * MOTION: the band slides down once on mount — `ai-banner-in` over
 * `var(--duration-base)` (220ms) with `var(--ease-out)`, travelling
 * `var(--motion-rise)` (6px) + opacity. The layout persists across navigations, so the
 * animation runs when the alert STARTS, never again while it stays. Reduced motion
 * zeroes the tokens, leaving the band simply present.
 *
 * No client JS: the animation is CSS on mount, the link is a plain `Link`.
 */
export function AiAlertBanner({ status }: { status: AdminAiAlertsStatus | null }) {
  const breachingTasks = (status?.tasks ?? []).filter((t) => t.active);
  const spendActive = status?.spend_cap.active === true;
  if (!status || (breachingTasks.length === 0 && !spendActive)) return null;

  const taskNames = breachingTasks.map((t) => t.task_type).join(", ");
  const title = spendActive
    ? breachingTasks.length > 0
      ? `AI fallback breaching (${taskNames}) and spend cap tripped`
      : "AI spend cap tripped"
    : breachingTasks.length === 1
      ? `AI fallback breaching on ${taskNames}`
      : `AI fallback breaching on ${breachingTasks.length} tasks`;

  return (
    <div className="ai-banner alert alert--warning" role="alert">
      <span className="alert__icon" aria-hidden="true">
        <Icon name="warning-octagon" />
      </span>
      <div className="alert__text">
        <p className="alert__title">{title}</p>
        <p className="alert__body">
          Fallback ran over threshold in the last {status.window_hours}h. Details on the alerts
          list.
        </p>
      </div>
      <div className="alert__actions">
        <Link className="btn btn--ghost btn--sm" href="/alerts">
          View alerts
        </Link>
      </div>
    </div>
  );
}
