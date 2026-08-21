"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "./admin-action-button";
import { AdminActionResultBanner } from "./admin-action-result-banner";
import { reinstatePayerAction, suspendPayerAction } from "./payer-actions";
import type { AdminActionOutcome } from "../lib/admin-action-result";

/**
 * The Company/Agency detail header: the server-rendered title block plus the (possibly
 * capability-gated) Suspend/Reinstate control and the "View event timeline" link.
 *
 * `title` is JSX already rendered by the server (`PayerDetailView`) and passed straight
 * through as `children` — it never re-executes on the client, so the id-formatting and label
 * logic that build it stay off this bundle. Only the interactive cluster (link + button +
 * result banner) needs to be a Client Component.
 *
 * On a successful action `router.refresh()` re-fetches the payer record server-side (status,
 * `previous_status`, the suspended-notice banner) while this component's own local state — the
 * result banner — survives the refresh, exactly like `login-form.tsx`'s post-login refresh.
 */
export function PayerDetailHeader({
  title,
  payerId,
  status,
  canSuspend,
  timelineHref,
}: {
  title: ReactNode;
  payerId: string;
  status: "pending" | "active" | "suspended";
  canSuspend: boolean;
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
          <Link className="btn btn--ghost" href={timelineHref}>
            View event timeline
          </Link>
          {canSuspend &&
            (status === "suspended" ? (
              <AdminActionButton
                label="Reinstate"
                confirmLabel="Confirm reinstate?"
                variant="primary"
                action={() => reinstatePayerAction(payerId)}
                onSettled={handleSettled}
              />
            ) : (
              <AdminActionButton
                label="Suspend"
                confirmLabel="Confirm suspend?"
                variant="danger"
                action={() => suspendPayerAction(payerId)}
                onSettled={handleSettled}
              />
            ))}
        </div>
      </header>
      {outcome && <AdminActionResultBanner outcome={outcome} timelineHref={timelineHref} />}
    </>
  );
}
