"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Input, Toast } from "../../../../components/ds";
import { formatInr } from "../../../../lib/format";
import { buyBoostAction, buyPlanAction } from "./actions";

/**
 * Company POSTING-DETAIL buy panel (B3 / #179) — MIRRORS the capacity buy UX (DS2.3) on the
 * BadaBhai Design System. Runs in the BROWSER and sees NO secret.
 *
 * Plan tiers (standard/pro) + the boost tier (all_candidates) come from CONFIG (props from the
 * server page) — never hardcoded here. Price + validity/quota are DISPLAY-only; buying sends ONLY
 * the tier CODE (+ an optional coupon) to the (mock-money) Server Action (XT5: the client NEVER
 * sends a price/amount/quota; XB-A: never a payer_id — the posting id rides the PATH). There is no
 * payment form, no card field, no real money — the backend mock-purchases (real_call:false).
 *
 * A window.confirm precedes the buy (mock-money copy); buttons disable while submitting; the
 * result region is aria-live='polite' (a DS success/neutral-failure Toast). A foreign/unknown
 * posting maps to the SAME neutral failure card (no-oracle).
 */
export type PlanTierOption = {
  code: "standard" | "pro";
  priceInr: number;
  validityDays: number;
  applicantVisibilityQuota: number;
};
export type BoostTierOption = { code: "all_candidates"; priceInr: number; boostDays: number };

export function PostingBuyPanel({
  postingId,
  planTiers,
  boostOptions,
}: {
  postingId: string;
  planTiers: PlanTierOption[];
  boostOptions: BoostTierOption[];
}) {
  const router = useRouter();
  const [coupon, setCoupon] = useState("");
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The optional coupon is a single shared, PII-free code applied to whichever tier is bought.
  const couponArg = coupon.trim() === "" ? undefined : coupon.trim();

  function onBuyPlan(tier: PlanTierOption) {
    const ok = window.confirm(
      `Buy the ${tier.code} plan for ${formatInr(tier.priceInr)}? ` +
        "This is a mock purchase — no real payment is taken.",
    );
    if (!ok) return;
    setError(null);
    setMessage(null);
    setPendingCode(tier.code);
    startTransition(async () => {
      // Send ONLY the tier CODE (+ optional coupon) — never the displayed price/quota (XT5/XB-A).
      const res = await buyPlanAction({ postingId, tier: tier.code, coupon: couponArg });
      setPendingCode(null);
      if (res.ok) {
        setMessage(
          res.paused
            ? `${res.tier} plan recorded — paused (over your capacity allowance). Add capacity to activate it.`
            : `${res.tier} plan recorded — status ${res.status}.`,
        );
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  function onBuyBoost(tier: BoostTierOption) {
    const ok = window.confirm(
      `Buy the ${tier.code.replace(/_/g, " ")} boost for ${formatInr(tier.priceInr)}? ` +
        "This is a mock purchase — no real payment is taken.",
    );
    if (!ok) return;
    setError(null);
    setMessage(null);
    setPendingCode(tier.code);
    startTransition(async () => {
      const res = await buyBoostAction({ postingId, tier: tier.code, coupon: couponArg });
      setPendingCode(null);
      if (res.ok) {
        setMessage(`Boost recorded — status ${res.status}.`);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <>
      <div className="posting-buy__coupon">
        <Input
          label="Coupon code (optional)"
          value={coupon}
          onChange={(e) => setCoupon(e.target.value)}
          placeholder="Have a code? Enter it here"
          maxLength={64}
          autoComplete="off"
        />
      </div>

      <section className="posting-buy__section">
        <h2 className="posting-buy__title">Plans</h2>
        {planTiers.length === 0 ? (
          <Card variant="flat" className="posting-buy__empty">
            No plans are currently offered.
          </Card>
        ) : (
          <div className="posting-buy__tiers">
            {planTiers.map((t) => (
              <Card key={t.code} className="posting-buy__tier">
                <div className="posting-buy__tier-head">
                  <span className="posting-buy__tier-name">{t.code}</span>
                </div>
                <div className="posting-buy__tier-price bb-mono">{formatInr(t.priceInr)}</div>
                <p className="posting-buy__tier-meta">
                  <span className="bb-mono">{t.applicantVisibilityQuota}</span> applicant views ·{" "}
                  <span className="bb-mono">{t.validityDays}</span> days
                </p>
                <Button
                  variant="primary"
                  block
                  disabled={pendingCode !== null}
                  loading={pendingCode === t.code}
                  onClick={() => onBuyPlan(t)}
                >
                  {pendingCode === t.code ? "Recording…" : "Buy (mock)"}
                </Button>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="posting-buy__section">
        <h2 className="posting-buy__title">Boost</h2>
        {boostOptions.length === 0 ? (
          <Card variant="flat" className="posting-buy__empty">
            No boosters are currently offered.
          </Card>
        ) : (
          <div className="posting-buy__tiers">
            {boostOptions.map((t) => (
              <Card key={t.code} className="posting-buy__tier">
                <div className="posting-buy__tier-head">
                  <span className="posting-buy__tier-name">{t.code.replace(/_/g, " ")}</span>
                  <Badge tone="brand" upper>
                    Boost
                  </Badge>
                </div>
                <div className="posting-buy__tier-price bb-mono">{formatInr(t.priceInr)}</div>
                <p className="posting-buy__tier-meta">
                  Broadcast to all candidates for <span className="bb-mono">{t.boostDays}</span> days
                </p>
                <Button
                  variant="primary"
                  block
                  disabled={pendingCode !== null}
                  loading={pendingCode === t.code}
                  onClick={() => onBuyBoost(t)}
                >
                  {pendingCode === t.code ? "Recording…" : "Buy (mock)"}
                </Button>
              </Card>
            ))}
          </div>
        )}
      </section>

      <div aria-live="polite" className="posting-buy__result">
        {message ? <Toast tone="success">{message}</Toast> : null}
        {error ? <Toast tone="danger">{error}</Toast> : null}
      </div>
    </>
  );
}
