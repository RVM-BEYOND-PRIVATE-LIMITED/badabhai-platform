"use client";

import { useEffect, useRef } from "react";
import type { AdminActionOutcome, AdminActionSuccess } from "../lib/admin-action-result";
import {
  ALL_ADMIN_ACTIONS_LINK,
  type ResultEventsLink,
} from "../lib/admin-links";
import { InlineNotice } from "./inline-notice";
import { useToast } from "./toast";
import type { ToastOptions } from "./toast-store";

/**
 * Re-exported for the client components that already import it from this module. Server
 * components must import from `lib/admin-links` instead — a `"use client"` module hands a
 * server importer a client reference, not the object, which made `href` undefined.
 */
export { ALL_ADMIN_ACTIONS_LINK };
export type { ResultEventsLink };

/** One record's event timeline as a result link, or none when the reader may not open it. */
export function timelineLink(href: string | null): ResultEventsLink | null {
  return href ? { href, label: "View event timeline" } : null;
}

/** The quiet success toast this action raises, with its one optional View action. */
export function successToast(
  outcome: AdminActionSuccess,
  eventsLink: ResultEventsLink | null,
): ToastOptions {
  return {
    message: outcome.message || (outcome.changed ? "Done" : "No change"),
    tone: outcome.changed ? "success" : "info",
    action: eventsLink ? { label: eventsLink.label, href: eventsLink.href } : undefined,
  };
}

/**
 * The result of a governed admin action (#2689).
 *
 * SUCCESS is a quiet toast with an optional "View…" action. A toast is the right surface for
 * something that needs no decision and does not move the operator: it announces politely, leaves
 * on its own, and never pushes the page down. `changed: false` is still a SUCCESSFUL no-op, so it
 * uses the same success/info family — never the danger tone.
 *
 * FAILURE stays IN PLACE as an inline notice with Retry, because the operator keeps everything
 * they typed and the failed control is still on screen. It is a polite live region: a recoverable
 * refusal is not an assertive error. `role="alert"` is reserved for errors that block the task
 * outright (the portal error boundary) — never for an action that can simply be retried.
 *
 * `eventsLink` is null for a session without `read_events`: the page it would open redirects them
 * away, so it is not offered (an affordance, never the gate).
 */
export function AdminActionResultBanner({
  outcome,
  eventsLink,
  onRetry,
}: {
  outcome: AdminActionOutcome;
  eventsLink: ResultEventsLink | null;
  /**
   * Re-runs the failed action. Forms pass their submit so the typed values survive; a row action
   * with no local state may omit it, in which case Retry refreshes the page.
   */
  onRetry?: () => void;
}) {
  const { show } = useToast();
  const shown = useRef<AdminActionOutcome | null>(null);

  useEffect(() => {
    if (!outcome.ok || shown.current === outcome) return;
    shown.current = outcome;
    show(successToast(outcome, eventsLink));
  }, [outcome, eventsLink, show]);

  if (outcome.ok) return null;

  return (
    <InlineNotice
      title="Action failed"
      action={{
        label: "Retry",
        onClick: onRetry ?? (() => window.location.reload()),
      }}
    >
      {outcome.error}
    </InlineNotice>
  );
}
