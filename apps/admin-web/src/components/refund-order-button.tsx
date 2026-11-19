"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { Dialog } from "./dialog";
import {
  refundEligibilityAction,
  refundOrderAction,
  retryRefundAction,
  type RefundActionResult,
} from "./payment-refund-actions";
import {
  formatPaise,
  refusalCopy,
  type RefundEligibility,
  type RefundRule,
  type RefundStatus,
  type RefundView,
} from "../lib/payment-refunds";

/**
 * #2750 items 10 and 12 — the super admin's Refund action on a real paid order.
 *
 * The panel reads `refund-eligibility` first: both rules, their deadline and why not. A 503
 * `CREDIT_NOTES_UNAVAILABLE` disables the action with the owner's line. A failed refund can be
 * retried with its own written reason.
 */
export function RefundOrderButton({
  paymentOrderId,
  disabled = false,
}: {
  paymentOrderId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [eligibility, setEligibility] = useState<RefundEligibility | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rule, setRule] = useState<RefundRule>("unused");
  const [jobId, setJobId] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [refund, setRefund] = useState<RefundView | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryReason, setRetryReason] = useState("");

  async function load(job?: string) {
    setLoading(true);
    setError(null);
    const res = await refundEligibilityAction(paymentOrderId, job || undefined);
    setLoading(false);
    if (!res.ok) {
      setUnavailable(Boolean(res.creditNotesUnavailable));
      setError(res.error);
      return;
    }
    setUnavailable(false);
    setEligibility(res.eligibility);
    setRefund(res.eligibility.refund);
  }

  function openPanel(): void {
    setOpen(true);
    setEligibility(null);
    setRefund(null);
    setError(null);
    setUnavailable(false);
    void load();
  }

  function applyResult(res: RefundActionResult): void {
    if (!res.ok) {
      setUnavailable(Boolean(res.creditNotesUnavailable));
      setError(res.error);
      return;
    }
    setRefund(res.refund);
    setError(null);
    router.refresh();
  }

  const reasonValid = reasonText.trim().length >= 15 && reasonText.trim().length <= 500;
  const chosen = eligibility?.rules[rule];
  const canRefund =
    !unavailable &&
    eligibility !== null &&
    chosen !== undefined &&
    chosen.eligible &&
    reasonValid &&
    (rule === "unused" || Boolean(chosen && "needs_fewer_than" in chosen));

  return (
    <>
      <button
        className="btn btn--ghost btn--sm"
        type="button"
        onClick={openPanel}
        disabled={disabled}
        title={disabled ? "Refunds open once GST credit notes are live" : undefined}
      >
        <Icon name={ACTION_ICON.credits} />
        Refund
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Refund this order"
        description="A full refund through Razorpay. The pack's credits are removed from the company."
        footer={
          <>
            <button className="btn btn--ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              type="button"
              disabled={!canRefund || loading}
              onClick={() => {
                const job = rule === "low_match" && eligibility ? eligibility.rules.low_match.job_posting_id : undefined;
                if (!job && jobId) {
                  setError("Check the job first so its applicant count is read.");
                  return;
                }
                void refundOrderAction(paymentOrderId, {
                  rule,
                  reasonText: reasonText.trim(),
                  ...(job ? { jobPostingId: job } : {}),
                }).then(applyResult);
              }}
            >
              Refund {eligibility ? formatPaise(eligibility.amount_paise) : ""} and remove{" "}
              {eligibility?.credits ?? 0} credits
            </button>
          </>
        }
      >
        {loading ? <p className="table__meta">Reading what each rule says…</p> : null}
        {error ? (
          <div className="alert alert--warning">
            <Icon name="warning" className="alert__icon" />
            <div className="alert__text">
              <p className="alert__body">{error}</p>
            </div>
          </div>
        ) : null}

        {refund ? (
          <div className="panel-section">
            <p className="panel__sub">
              Refund status: <strong>{refundStatusLabel(refund.status)}</strong>
              {refund.credit_note_number ? ` · Credit note ${refund.credit_note_number}` : ""}
            </p>
            {refund.status === "failed" ? (
              <div className="field">
                <label className="field" htmlFor="refund-retry-reason">
                  <span className="field__label">
                    Retry reason<span className="req">*</span>
                  </span>
                  <textarea
                    id="refund-retry-reason"
                    className="field__input"
                    rows={3}
                    value={retryReason}
                    onChange={(e) => setRetryReason(e.target.value)}
                  />
                </label>
                <button
                  className="btn btn--secondary"
                  type="button"
                  disabled={
                    retrying ||
                    retryReason.trim().length < 15 ||
                    retryReason.trim().length > 500
                  }
                  onClick={() => {
                    setRetrying(true);
                    void retryRefundAction(refund.id, retryReason.trim())
                      .then(applyResult)
                      .finally(() => setRetrying(false));
                  }}
                >
                  Retry refund
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {eligibility && !refund ? (
          <>
            <div className="stats stats--compact">
              <div>
                <span>Order total</span>
                <strong>{formatPaise(eligibility.amount_paise)}</strong>
              </div>
              <div>
                <span>Credits removed</span>
                <strong>{eligibility.credits}</strong>
              </div>
              <div>
                <span>Pack unused</span>
                <strong>{eligibility.pack_unused ? "Yes" : "No"}</strong>
              </div>
            </div>

            <fieldset className="field">
              <legend className="field__label">Refund rule</legend>
              <label className="field">
                <input
                  type="radio"
                  name="refund-rule"
                  checked={rule === "unused"}
                  onChange={() => setRule("unused")}
                />
                Unused pack — {describeRule(eligibility.rules.unused)}
              </label>
              <label className="field">
                <input
                  type="radio"
                  name="refund-rule"
                  checked={rule === "low_match"}
                  onChange={() => setRule("low_match")}
                />
                Low match — {describeRule(eligibility.rules.low_match)} ·{" "}
                {eligibility.rules.low_match.applicants ?? "—"} applicants (refused at{" "}
                {eligibility.rules.low_match.needs_fewer_than})
              </label>
              <div className="field" style={{ marginTop: 8 }}>
                <label htmlFor="refund-job" className="field__label">
                  Count another of the company&apos;s jobs (optional)
                </label>
                <input
                  id="refund-job"
                  className="field__input"
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value.trim())}
                  placeholder="Job posting id"
                />
                <button
                  className="btn btn--ghost btn--sm"
                  type="button"
                  disabled={!jobId || loading}
                  onClick={() => void load(jobId)}
                >
                  Check this job
                </button>
              </div>
            </fieldset>

            <label className="field" htmlFor="refund-reason">
              <span className="field__label">
                Reason<span className="req">*</span>
              </span>
              <textarea
                id="refund-reason"
                className="field__input"
                rows={3}
                minLength={15}
                maxLength={500}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder="Why this order is being refunded (15–500 characters)"
              />
            </label>
            <p className="panel__sub">
              This will refund {formatPaise(eligibility.amount_paise)} and remove{" "}
              {eligibility.credits} credits from this company.
            </p>
          </>
        ) : null}
      </Dialog>
    </>
  );
}

function refundStatusLabel(status: RefundStatus): string {
  switch (status) {
    case "requested":
      return "Requested";
    case "pending":
      return "Pending";
    case "processed":
      return "Processed";
    case "failed":
      return "Failed";
  }
}

function describeRule(rule: {
  eligible: boolean;
  until: string | null;
  refusal: string | null;
}): string {
  if (rule.eligible) return `eligible until ${rule.until?.slice(0, 10) ?? "—"}`;
  return refusalCopy(rule.refusal) ?? "not eligible";
}
