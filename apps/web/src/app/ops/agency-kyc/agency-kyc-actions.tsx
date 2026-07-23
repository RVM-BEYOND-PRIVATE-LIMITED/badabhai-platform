"use client";

import { useState } from "react";
import type { AgencyKycRejectReason } from "@/lib/api";
import { REJECT_REASONS, DEFAULT_REJECT_REASON } from "@/lib/agency-kyc-view";
import {
  verifyAgencyKycAction,
  rejectAgencyKycAction,
  type AgencyKycActionState,
} from "./actions";

/**
 * Per-row Verify / Reject controls for the ops Agency-KYC queue (ADR-0022
 * Amendment 2).
 *
 * SECURITY: this component runs in the BROWSER and never sees the
 * `INTERNAL_SERVICE_TOKEN`. It calls Server Actions (`actions.ts`) that attach the
 * shared secret server-side and return only a masked, PII-free result. On a
 * successful change the action revalidates the page, so the acted row drops out of
 * the pending queue on the next render.
 */
export function AgencyKycRowActions({ payerId }: { payerId: string }) {
  const [reason, setReason] = useState<AgencyKycRejectReason>(
    DEFAULT_REJECT_REASON,
  );
  const [busy, setBusy] = useState<null | "verify" | "reject">(null);
  const [result, setResult] = useState<AgencyKycActionState | null>(null);

  async function onVerify() {
    setBusy("verify");
    setResult(null);
    const res = await verifyAgencyKycAction(payerId);
    setBusy(null);
    setResult(res);
  }

  async function onReject() {
    setBusy("reject");
    setResult(null);
    const res = await rejectAgencyKycAction(payerId, reason);
    setBusy(null);
    setResult(res);
  }

  const disabled = busy !== null;

  return (
    <div className="field" style={{ gap: 8 }}>
      <div className="btn-row">
        <button
          className="btn"
          type="button"
          onClick={onVerify}
          disabled={disabled}
        >
          {busy === "verify" ? "Verifying…" : "Verify"}
        </button>
        <label className="sr-only" htmlFor={`reason_${payerId}`}>
          Reject reason
        </label>
        <select
          id={`reason_${payerId}`}
          className="select"
          style={{ width: "auto" }}
          value={reason}
          onChange={(e) => setReason(e.target.value as AgencyKycRejectReason)}
          disabled={disabled}
        >
          {REJECT_REASONS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          className="btn btn-danger"
          type="button"
          onClick={onReject}
          disabled={disabled}
        >
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {result ? (
        result.ok ? (
          <p className="page-sub" style={{ margin: 0 }}>
            <span className="badge">{result.message}</span>
          </p>
        ) : (
          <p className="error-text">{result.error}</p>
        )
      ) : null}
    </div>
  );
}
