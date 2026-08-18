"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "./admin-action-button";
import { AdminActionResultBanner } from "./admin-action-result-banner";
import { grantCreditsAction } from "./payer-actions";
import {
  CREDIT_GRANT_REASONS,
  CREDIT_GRANT_REASON_LABELS,
  ADMIN_CREDIT_GRANT_MAX,
  type CreditGrantReason,
} from "../lib/admin-action-vocabulary";
import type { AdminActionOutcome } from "../lib/admin-action-result";

/**
 * The Grant credits panel (`grant_credits`).
 *
 * The idempotency key is minted ONCE per mount via `useState(() => crypto.randomUUID())` —
 * never regenerated on re-render or retry — so a genuine double-submit (a slow network, a
 * doubled click that slips past the confirm step) is exactly-once on the server's ledger
 * (ADMIN-3a H2). A NEW key is only ever minted by remounting this panel, i.e. navigating away
 * and back — there is deliberately no "grant another" affordance that reuses the component
 * without a fresh key.
 */
export function PayerCreditsPanel({
  payerId,
  suspended,
  timelineHref,
}: {
  payerId: string;
  suspended: boolean;
  timelineHref: string;
}) {
  const router = useRouter();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState("");
  const [reasonCode, setReasonCode] = useState<CreditGrantReason>(CREDIT_GRANT_REASONS[0]);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const amountId = useId();
  const reasonId = useId();

  const parsedAmount = Number(amount);
  const amountValid =
    amount.trim() !== "" &&
    Number.isInteger(parsedAmount) &&
    parsedAmount > 0 &&
    parsedAmount <= ADMIN_CREDIT_GRANT_MAX;

  function handleSettled(o: AdminActionOutcome) {
    setOutcome(o);
    if (o.ok) {
      router.refresh();
      if (o.changed) setAmount("");
    }
  }

  return (
    <section className="panel" aria-labelledby="p-credits">
      <div className="panel__head">
        <h2 className="panel__title" id="p-credits">
          Grant credits
        </h2>
        <p className="panel__sub">
          A positive, additive top-up. Recorded on the ledger with the reason below — never on
          the audit spine, which only records that an admin acted.
        </p>
      </div>

      {suspended ? (
        <p className="field__help">
          This payer is suspended. Reinstate the account before granting credits.
        </p>
      ) : (
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <div className="form-grid">
            <label className="field" htmlFor={amountId}>
              <span className="field__label">
                Credits<span className="req">*</span>
              </span>
              <input
                id={amountId}
                className="field__input"
                type="number"
                inputMode="numeric"
                min={1}
                max={ADMIN_CREDIT_GRANT_MAX}
                step={1}
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={amount !== "" && !amountValid ? true : undefined}
              />
            </label>
            <label className="field" htmlFor={reasonId}>
              <span className="field__label">Reason</span>
              <select
                id={reasonId}
                className="field__input"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value as CreditGrantReason)}
              >
                {CREDIT_GRANT_REASONS.map((code) => (
                  <option key={code} value={code}>
                    {CREDIT_GRANT_REASON_LABELS[code]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-actions">
            <AdminActionButton
              label="Grant credits"
              confirmLabel={`Confirm grant of ${amount || "0"}?`}
              variant="primary"
              disabled={!amountValid}
              action={() =>
                grantCreditsAction(payerId, { amount: parsedAmount, reasonCode, idempotencyKey })
              }
              onSettled={handleSettled}
            />
          </div>
        </form>
      )}

      {outcome && <AdminActionResultBanner outcome={outcome} timelineHref={timelineHref} />}
    </section>
  );
}
