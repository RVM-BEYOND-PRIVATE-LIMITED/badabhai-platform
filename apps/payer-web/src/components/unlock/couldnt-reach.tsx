"use client";

import { useEffect, useState } from "react";
import {
  getReachCaseAction,
  reportCouldntReachAction,
  type ReachCaseView,
} from "./couldnt-reach-actions";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * #2750 item 7 — "Couldn't reach?" on an opened contact, for 7 days after the open (IST days
 * are approximated by the elapsed window the API enforces). After a report it shows the case's
 * status, deadline and returned credits; after day 7 the action disappears.
 */
export function CouldntReach({
  unlockId,
  openedAt,
  now = Date.now(),
}: {
  unlockId: string;
  openedAt: string | null;
  now?: number;
}) {
  const [reachCase, setReachCase] = useState<ReachCaseView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getReachCaseAction(unlockId).then((res) => {
      if (!live || !res.ok) return;
      setReachCase(res.reachCase);
    });
    return () => {
      live = false;
    };
  }, [unlockId]);

  const opened = openedAt ? Date.parse(openedAt) : NaN;
  const withinWindow =
    Number.isFinite(opened) && now - opened <= 7 * DAY_MS && now >= opened;

  if (!reachCase && !withinWindow) return null;

  async function report(): Promise<void> {
    setBusy(true);
    const res = await reportCouldntReachAction(unlockId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setReachCase(res.reachCase);
    setError(null);
  }

  return (
    <div aria-live="polite">
      {reachCase ? (
        <p className="applicant__neutral">
          {reachCase.status === "not_reached" ? (
            <>
              We couldn&rsquo;t reach this worker.{" "}
              {reachCase.creditsReturned > 0
                ? `${reachCase.creditsReturned} credit${reachCase.creditsReturned === 1 ? "" : "s"} returned.`
                : "The desk is reviewing the case."}
            </>
          ) : reachCase.status === "open" ? (
            <>
              Case open — the desk will try by{" "}
              <span className="bb-mono">{reachCase.deadlineAt.slice(0, 10)}</span>.
            </>
          ) : (
            <>The desk reached this worker.</>
          )}
        </p>
      ) : (
        <button
          type="button"
          className="bb-btn bb-btn--ghost bb-btn--sm"
          disabled={busy}
          onClick={() => void report()}
        >
          {busy ? "Reporting…" : "Couldn't reach?"}
        </button>
      )}
      {error ? <p className="applicant__error">{error}</p> : null}
    </div>
  );
}
