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
import { applyCreditGrantOutcome } from "../lib/credit-grant-outcome";

/** One place the real key is minted; the transition that decides WHEN is pure and tested. */
const mintIdempotencyKey = () => crypto.randomUUID();

/**
 * The Grant credits panel (`grant_credits`).
 *
 * ── THE IDEMPOTENCY KEY IS PER GRANT, NOT PER MOUNT ─────────────────────────────────────
 * The key is minted on mount and then rotated by {@link applyCreditGrantOutcome} the moment
 * the server CONFIRMS it decided on the current one (any successful response, `changed` true
 * or false) — never on a failure, where the response may simply have been lost after the
 * server committed and a fresh key would risk a genuine double grant.
 *
 * That makes "grant another" a supported, safe affordance: this panel stays mounted across
 * the `router.refresh()` that follows a grant (a refresh re-renders the SERVER tree; it does
 * not remount client state), the amount field clears, and the next submit carries a new key.
 * A retry after a failure still replays the SAME key, so a slow network or a doubled click
 * remains exactly-once on the ledger (ADMIN-3a H2).
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
  const [idempotencyKey, setIdempotencyKey] = useState(mintIdempotencyKey);
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
    // The whole key/amount decision lives in one tested transition — see the module doc for
    // why rotating on failure would be the dangerous direction to get wrong.
    const next = applyCreditGrantOutcome({ idempotencyKey, amount }, o, mintIdempotencyKey);
    setIdempotencyKey(next.idempotencyKey);
    setAmount(next.amount);
    if (o.ok) router.refresh();
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
