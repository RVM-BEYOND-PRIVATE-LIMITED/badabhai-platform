"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AGENCY_PAYOUT_BLOCKED_REASONS,
  type AgencyEarnings,
  type AgencyPayout,
  type AgencyPayoutBlockedReason,
} from "../../../../lib/contracts";
import { formatInr } from "../../../../lib/format";
import { day, payoutBlockedLabel } from "../../../../lib/agency-view";
import { Badge, Button } from "../../../../components/ds";
import { requestPayoutAction } from "./supply-actions";

/**
 * AGENCY PAYOUT panel (ADR-0022 Amendment 2, LIVE) — request a payout of the requestable
 * balance and show request history. Runs in the BROWSER; sees NO secret. MOCK money.
 *
 * The "Request payout" button is DISABLED with an explanatory reason whenever
 * `earnings.canRequest` is false — the reason is mapped from `earnings.blockedReason`
 * (KYC not verified / below threshold / not enabled) to friendly, no-oracle copy. On
 * success the created request is shown and the history is re-read (`router.refresh()`,
 * paired with the action's `revalidatePath`). A blocked/transient result surfaces in an
 * aria-live region — never a fake success.
 */
export function PayoutPanel({
  earnings,
  payouts,
}: {
  earnings: AgencyEarnings;
  payouts: AgencyPayout[];
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [pending, startTransition] = useTransition();

  const canRequest = earnings.canRequest;
  const disabledReason = canRequest
    ? null
    : payoutBlockedLabel(earnings.blockedReason, earnings.thresholdInr);

  function handleRequest() {
    setOutcome(null);
    startTransition(async () => {
      const res = await requestPayoutAction();
      if (res.ok) {
        setOutcome({ kind: "created", amountInr: res.amountInr, accrualCount: res.accrualCount });
        router.refresh(); // re-read history + earnings (paired with revalidatePath).
      } else if ("disabled" in res) {
        setOutcome({ kind: "blocked", message: "Payouts aren't enabled yet." });
      } else if ("blocked" in res) {
        setOutcome({ kind: "blocked", message: reasonLabel(res.reason, earnings.thresholdInr) });
      } else {
        setOutcome({ kind: "error", message: res.error });
      }
    });
  }

  return (
    <>
      {/* The REQUEST control. A bordered `.panel` — the primary action lives in the panel head,
          where the screen's other panels put theirs. */}
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Payouts</h2>
          <p className="panel__sub">
            Request a payout of your requestable balance. Mock money — nothing is actually
            disbursed.
          </p>
          <div className="panel__actions">
            <Button
              variant="success"
              onClick={handleRequest}
              disabled={!canRequest || pending}
              loading={pending}
            >
              {pending ? "Requesting…" : "Request payout"}
            </Button>
          </div>
        </div>
        <div className="panel__body">
          {canRequest ? (
            <p className="section__sub">
              Requestable now:{" "}
              <span className="bb-mono">{formatInr(earnings.requestableInr)}</span>
            </p>
          ) : null}

          {disabledReason ? <p className="section__sub">{disabledReason}</p> : null}

          {/* `.form-status:empty` collapses, so an idle panel carries no stray gap. */}
          <div aria-live="polite" className="form-status">
            {outcome?.kind === "created" ? (
              <div className="alert alert--success">
                <i className="ph ph-check-circle alert__icon" aria-hidden="true" />
                <div className="alert__text">
                  <p className="alert__title">Payout requested</p>
                  <p className="alert__body">
                    Payout of <span className="bb-mono">{formatInr(outcome.amountInr)}</span>{" "}
                    requested across <span className="bb-mono">{outcome.accrualCount}</span>{" "}
                    {outcome.accrualCount === 1 ? "accrual" : "accruals"}. It will show below
                    once processed (mock — no real money moves).
                  </p>
                </div>
              </div>
            ) : null}
            {outcome?.kind === "blocked" ? (
              <p className="section__sub">{outcome.message}</p>
            ) : null}
            {outcome?.kind === "error" ? (
              <div className="alert alert--danger">
                <i className="ph ph-warning-circle alert__icon" aria-hidden="true" />
                <div className="alert__text">
                  <p className="alert__title">We couldn&rsquo;t request that payout</p>
                  <p className="alert__body">{outcome.message}</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {payoutHistory(payouts)}
    </>
  );
}

/**
 * The payout request history — PII-free rows (₹ / accrual count / status / day). A plain
 * function (called inline, not a nested component) so it renders as part of the tree.
 *
 * The ad-hoc Card list is now the DS `.table` inside a `.panel--table` (whose body owns no
 * padding — the cell padding is the rhythm). The opaque request id is deliberately NOT a
 * column: it is not actionable and adds nothing a payer can use.
 */
function payoutHistory(payouts: AgencyPayout[]) {
  return (
    <section className="panel panel--table">
      <div className="panel__head">
        <h2 className="panel__title">Request history</h2>
      </div>
      <div className="panel__body">
        {payouts.length === 0 ? (
          <div className="state">
            <span className="state__icon">
              <i className="ph ph-receipt" aria-hidden="true" />
            </span>
            <h3 className="state__title">No payout requests yet</h3>
            <p className="state__body">
              Once your requestable balance clears the threshold, use &ldquo;Request
              payout&rdquo; above — every request you make will be listed here with its status.
            </p>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">
                Your payout requests: the amount, how many accruals it covers, the day it was
                requested, and its current status.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Amount</th>
                  <th scope="col">Accruals</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id}>
                    <td className="num">{formatInr(p.amountInr)}</td>
                    <td className="num">{p.accrualCount}</td>
                    <td className="mono">{day(p.createdAt)}</td>
                    <td>
                      <Badge tone={statusTone(p.status)} upper>
                        {p.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

type Outcome =
  | { kind: "created"; amountInr: number; accrualCount: number }
  | { kind: "blocked"; message: string }
  | { kind: "error"; message: string }
  | null;

/** Badge tone per payout status. */
function statusTone(status: AgencyPayout["status"]): "success" | "danger" | "info" {
  if (status === "paid") return "success";
  if (status === "rejected") return "danger";
  return "info"; // requested
}

/** Map the backend blocked `reason` string to friendly copy (unknown → generic). */
function reasonLabel(reason: string, thresholdInr: number): string {
  const known = (AGENCY_PAYOUT_BLOCKED_REASONS as readonly string[]).includes(reason)
    ? (reason as AgencyPayoutBlockedReason)
    : null;
  return payoutBlockedLabel(known, thresholdInr);
}
