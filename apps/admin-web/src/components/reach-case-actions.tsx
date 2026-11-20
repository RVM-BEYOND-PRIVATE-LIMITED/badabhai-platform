"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  logAttemptAction,
  resolveCaseAction,
  revealWorkerAction,
} from "./reach-desk-actions";
import type { ReachAttemptResult, ReachOutcome } from "../lib/reach-desk";
import { REACH_ATTEMPT_RESULTS, REACH_OUTCOMES, reachCaseLabel } from "../lib/reach-desk-view";

const ATTEMPT_LABELS: Record<ReachAttemptResult, string> = {
  no_answer: "No answer",
  busy: "Busy",
  switched_off: "Switched off",
  wrong_number: "Wrong number",
  other: "Other",
};

const OUTCOME_LABELS: Record<ReachOutcome, string> = {
  reached_interested: "Reached — interested",
  reached_declined: "Reached — declined",
  not_reached: "Not reached",
};

/**
 * The desk's actions on one case (#2750 items 7/8): reveal the worker's number (through the
 * existing `reveal_pii` route, case id as the reason), log a call result, and close with an
 * outcome plus a written reason.
 */
export function ReachCaseActions({
  caseId,
  workerId,
  closed,
  canReveal,
  attempts,
}: {
  caseId: string;
  workerId: string | null;
  closed: boolean;
  canReveal: boolean;
  attempts: { attempt_id: string; result: string; attempted_at: string }[];
}) {
  const router = useRouter();
  const [phone, setPhone] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<ReachAttemptResult>("no_answer");
  const [outcome, setOutcome] = useState<ReachOutcome>("not_reached");
  const [reasonText, setReasonText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reveal(): Promise<void> {
    if (!workerId) return;
    setBusy(true);
    const res = await revealWorkerAction(workerId, caseId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPhone(res.phone);
    setError(null);
  }

  async function logAttempt(): Promise<void> {
    setBusy(true);
    const res = await logAttemptAction(caseId, attempt);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessage("Attempt logged.");
    setError(null);
    router.refresh();
  }

  async function close(): Promise<void> {
    setBusy(true);
    const res = await resolveCaseAction(caseId, outcome, reasonText.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessage(`Closed as ${reachCaseLabel(outcome)}.`);
    setError(null);
    router.refresh();
  }

  const reasonValid = reasonText.trim().length >= 15 && reasonText.trim().length <= 500;

  return (
    <div className="panel-section">
      {error ? (
        <div className="alert alert--warning">
          <Icon name="warning" className="alert__icon" />
          <div className="alert__text">
            <p className="alert__body">{error}</p>
          </div>
        </div>
      ) : null}
      {message ? <p className="panel__sub" role="status">{message}</p> : null}

      <div className="field">
        <span className="field__label">Worker number</span>
        {phone ? (
          <span className="mono">{phone}</span>
        ) : (
          <button
            className="btn btn--ghost btn--sm"
            type="button"
            disabled={!canReveal || !workerId || busy}
            onClick={() => void reveal()}
            title={canReveal ? undefined : "Your role cannot reveal contact details."}
          >
            <Icon name={ACTION_ICON.unlock} /> Reveal number
          </button>
        )}
      </div>

      {!closed ? (
        <>
          <div className="field">
            <span className="field__label">Log a call attempt</span>
            <select
              className="field__input"
              value={attempt}
              onChange={(e) => setAttempt(e.target.value as ReachAttemptResult)}
            >
              {REACH_ATTEMPT_RESULTS.map((result) => (
                <option key={result} value={result}>
                  {ATTEMPT_LABELS[result]}
                </option>
              ))}
            </select>
            <button
              className="btn btn--secondary btn--sm"
              type="button"
              disabled={busy}
              onClick={() => void logAttempt()}
            >
              Log attempt
            </button>
          </div>

          <div className="field">
            <span className="field__label">Close the case</span>
            <select
              className="field__input"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as ReachOutcome)}
            >
              {REACH_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABELS[o]}
                </option>
              ))}
            </select>
            <label className="field" htmlFor="reach-reason">
              <span className="field__label">
                Reason<span className="req">*</span>
              </span>
              <textarea
                id="reach-reason"
                className="field__input"
                rows={3}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder="What happened on the call (15–500 characters)"
              />
            </label>
            <button
              className="btn btn--primary btn--sm"
              type="button"
              disabled={busy || !reasonValid}
              onClick={() => void close()}
            >
              Close case
            </button>
          </div>
        </>
      ) : null}

      {attempts.length > 0 ? (
        <ul className="panel__sub">
          {attempts.map((a) => (
            <li key={a.attempt_id}>
              {ATTEMPT_LABELS[a.result as ReachAttemptResult] ?? a.result} ·{" "}
              {a.attempted_at.slice(0, 16).replace("T", " ")}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
