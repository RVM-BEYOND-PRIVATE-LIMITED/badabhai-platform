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
import { flagWorkerAction, unflagWorkerAction } from "./actions";
import {
  WORKER_FLAG_REASON_CODES,
  WORKER_FLAG_REASON_LABELS,
  type WorkerFlagReasonCode,
} from "../../../../lib/admin-action-vocabulary";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * The worker detail header: the shared `PageHeader`, given the server-built title block, with
 * the (capability-gated) Flag/Unflag controls as its primary action and the journey and
 * event-timeline links as its secondary ones.
 *
 * There is no `is_flagged` field on `WorkerDetail` — the read model does not expose current
 * flag state, so BOTH controls are offered unconditionally rather than guessed at. That is
 * not a workaround: it matches the backend's own idempotent design (flagging an
 * already-flagged worker, or unflagging one with no open flag, is each a defined no-op
 * success), so the result banner is what tells the operator what was actually true.
 */
export function WorkerDetailHeader({
  header,
  workerId,
  canFlag,
  timelineHref,
  journeyHref,
}: {
  /** Back link, title and description, built on the server. */
  header: PageHeaderContent;
  workerId: string;
  canFlag: boolean;
  /**
   * This worker's event timeline, or null for a reader without `read_events` — the route would
   * redirect them, so the link is not offered. An affordance; the route keeps its own gate.
   */
  timelineHref: string | null;
  /**
   * The 7-step funnel + interview sessions for this worker. Rendered only when the operator
   * has `read_entities` — the same capability the journey API declares — so a control that
   * would land on a redirect is never offered.
   */
  journeyHref: string | null;
}) {
  const router = useRouter();
  const [reasonCode, setReasonCode] = useState<WorkerFlagReasonCode>(WORKER_FLAG_REASON_CODES[0]);
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
          canFlag ? (
            <>
              {/* `.field`, not `.field--check`: that modifier is for an inline CHECKBOX
                  filter and carries `align-self:end` + a `padding-bottom` sized for the
                  filter grid, which in this flex action row pushed the select out of line
                  with the buttons beside it. Every other select in the console is a plain
                  `.field` + `.field__input`. */}
              <label className="field">
                <span className="field__label sr-only">Flag reason</span>
                <select
                  className="field__input"
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value as WorkerFlagReasonCode)}
                >
                  {WORKER_FLAG_REASON_CODES.map((code) => (
                    <option key={code} value={code}>
                      {WORKER_FLAG_REASON_LABELS[code]}
                    </option>
                  ))}
                </select>
              </label>
              <AdminActionButton
                label="Flag"
                icon="flag"
                confirmLabel="Confirm flag?"
                variant="danger"
                action={() => flagWorkerAction(workerId, reasonCode)}
                onSettled={handleSettled}
              />
              {/* The REINSTATE glyph, not a second flag (final sweep AW-17): the two opposite
                  verbs drew one icon side by side. Unflag reverses a restriction exactly as
                  Reinstate reverses Suspend, so it wears that action's icon (one concept, one
                  icon). Both stay offered — the read model has no flag state to choose by. */}
              <AdminActionButton
                label="Unflag"
                icon={ACTION_ICON.reinstate}
                confirmLabel="Confirm unflag?"
                variant="primary"
                action={() => unflagWorkerAction(workerId)}
                onSettled={handleSettled}
              />
            </>
          ) : null
        }
        secondaryActions={
          <>
            {journeyHref && (
              <Link className="btn btn--ghost" href={journeyHref}>
                <Icon name="path" />
                View journey
              </Link>
            )}
            {timelineHref && (
              <Link className="btn btn--ghost" href={timelineHref}>
                <Icon name={ACTION_ICON.timeline} />
                View event timeline
              </Link>
            )}
          </>
        }
      />
      {outcome && (
        <AdminActionResultBanner outcome={outcome} eventsLink={timelineLink(timelineHref)} />
      )}
    </>
  );
}
