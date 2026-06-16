"use client";

import { useState } from "react";
import Link from "next/link";
import type { ApplicantRow } from "@/lib/api";
import { isUuid, type UnlockView, type RevealView } from "@/lib/unlock-view";
import { formatScore, WhyDetails } from "@/components/reach";
import {
  fetchPayerCreditsAction,
  unlockContactAction,
  revealContactAction,
} from "./actions";

/**
 * Client interactivity for the contact unlock + reveal flow (ADR-0010, Stream A).
 *
 * SECURITY: this component runs in the BROWSER and therefore never sees the
 * `INTERNAL_SERVICE_TOKEN`. It calls Server Actions (`actions.ts`) that attach the
 * secret server-side and return only PII-free, already-mapped view state. The
 * component receives faceless `applicants` (opaque worker ids only) as props and
 * never fetches a name/phone — there is none on this path.
 *
 * NO-ORACLE: an "unavailable" unlock renders ONE neutral message; this component
 * has no branch that infers the cause. NO-LOG: nothing here logs the unlock /
 * reveal result, the relay handle, or the payer id.
 */

/** Per-row interaction state (keyed by opaque worker id). */
interface RowState {
  busy: boolean;
  unlock: UnlockView | null;
  unlockError: string | null;
  revealBusy: boolean;
  reveal: RevealView | null;
  revealError: string | null;
}

const EMPTY_ROW: RowState = {
  busy: false,
  unlock: null,
  unlockError: null,
  revealBusy: false,
  reveal: null,
  revealError: null,
};

const CHANNEL_LABEL: Record<string, string> = {
  in_app_relay: "In-app relay",
  proxy_number: "Proxy number",
};

function fmt(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

export function UnlockActions({
  jobId,
  applicants,
}: {
  jobId: string;
  applicants: ApplicantRow[];
}) {
  const [payerId, setPayerId] = useState("");
  const [activePayer, setActivePayer] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [creditsBusy, setCreditsBusy] = useState(false);
  const [creditsError, setCreditsError] = useState<string | null>(null);

  // Per-applicant state, keyed by opaque worker id.
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const payerValid = isUuid(payerId);

  function patchRow(workerId: string, patch: Partial<RowState>) {
    setRows((prev) => ({
      ...prev,
      [workerId]: { ...(prev[workerId] ?? EMPTY_ROW), ...patch },
    }));
  }

  async function onLoadPayer(e: React.FormEvent) {
    e.preventDefault();
    setCreditsError(null);
    setBalance(null);
    if (!payerValid) {
      setCreditsError("Enter a valid payer id (UUID).");
      return;
    }
    setCreditsBusy(true);
    const res = await fetchPayerCreditsAction(payerId.trim());
    setCreditsBusy(false);
    if (res.ok) {
      setActivePayer(payerId.trim());
      setBalance(res.balance);
      // Reset any prior per-row results when switching payer context.
      setRows({});
    } else {
      setActivePayer(null);
      setCreditsError(res.error);
    }
  }

  async function onUnlock(workerId: string) {
    if (!activePayer) return;
    patchRow(workerId, { busy: true, unlockError: null });
    const res = await unlockContactAction({
      payerId: activePayer,
      workerId,
      jobId,
    });
    if (res.ok) {
      patchRow(workerId, { busy: false, unlock: res.view });
    } else {
      patchRow(workerId, { busy: false, unlockError: res.error });
    }
  }

  async function onReveal(workerId: string, unlockId: string) {
    patchRow(workerId, { revealBusy: true, revealError: null });
    const res = await revealContactAction(unlockId);
    if (res.ok) {
      patchRow(workerId, { revealBusy: false, reveal: res.view });
    } else {
      patchRow(workerId, { revealBusy: false, revealError: res.error });
    }
  }

  return (
    <>
      <form className="form" onSubmit={onLoadPayer} style={{ marginBottom: 16 }}>
        <p className="note">
          Ops alpha has no payer auth — enter the opaque <code>payer_id</code> (UUID)
          you are acting for. This is the interim F-7 <code>InternalServiceGuard</code>{" "}
          launch-gate posture (same as job-postings <code>created_by</code>); real payer
          identity lands in Phase 2 (TD33).
        </p>
        <div className="field">
          <label htmlFor="payer_id">
            Payer id<span className="req">*</span>
          </label>
          <input
            id="payer_id"
            className="input mono"
            placeholder="00000000-0000-4000-8000-000000000000"
            value={payerId}
            onChange={(e) => setPayerId(e.target.value)}
          />
        </div>
        <div className="btn-row">
          <button className="btn" type="submit" disabled={creditsBusy || !payerValid}>
            {creditsBusy ? "Loading…" : "Load payer & balance"}
          </button>
        </div>
        {creditsError ? <p className="error-text">{creditsError}</p> : null}
      </form>

      {activePayer && balance !== null ? (
        <p className="page-sub">
          Acting for payer <span className="mono">{activePayer}</span> ·{" "}
          <span className="badge">Balance: {balance}</span>
        </p>
      ) : null}

      {/* The payer's OWN balance is the honest "no-credits" surface — NOT a worker
          oracle. It is the one legitimately-knowable signal (constraint 3). */}
      {activePayer && balance === 0 ? (
        <p className="note">
          <strong>This payer has 0 credits.</strong> Top up before unlocking (
          <Link href="/ops/pricing">top up on the Pricing screen</Link>). This is the
          payer&rsquo;s own balance, not a signal about any candidate.
        </p>
      ) : null}

      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Worker ID</th>
            <th>Score</th>
            <th>Flags</th>
            <th>Why</th>
            <th>Contact</th>
          </tr>
        </thead>
        <tbody>
          {applicants.map((a) => {
            const row = rows[a.workerId] ?? EMPTY_ROW;
            const granted = row.unlock?.kind === "granted" ? row.unlock : null;
            return (
              <tr key={a.workerId}>
                <td>{a.rank}</td>
                <td className="mono">{a.workerId}</td>
                <td>{formatScore(a.score)}</td>
                <td>
                  {a.hot ? <span className="badge badge-hot">HOT</span> : null}
                  {a.hot && a.pushEligible ? " " : null}
                  {a.pushEligible ? <span className="badge badge-push">PUSH</span> : null}
                  {!a.hot && !a.pushEligible ? "—" : null}
                </td>
                <td>
                  <WhyDetails components={a.components} />
                </td>
                <td>
                  {!activePayer ? (
                    <span className="page-sub">Load a payer first.</span>
                  ) : granted ? (
                    <div>
                      <span className="badge">Granted</span> · expires{" "}
                      <span className="mono">{fmt(granted.expiresAt)}</span>
                      <div style={{ marginTop: 8 }}>
                        {row.reveal?.kind === "handle" ? (
                          <RevealedHandle view={row.reveal} />
                        ) : row.reveal?.kind === "unavailable" ? (
                          <p className="note">{row.reveal.message}</p>
                        ) : (
                          <button
                            className="btn"
                            type="button"
                            disabled={row.revealBusy}
                            onClick={() => onReveal(a.workerId, granted.unlockId)}
                          >
                            {row.revealBusy ? "Revealing…" : "Reveal contact"}
                          </button>
                        )}
                        {row.revealError ? (
                          <p className="error-text">{row.revealError}</p>
                        ) : null}
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
                        {row.busy ? "Unlocking…" : "Unlock contact"}
                      </button>
                      {row.unlockError ? (
                        <p className="error-text">{row.unlockError}</p>
                      ) : null}
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
 * Renders ONLY the routed relay handle (constraint 4). Explicitly labelled as a
 * routed relay handle, NOT a phone number — there is no phone on this path.
 */
function RevealedHandle({
  view,
}: {
  view: Extract<RevealView, { kind: "handle" }>;
}) {
  return (
    <div className="card" style={{ marginTop: 4 }}>
      <p className="page-sub" style={{ margin: 0 }}>
        <strong>Routed relay handle</strong> — this is a routed contact handle,{" "}
        <strong>not a phone number</strong>.
      </p>
      <dl className="dl">
        <dt>Relay handle</dt>
        <dd className="mono">{view.relayHandle}</dd>
        <dt>Channel</dt>
        <dd>{CHANNEL_LABEL[view.channel] ?? view.channel}</dd>
        <dt>Expires</dt>
        <dd className="mono">{fmt(view.expiresAt)}</dd>
      </dl>
    </div>
  );
}
