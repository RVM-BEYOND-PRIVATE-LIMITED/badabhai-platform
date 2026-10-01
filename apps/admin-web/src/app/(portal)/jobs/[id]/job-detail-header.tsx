"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "../../../../components/admin-action-button";
import {
  AdminActionResultBanner,
  timelineLink,
} from "../../../../components/admin-action-result-banner";
import { PageHeader, type PageHeaderContent } from "../../../../components/page-header";
import { forceClosePostingAction } from "./actions";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";

/**
 * The posting detail header: the shared `PageHeader` with the (capability-gated) Force-close
 * control as its primary action, then the event-timeline link.
 *
 * No "Owner account" link here: the State and reach panel's Owner account row already links the
 * owner, by its id, and the same destination twice on one screen is noise (owner brief
 * 2026-10-01).
 *
 * `header` is server-built and passed straight through — see `PayerDetailHeader` for why.
 * Force-close is omitted entirely once the posting is already closed; the action is a no-op
 * there and offering it teaches nothing the status pill does not.
 */
export function JobDetailHeader({
  header,
  jobId,
  status,
  canForceClose,
  timelineHref,
}: {
  /** Back link, title and description, built on the server. */
  header: PageHeaderContent;
  jobId: string;
  status: string;
  canForceClose: boolean;
  /** This posting's event timeline, or null for a reader without `read_events`. */
  timelineHref: string | null;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);

  function handleSettled(o: AdminActionOutcome) {
    setOutcome(o);
    if (o.ok) router.refresh();
  }

  return (
    <>
      <PageHeader
        {...header}
        primaryAction={
          canForceClose && status !== "closed" ? (
            <AdminActionButton
              label="Force-close"
              confirmLabel="Confirm force-close?"
              variant="danger"
              action={() => forceClosePostingAction(jobId)}
              onSettled={handleSettled}
            />
          ) : null
        }
        secondaryActions={
          timelineHref ? (
            <Link className="btn btn--ghost" href={timelineHref}>
              View event timeline
            </Link>
          ) : null
        }
      />
      {outcome && (
        <AdminActionResultBanner outcome={outcome} eventsLink={timelineLink(timelineHref)} />
      )}
    </>
  );
}
