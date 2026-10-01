"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "./admin-action-button";
import { AdminActionResultBanner, timelineLink } from "./admin-action-result-banner";
import { PageHeader, type PageHeaderContent } from "./page-header";
import { reinstatePayerAction, suspendPayerAction } from "./payer-actions";
import type { AdminActionOutcome } from "../lib/admin-action-result";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * The Company/Agency detail header: the shared `PageHeader` with the (capability-gated)
 * Suspend/Reinstate control as its primary action and the "View event timeline" link after it.
 *
 * `header` is built by the server (`PayerDetailView`) and passed straight through — its JSX
 * never re-executes on the client, so the id-formatting and label logic that build it stay off
 * this bundle. Only the interactive cluster (link + button + result banner) needs to be a Client
 * Component.
 *
 * On a successful action `router.refresh()` re-fetches the payer record server-side (status,
 * `previous_status`, the suspended-notice banner) while this component's own local state — the
 * result banner — survives the refresh, exactly like `login-form.tsx`'s post-login refresh.
 */
export function PayerDetailHeader({
  header,
  payerId,
  status,
  canSuspend,
  timelineHref,
}: {
  /** Back link, title and description, built on the server. */
  header: PageHeaderContent;
  payerId: string;
  status: "pending" | "active" | "suspended";
  canSuspend: boolean;
  /** This account's event timeline, or null for a reader without `read_events`. */
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
          canSuspend ? (
            status === "suspended" ? (
              <AdminActionButton
                label="Reinstate"
                icon={ACTION_ICON.reinstate}
                confirmLabel="Confirm reinstate?"
                variant="primary"
                action={() => reinstatePayerAction(payerId)}
                onSettled={handleSettled}
              />
            ) : (
              <AdminActionButton
                label="Suspend"
                icon={ACTION_ICON.suspend}
                confirmLabel="Confirm suspend?"
                variant="danger"
                action={() => suspendPayerAction(payerId)}
                onSettled={handleSettled}
              />
            )
          ) : null
        }
        secondaryActions={
          timelineHref ? (
            <Link className="btn btn--ghost" href={timelineHref}>
              <Icon name={ACTION_ICON.timeline} />
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
