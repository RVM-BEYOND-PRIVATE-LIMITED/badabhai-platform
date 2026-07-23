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
import { Badge, Button, Card } from "../../../../components/ds";
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
    <section className="agency-section">
      <h2 className="agency-section__title">Payouts</h2>

      <div className="agency-payout__actions">
        <Button
          variant="success"
          onClick={handleRequest}
          disabled={!canRequest || pending}
          loading={pending}
        >
          {pending ? "Requesting…" : "Request payout"}
        </Button>
        {canRequest ? (
          <span className="agency-stat__hint">
            Requestable now: <span className="bb-mono">{formatInr(earnings.requestableInr)}</span>
          </span>
        ) : null}
      </div>

      {disabledReason ? <p className="agency-payout__reason">{disabledReason}</p> : null}

      <div aria-live="polite" className="agency-invite__status">
        {outcome?.kind === "created" ? (
          <Card variant="flat" className="agency-invite__note">
            <Badge tone="success" upper icon="check-circle">
              Requested
            </Badge>{" "}
            Payout of <span className="bb-mono">{formatInr(outcome.amountInr)}</span> requested
            across <span className="bb-mono">{outcome.accrualCount}</span>{" "}
            {outcome.accrualCount === 1 ? "accrual" : "accruals"}. It will show below once
            processed (mock — no real money moves).
          </Card>
        ) : null}
        {outcome?.kind === "blocked" ? (
          <p className="agency-payout__reason">{outcome.message}</p>
        ) : null}
        {outcome?.kind === "error" ? (
          <p className="agency-invite__error">{outcome.message}</p>
        ) : null}
      </div>

      {payoutHistory(payouts)}
    </section>
  );
}

/**
 * The payout request history — PII-free rows (opaque id / ₹ / status / day). A plain
 * function (called inline, not a nested component) so it renders as part of the tree.
 */
function payoutHistory(payouts: AgencyPayout[]) {
  if (payouts.length === 0) {
    return <p className="agency-payout__empty">No payout requests yet.</p>;
  }
  return (
    <ul className="agency-payout__list">
      {payouts.map((p) => (
        <li key={p.id}>
          <Card className="agency-payout__row">
            <span>
              <span className="agency-payout__amount bb-mono">{formatInr(p.amountInr)}</span>{" "}
              <span className="agency-payout__meta">
                · <span className="bb-mono">{p.accrualCount}</span>{" "}
                {p.accrualCount === 1 ? "accrual" : "accruals"} · {day(p.createdAt)}
              </span>
            </span>
            <Badge tone={statusTone(p.status)} upper>
              {p.status}
            </Badge>
          </Card>
        </li>
      ))}
    </ul>
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
