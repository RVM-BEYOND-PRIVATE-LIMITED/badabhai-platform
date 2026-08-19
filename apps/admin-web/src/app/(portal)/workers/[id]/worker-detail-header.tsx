"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "../../../../components/admin-action-button";
import { AdminActionResultBanner } from "../../../../components/admin-action-result-banner";
import { flagWorkerAction, unflagWorkerAction } from "./actions";
import {
  WORKER_FLAG_REASON_CODES,
  WORKER_FLAG_REASON_LABELS,
  type WorkerFlagReasonCode,
} from "../../../../lib/admin-action-vocabulary";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";

/**
 * The worker detail header: the server-rendered title block plus the event-timeline link and
 * the (capability-gated) Flag/Unflag controls.
 *
 * There is no `is_flagged` field on `WorkerDetail` — the read model does not expose current
 * flag state, so BOTH controls are offered unconditionally rather than guessed at. That is
 * not a workaround: it matches the backend's own idempotent design (flagging an
 * already-flagged worker, or unflagging one with no open flag, is each a defined no-op
 * success), so the result banner is what tells the operator what was actually true.
 */
export function WorkerDetailHeader({
  title,
  workerId,
  canFlag,
  timelineHref,
  journeyHref,
}: {
  title: ReactNode;
  workerId: string;
  canFlag: boolean;
  timelineHref: string;
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
      <header className="page__head">
        {title}
        <div className="page__actions">
          {journeyHref && (
            <Link className="btn btn--ghost" href={journeyHref}>
              View journey
            </Link>
          )}
          <Link className="btn btn--ghost" href={timelineHref}>
            View event timeline
          </Link>
          {canFlag && (
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
                confirmLabel="Confirm flag?"
                variant="danger"
                action={() => flagWorkerAction(workerId, reasonCode)}
                onSettled={handleSettled}
              />
              <AdminActionButton
                label="Unflag"
                confirmLabel="Confirm unflag?"
                variant="primary"
                action={() => unflagWorkerAction(workerId)}
                onSettled={handleSettled}
              />
            </>
          )}
        </div>
      </header>
      {outcome && <AdminActionResultBanner outcome={outcome} timelineHref={timelineHref} />}
    </>
  );
}
