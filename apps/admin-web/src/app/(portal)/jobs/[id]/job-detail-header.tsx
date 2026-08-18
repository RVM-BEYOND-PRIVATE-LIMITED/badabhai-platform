"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "../../../../components/admin-action-button";
import { AdminActionResultBanner } from "../../../../components/admin-action-result-banner";
import { forceClosePostingAction } from "./actions";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";

/**
 * The job posting detail header: the server-rendered title block plus the owner-account link,
 * the event-timeline link, and the (capability-gated) Force-close control.
 *
 * `title` is server-rendered JSX passed straight through — see `PayerDetailHeader` for why.
 * Force-close is omitted entirely once the posting is already closed; the action is a no-op
 * there and offering it teaches nothing the status pill does not.
 */
export function JobDetailHeader({
  title,
  jobId,
  status,
  payerHref,
  canForceClose,
  timelineHref,
}: {
  title: ReactNode;
  jobId: string;
  status: string;
  payerHref: string | null;
  canForceClose: boolean;
  timelineHref: string;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);

  function handleSettled(o: AdminActionOutcome) {
    setOutcome(o);
    if (o.ok) router.refresh();
  }

  return (
    <>
      <header className="page__head">
        {title}
        <div className="page__actions">
          {payerHref && (
            <Link className="btn btn--ghost" href={payerHref}>
              Owner account
            </Link>
          )}
          <Link className="btn btn--ghost" href={timelineHref}>
            Event timeline
          </Link>
          {canForceClose && status !== "closed" && (
            <AdminActionButton
              label="Force-close"
              confirmLabel="Confirm force-close?"
              variant="danger"
              action={() => forceClosePostingAction(jobId)}
              onSettled={handleSettled}
            />
          )}
        </div>
      </header>
      {outcome && <AdminActionResultBanner outcome={outcome} timelineHref={timelineHref} />}
    </>
  );
}
