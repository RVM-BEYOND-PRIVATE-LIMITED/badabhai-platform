"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "../../../../components/admin-action-button";
import { AdminActionResultBanner } from "../../../../components/admin-action-result-banner";
import { PageHeader, type PageHeaderContent } from "../../../../components/page-header";
import { forceClosePostingAction } from "./actions";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";

/**
 * The posting detail header: the shared `PageHeader` with the (capability-gated) Force-close
 * control as its primary action, then the owner-account and event-timeline links.
 *
 * `header` is server-built and passed straight through — see `PayerDetailHeader` for why.
 * Force-close is omitted entirely once the posting is already closed; the action is a no-op
 * there and offering it teaches nothing the status pill does not.
 */
export function JobDetailHeader({
  header,
  jobId,
  status,
  payerHref,
  canForceClose,
  timelineHref,
}: {
  /** Back link, title and description, built on the server. */
  header: PageHeaderContent;
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
          <>
            {payerHref && (
              <Link className="btn btn--ghost" href={payerHref}>
                Owner account
              </Link>
            )}
            <Link className="btn btn--ghost" href={timelineHref}>
              View event timeline
            </Link>
          </>
        }
      />
      {outcome && <AdminActionResultBanner outcome={outcome} timelineHref={timelineHref} />}
    </>
  );
}
