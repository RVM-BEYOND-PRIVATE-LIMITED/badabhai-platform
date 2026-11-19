"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "./dialog";
import {
  AdminActionResultBanner,
  timelineLink,
} from "./admin-action-result-banner";
import { getGrantLedgerRowsAction, grantCreditsAction, type GrantLedgerRow } from "./payer-actions";
import {
  ADMIN_CREDIT_GRANT_MAX,
  CREDIT_GRANT_REASONS,
  CREDIT_GRANT_REASON_LABELS,
  type CreditGrantReason,
} from "../lib/admin-action-vocabulary";
import { applyCreditGrantOutcome } from "../lib/credit-grant-outcome";
import { formatCount } from "../lib/format";
import type { AdminActionOutcome } from "../lib/admin-action-result";

const mintKey = () => crypto.randomUUID();

/**
 * "Grant credits" from the company header (A9, #2579): a T2 dialog with the before/after
 * balance, the closed reason vocabulary the ledger records, and the existing exactly-once
 * idempotency key lifecycle (`lib/credit-grant-outcome.ts`).
 */
export function GrantCreditsDialog({
  open,
  onClose,
  companyId,
  balance,
  mayGrant,
  isSuperAdmin = false,
  timelineHref,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  balance: number | null;
  mayGrant: boolean;
  isSuperAdmin?: boolean;
  timelineHref: string | null;
}) {
  const router = useRouter();
  const [idempotencyKey, setIdempotencyKey] = useState(mintKey);
  const [amount, setAmount] = useState("");
  const [reasonCode, setReasonCode] = useState<CreditGrantReason>(CREDIT_GRANT_REASONS[0]);
  const [reasonText, setReasonText] = useState("");
  const [correctsLedgerId, setCorrectsLedgerId] = useState("");
  const [ledgerRows, setLedgerRows] = useState<GrantLedgerRow[]>([]);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const ids = useId();

  const reasons = CREDIT_GRANT_REASONS.filter((code) => code !== "correction" || isSuperAdmin);

  // The correction picker reads this company's own ledger rows (never another company's).
  useEffect(() => {
    if (!open || !isSuperAdmin) return;
    let live = true;
    void getGrantLedgerRowsAction(companyId).then((res) => {
      if (!live) return;
      if (res.ok) {
        setLedgerRows(res.rows);
        setLedgerError(null);
      } else {
        setLedgerError(res.error);
      }
    });
    return () => {
      live = false;
    };
  }, [open, isSuperAdmin, companyId]);

  if (!mayGrant) return null;

  const parsed = Number(amount);
  const amountValid =
    amount.trim() !== "" && Number.isInteger(parsed) && parsed > 0 && parsed <= ADMIN_CREDIT_GRANT_MAX;
  const reasonValid = reasonText.trim().length >= 15 && reasonText.trim().length <= 500;
  const correctionValid = reasonCode !== "correction" || correctsLedgerId !== "";
  const valid = amountValid && reasonValid && correctionValid;

  function close() {
    onClose();
    setAmount("");
    setReasonText("");
    setCorrectsLedgerId("");
    setOutcome(null);
  }

  async function grant() {
    if (!valid) return;
    const result = await grantCreditsAction(companyId, {
      amount: parsed,
      reasonCode,
      idempotencyKey,
      reasonText: reasonText.trim(),
      ...(reasonCode === "correction" ? { correctsLedgerId } : {}),
    });
    setOutcome(result);
    const next = applyCreditGrantOutcome({ idempotencyKey, amount }, result, mintKey);
    setIdempotencyKey(next.idempotencyKey);
    setAmount(next.amount);
    if (result.ok) router.refresh();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Grant credits"
      description="A positive, additive top-up recorded on the ledger with the reason below. It is exactly-once per submit."
      footer={
        <>
          <button className="btn btn--ghost" type="button" onClick={close}>
            Cancel
          </button>
          <button className="btn btn--primary" type="button" onClick={grant} disabled={!valid}>
            Grant credits
          </button>
        </>
      }
    >
      <table className="diff">
        <caption className="sr-only">What changes</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Credit balance</th>
            <td className="diff__before">{balance === null ? "—" : formatCount(balance)}</td>
            <td className="diff__after">
              {balance === null || !valid ? "—" : formatCount(balance + parsed)}
            </td>
          </tr>
          <tr>
            <th scope="row">Ledger entry</th>
            <td className="diff__before">—</td>
            <td className="diff__after">{valid ? `+${formatCount(parsed)} credits` : "—"}</td>
          </tr>
        </tbody>
      </table>

      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <label className="field" htmlFor={`${ids}-amount`}>
          <span className="field__label">
            Credits<span className="req">*</span>
          </span>
          <input
            id={`${ids}-amount`}
            className="field__input"
            type="number"
            inputMode="numeric"
            min={1}
            max={ADMIN_CREDIT_GRANT_MAX}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={amount !== "" && !valid ? true : undefined}
          />
        </label>
        <label className="field" htmlFor={`${ids}-reason`}>
          <span className="field__label">
            Reason<span className="req">*</span>
          </span>
          <select
            id={`${ids}-reason`}
            className="field__input"
            value={reasonCode}
            onChange={(e) => {
              setReasonCode(e.target.value as CreditGrantReason);
              setCorrectsLedgerId("");
            }}
          >
            {reasons.map((code) => (
              <option key={code} value={code}>
                {CREDIT_GRANT_REASON_LABELS[code]}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor={`${ids}-reason-text`}>
          <span className="field__label">
            Written reason<span className="req">*</span>
          </span>
          <textarea
            id={`${ids}-reason-text`}
            className="field__input"
            rows={3}
            minLength={15}
            maxLength={500}
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
            placeholder="Why this grant is needed (15–500 characters, no phone number)"
            aria-invalid={reasonText !== "" && !reasonValid ? true : undefined}
          />
          <span className="field__hint">{reasonText.trim().length} / 500</span>
        </label>
        {reasonCode === "correction" && isSuperAdmin ? (
          <label className="field" htmlFor={`${ids}-corrects`}>
            <span className="field__label">
              Corrects ledger row<span className="req">*</span>
            </span>
            <select
              id={`${ids}-corrects`}
              className="field__input"
              value={correctsLedgerId}
              onChange={(e) => setCorrectsLedgerId(e.target.value)}
            >
              <option value="">Choose a row…</option>
              {ledgerRows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
            {ledgerError ? <span className="field__hint">{ledgerError}</span> : null}
          </label>
        ) : null}
      </form>
      {outcome ? (
        <AdminActionResultBanner
          outcome={outcome}
          eventsLink={timelineLink(timelineHref)}
          onRetry={grant}
        />
      ) : null}
    </Dialog>
  );
}
