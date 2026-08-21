"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Dialog, Toast } from "../../../components/ds";
import { formatInr } from "../../../lib/format";
import { upgradeCapacityAction } from "./actions";

/**
 * Client capacity-tier picker (the QUOTA-PAUSE "Stream A" upgrade leg) — DS2.3 re-skin
 * onto the BadaBhai Design System (VISUAL layer only). Tiers come from CONFIG (passed in
 * as props from the server page) — never hardcoded here. Price + the vacancy allowance are
 * DISPLAY-only; selecting sends ONLY the tier CODE to the (mock-money) Server Action
 * (XT5: the client NEVER sends a price/amount/quota). There is no payment form, no card
 * field, no real money — the backend mock-upgrades (real_call:false).
 *
 * Each tier renders as a DS Card with the ₹ price + concurrent-vacancy allowance in mono
 * tabular and a DS Button wired to the EXISTING live POST /payer/capacity action. A DS
 * Dialog confirm step precedes the buy (mock-money copy) instead of a native window.confirm,
 * the buttons disable while submitting, and the result region is aria-live='polite' (DS Toast).
 */
export type CapacityTier = { code: string; priceInr: number; maxActiveVacancies: number };

export function CapacityPanel({ tiers }: { tiers: CapacityTier[] }) {
  const router = useRouter();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<CapacityTier | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // ONE idempotency key per PURCHASE, not per attempt (#1148). A duplicate capacity buy is worse
  // than a duplicate pack — it double-fires the payment/coupon spine for zero extra allowance
  // (`greatest()`). Minted on the confirm below, held across every retry of the SAME tier so a
  // re-tap dedupes into a replay, and reset on success / a genuinely new tier. A ref (survives
  // re-renders, no render on reuse). PII-free (`crypto.randomUUID()`), no payer id (XB-A).
  const purchaseKeyRef = useRef<{ key: string; tier: string } | null>(null);

  /** Reuse the pending key for a retry of the SAME tier; mint a fresh one otherwise. */
  function idempotencyKeyFor(tier: string): string {
    if (purchaseKeyRef.current === null || purchaseKeyRef.current.tier !== tier) {
      purchaseKeyRef.current = { key: crypto.randomUUID(), tier };
    }
    return purchaseKeyRef.current.key;
  }

  // The largest concurrent allowance is the "most capacity" tile — config-derived, never a
  // literal. Used only to flag the tile; the price/allowance themselves always come from config.
  const topTierCode =
    tiers.length > 0
      ? tiers.reduce((a, b) => (a.maxActiveVacancies >= b.maxActiveVacancies ? a : b)).code
      : null;

  /** Clicking a tier ARMS a DS confirm Dialog (no native window.confirm). */
  function onUpgrade(tier: CapacityTier) {
    setError(null);
    setMessage(null);
    setPendingConfirm(tier);
  }

  /** The dialog's Confirm — mock-upgrade the armed tier, then refresh. */
  function confirmUpgrade(): void {
    const tier = pendingConfirm;
    if (!tier) return;
    setPendingConfirm(null);
    setError(null);
    setMessage(null);
    setPendingCode(tier.code);
    // One key per purchase, reused across a retry of THIS tier (safe re-tap after a timeout).
    const idempotencyKey = idempotencyKeyFor(tier.code);
    startTransition(async () => {
      // Send ONLY the tier CODE (XT5 / XB-A) — never the displayed price/allowance.
      const res = await upgradeCapacityAction({ tier: tier.code, idempotencyKey });
      setPendingCode(null);
      if (res.ok) {
        // The purchase is DONE — drop the key so a genuine next buy mints a fresh one.
        purchaseKeyRef.current = null;
        if ("duplicate" in res) {
          // A 409 replay: the first tap already recorded the capacity. `allowance` is the REAL
          // re-read figure (server-side GET), never a guessed number — show it as-is.
          setMessage(
            `Capacity already recorded — your allowance is ${res.allowance} concurrent vacancies.`,
          );
        } else {
          setMessage(`Capacity recorded — ${res.resumedCount} posting(s) resumed.`);
        }
        router.refresh();
      } else {
        // KEEP the key: the next tap of this SAME tier replays it and the server dedupes.
        setError(res.error);
      }
    });
  }

  return (
    <>
      {tiers.length === 0 ? (
        <div className="state">
          <span className="state__icon">
            <i className="ph ph-stack" aria-hidden="true" />
          </span>
          <h3 className="state__title">No capacity tiers on offer</h3>
          <p className="state__body">
            There is nothing to buy right now — this usually means the price list is being
            updated. Your current allowance is unaffected; check back shortly.
          </p>
        </div>
      ) : (
        <div className="capacity-tiers">
          {tiers.map((t) => (
            <Card key={t.code} className="capacity-tier">
              <div className="capacity-tier__head">
                <span className="capacity-tier__name">{t.code.replace(/_/g, " ")}</span>
                {t.code === topTierCode ? (
                  <Badge tone="brand" upper>
                    Most capacity
                  </Badge>
                ) : null}
              </div>
              <div className="capacity-tier__price bb-mono">{formatInr(t.priceInr)}</div>
              <p className="capacity-tier__allowance">
                <span className="bb-mono">{t.maxActiveVacancies}</span> concurrent vacancies
              </p>
              <Button
                variant="primary"
                block
                disabled={pendingCode !== null}
                loading={pendingCode === t.code}
                onClick={() => onUpgrade(t)}
              >
                {pendingCode === t.code ? "Recording…" : "Buy (mock)"}
              </Button>
            </Card>
          ))}
        </div>
      )}

      <div aria-live="polite" className="capacity-result">
        {message ? <Toast tone="success">{message}</Toast> : null}
        {error ? <Toast tone="danger">{error}</Toast> : null}
      </div>

      {/* Confirm-on-spend — the DS Dialog replaces the native window.confirm. Copy names the
          tier allowance + price (mock-money); the post-confirm logic lives on Confirm. */}
      <Dialog
        open={pendingConfirm !== null}
        onClose={() => setPendingConfirm(null)}
        title="Upgrade capacity?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingConfirm(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={confirmUpgrade}>
              Upgrade
            </Button>
          </>
        }
      >
        {pendingConfirm ? (
          <>
            Upgrade to the <span className="bb-mono">{pendingConfirm.maxActiveVacancies}</span>
            -vacancy tier for{" "}
            <span className="bb-mono">{formatInr(pendingConfirm.priceInr)}</span>? This is a mock
            upgrade — no real payment is taken.
          </>
        ) : null}
      </Dialog>
    </>
  );
}
