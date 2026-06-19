"use client";

import { useState } from "react";
import Link from "next/link";
import type { FacelessApplicant } from "../../../../../lib/contracts";
import type { RevealView, UnlockView } from "../../../../../lib/unlock-view";
import { revealAction, unlockAction } from "./actions";

/**
 * Client interactivity for unlock + masked-reveal (ADR-0019 Decision E).
 *
 * Runs in the BROWSER and sees NO secret. It calls the Server Actions, which bind
 * to the server-held payer (XB-A) and return only PII-free, already-mapped views.
 *
 * NO-ORACLE (XB-C): an "unavailable" renders ONE neutral message — no branch here
 * infers the cause. NO-LOG: nothing logs the result / handle / payer id.
 * MASKED ONLY (XB-E): the reveal shows masked initials + a masked-PDF link + NO
 * phone — the component has no field that could render a raw name or number.
 */

interface RowState {
  busy: boolean;
  unlock: UnlockView | null;
  unlockError: string | null;
  revealBusy: boolean;
  reveal: RevealView | null;
  revealError: string | null;
}

const EMPTY: RowState = {
  busy: false,
  unlock: null,
  unlockError: null,
  revealBusy: false,
  reveal: null,
  revealError: null,
};

function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

export function ApplicantActions({
  postingId,
  applicants,
  balance,
}: {
  postingId: string;
  applicants: FacelessApplicant[];
  balance: number;
}) {
  const [rows, setRows] = useState<Record<string, RowState>>({});

  function patch(workerId: string, p: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [workerId]: { ...(prev[workerId] ?? EMPTY), ...p } }));
  }

  async function onUnlock(workerId: string) {
    patch(workerId, { busy: true, unlockError: null });
    const res = await unlockAction({ postingId, workerId });
    if (res.ok) patch(workerId, { busy: false, unlock: res.view });
    else patch(workerId, { busy: false, unlockError: res.error });
  }

  async function onReveal(workerId: string, unlockId: string) {
    patch(workerId, { revealBusy: true, revealError: null });
    const res = await revealAction({ unlockId });
    if (res.ok) patch(workerId, { revealBusy: false, reveal: res.view });
    else patch(workerId, { revealBusy: false, revealError: res.error });
  }

  return (
    <>
      {balance === 0 ? (
        <div className="note warn">
          <strong>You have 0 credits.</strong> <Link href="/credits">Top up</Link> to unlock a
          candidate&rsquo;s routed contact. This is your own balance — not a signal about any
          candidate.
        </div>
      ) : null}

      <table>
        <thead>
          <tr>
            <th>Candidate</th>
            <th>Trade</th>
            <th>Experience</th>
            <th>City</th>
            <th>Skills</th>
            <th>Contact</th>
          </tr>
        </thead>
        <tbody>
          {applicants.map((a) => {
            const row = rows[a.workerId] ?? EMPTY;
            const granted = row.unlock?.kind === "granted" ? row.unlock : null;
            return (
              <tr key={a.workerId}>
                <td className="mono">{a.workerId.slice(0, 8)}…</td>
                <td>{a.tradeLabel}</td>
                <td>{a.experienceBand}</td>
                <td>{a.cityLabel}</td>
                <td>
                  <div className="skills">
                    {a.skills.map((s) => (
                      <span className="skill" key={s}>
                        {s}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  {granted ? (
                    <div>
                      <span className="badge badge-ok">Unlocked</span> · until{" "}
                      <span className="mono">{day(granted.expiresAt)}</span>
                      <div style={{ marginTop: 8 }}>
                        {row.reveal?.kind === "masked" ? (
                          <MaskedResume view={row.reveal} />
                        ) : row.reveal?.kind === "unavailable" ? (
                          <p className="note">{row.reveal.message}</p>
                        ) : (
                          <button
                            className="btn secondary"
                            type="button"
                            disabled={row.revealBusy}
                            onClick={() => onReveal(a.workerId, granted.unlockId)}
                          >
                            {row.revealBusy ? "Loading…" : "View masked resume"}
                          </button>
                        )}
                        {row.revealError ? <p className="error-text">{row.revealError}</p> : null}
                      </div>
                    </div>
                  ) : row.unlock?.kind === "unavailable" ? (
                    <p className="note">{row.unlock.message}</p>
                  ) : (
                    <>
                      <button
                        className="btn"
                        type="button"
                        disabled={row.busy}
                        onClick={() => onUnlock(a.workerId)}
                      >
                        {row.busy ? "Unlocking…" : "Unlock contact (1 credit)"}
                      </button>
                      {row.unlockError ? <p className="error-text">{row.unlockError}</p> : null}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/**
 * Renders the MASKED resume only (XB-E): masked initials + a link to the masked
 * PDF + NO phone. There is deliberately no field here that could show a raw name
 * or a phone number — the artifact carries neither.
 */
function MaskedResume({ view }: { view: Extract<RevealView, { kind: "masked" }> }) {
  return (
    <div className="card" style={{ marginTop: 4 }}>
      <p className="page-sub" style={{ margin: 0 }}>
        <strong>Masked resume.</strong> Identity is masked until later in the hiring flow —{" "}
        <strong>no phone, no full name</strong> is shown.
      </p>
      <dl className="dl">
        <dt>Candidate</dt>
        <dd className="mono">{view.displayInitials}</dd>
        <dt>Resume</dt>
        <dd>
          <a href={view.resumeUrl} target="_blank" rel="noopener noreferrer">
            Open masked resume (PDF) →
          </a>
        </dd>
        <dt>Access until</dt>
        <dd className="mono">{day(view.expiresAt)}</dd>
      </dl>
    </div>
  );
}
