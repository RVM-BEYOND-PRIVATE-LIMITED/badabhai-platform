"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { Badge, Button, Card, Dialog, Toast } from "../../../components/ds";
import { formatInr } from "../../../lib/format";
import type { ChargedPrice } from "../../../lib/pricing-config";
import { priceChangedMessage } from "../../../lib/price-confirmation";
import { priceFigure } from "../../../components/price-figure";
import { upgradeCapacityAction } from "./actions";

/**
 * Client capacity-tier picker (the QUOTA-PAUSE "Stream A" upgrade leg) — DS2.3 re-skin
 * onto the BadaBhai Design System (VISUAL layer only). Tiers come from CONFIG (passed in
 * as props from the server page) — never hardcoded here. Selecting sends the tier CODE and
 * the price the payer confirmed (#2085 — `expected_price_inr`, a guard the API refuses a
 * changed price with; never an amount it charges, XT5). There is no payment form and no card
 * field here.
 *
 * SHOWN == CHARGED (#2085). A tier's `priceInr` is the price it is charged (the catalog's
 * `prices[]`); its tile strikes the list price through when an offer lowers it, and its button
 * and confirm show the one number the upgrade sends back. A refused price says so in the
 * neutral notice, refreshes the page so the new price shows, and retires the purchase key — the
 * next confirm is a new purchase. Nothing retries on its own.
 *
 * Each tier renders as a DS Card with the ₹ price + concurrent-vacancy allowance in mono
 * tabular and a DS Button wired to the EXISTING live POST /payer/capacity action.
 *
 * PRICE ON THE TRIGGER, THEN A CONFIRM (owner rulings 2026-10-07 — F11 "one tap should have a
 * price shown with confirmation", F35 no "mock" wording). The button reads "Upgrade · ₹X"; it
 * opens the generic DS Dialog (never a ConfirmSpendDialog — that stays the unlock's alone), which
 * asks a neutral priced question — what is bought, for how much, like the credits confirm; it
 * claims no charge (review B1) — with Cancel and a priced confirm. Only that confirm sends. While it runs, the confirmed tier's button alone spins (the rest are just
 * disabled), and the result region is aria-live='polite' (DS Toast). Who may buy is unchanged.
 *
 * FOCUS, ONLY WHEN IT WAS LOST (the team Remove pattern): the Dialog hands focus back to its
 * trigger on close, but a confirmed upgrade disables every tier button while it runs, so that
 * restore falls to the body. Once closed and settled, focus goes back to the tier's button — only
 * if it is still lost.
 *
 * A TIER THE PLAN ALREADY COVERS IS NOT SOLD (review N2). The backend keeps the LARGER allowance
 * (`greatest()` in the capacity upsert), so a tier at or below the payer's current allowance would
 * be paid for and grant nothing. The page passes the allowance it already read (GET
 * /payer/capacity) as `currentAllowance`; such a tier shows "Your plan already allows N live
 * postings" instead of a button. `null` (that read failed) rules nothing out — every tier stays on
 * sale, as before. This is an affordance: the server still decides what a purchase grants.
 */
export type CapacityTier = { code: string; maxActiveVacancies: number } & ChargedPrice;

/** A tier's button — where focus returns once its confirmed upgrade has settled. */
const tierButtonId = (code: string) => `capacity-tier-${code}`;

export function CapacityPanel({
  tiers,
  currentAllowance,
}: {
  tiers: CapacityTier[];
  /** The payer's live concurrent allowance as the page read it, or null when that read failed. */
  currentAllowance: number | null;
}) {
  const router = useRouter();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<CapacityTier | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A NEUTRAL "still processing" notice — distinct from `message` (success) and `error` (danger).
  // A 409 duplicate-in-flight (#1185) lands here: it is NOT a success, so it must not read as one.
  const [notice, setNotice] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // ONE idempotency key per PURCHASE, not per attempt (#1148). A duplicate capacity buy is worse
  // than a duplicate pack — it double-fires the payment/coupon spine for zero extra allowance
  // (`greatest()`). Minted on the confirm below, held across every retry of the SAME tier so a
  // re-tap dedupes into a replay, and reset on success / a genuinely new tier. A ref (survives
  // re-renders, no render on reuse). PII-free (`crypto.randomUUID()`), no payer id (XB-A).
  const purchaseKeyRef = useRef<{ key: string; tier: string } | null>(null);
  // The tier whose button opened the confirm: focus goes back there once the dialog is closed and
  // the upgrade has settled — only if focus was lost meanwhile.
  const focusBack = useRef<string | null>(null);

  useEffect(() => {
    const code = focusBack.current;
    if (code === null || pendingConfirm !== null || pendingCode !== null) return;
    focusBack.current = null;
    // Only when focus was LOST: the payer may have moved on while it ran — leave them there.
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    document.getElementById(tierButtonId(code))?.focus();
  }, [pendingConfirm, pendingCode]);

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

  /** Clicking a tier ARMS a DS confirm Dialog (no native window.confirm) — nothing is sent. */
  function onUpgrade(tier: CapacityTier) {
    setError(null);
    setMessage(null);
    setNotice(null);
    focusBack.current = tier.code;
    setPendingConfirm(tier);
  }

  /** The dialog's Confirm — the ONLY path to the upgrade; buy the armed tier, then refresh. */
  function confirmUpgrade(): void {
    const tier = pendingConfirm;
    if (!tier) return;
    setPendingConfirm(null);
    setError(null);
    setMessage(null);
    setNotice(null);
    setPendingCode(tier.code);
    // One key per purchase, reused across a retry of THIS tier (safe re-tap after a timeout).
    const idempotencyKey = idempotencyKeyFor(tier.code);
    startTransition(async () => {
      // The tier CODE (XT5 / XB-A) and the price this dialog showed (#2085) — never an amount
      // to charge, never the allowance.
      const res = await upgradeCapacityAction({
        tier: tier.code,
        idempotencyKey,
        expectedPriceInr: tier.priceInr,
      });
      setPendingCode(null);
      if (res.ok) {
        // TERMINAL success — the purchase is DONE. Drop the key so a genuine next buy mints a fresh one.
        purchaseKeyRef.current = null;
        setMessage(`Capacity recorded — ${res.resumedCount} posting(s) resumed.`);
        router.refresh();
      } else if ("pending" in res) {
        // A 409 DUPLICATE-IN-FLIGHT (#1185): the FIRST attempt is still running and MAY STILL THROW —
        // NOT a completed purchase, so NOT a success toast. Show a NEUTRAL processing notice (the
        // allowance, if re-read, is current-not-final). KEEP the key so a re-tap replays the SAME key
        // and the backend dedupes it — clearing it here would mint a new key and could double-charge
        // the payment/coupon spine (the exact regression #1178 fixed).
        setNotice(
          typeof res.allowance === "number"
            ? `Purchase is still processing. Your allowance shows ${res.allowance} concurrent postings for now — check again in a moment.`
            : "Purchase is still processing — check your allowance in a moment.",
        );
        router.refresh();
      } else if ("priceChanged" in res) {
        // #2085 — nothing was bought. A new confirm at the new price is a NEW purchase, so the
        // key is retired (reusing it would replay this refusal); the page re-reads the price.
        purchaseKeyRef.current = null;
        setNotice(priceChangedMessage(res.currentPriceInr));
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
            <Icon name="stack" />
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
              <div className="capacity-tier__price bb-mono">{priceFigure(t)}</div>
              <p className="capacity-tier__allowance">
                <span className="bb-mono">{t.maxActiveVacancies}</span> concurrent postings
              </p>
              {currentAllowance !== null && t.maxActiveVacancies <= currentAllowance ? (
                // Already covered: buying it would grant nothing (the larger allowance is kept).
                <p className="capacity-tier__included">
                  Your plan already allows <span className="bb-mono">{currentAllowance}</span> live
                  postings
                </p>
              ) : (
                <Button
                  id={tierButtonId(t.code)}
                  variant="primary"
                  block
                  disabled={pendingCode !== null}
                  loading={pendingCode === t.code}
                  onClick={() => onUpgrade(t)}
                >
                  {pendingCode === t.code ? (
                    "Recording…"
                  ) : (
                    <>
                      Upgrade · <span className="bb-mono">{formatInr(t.priceInr)}</span>
                    </>
                  )}
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}

      <div aria-live="polite" className="capacity-result">
        {message ? <Toast tone="success">{message}</Toast> : null}
        {notice ? <Toast tone="neutral">{notice}</Toast> : null}
        {error ? <Toast tone="danger">{error}</Toast> : null}
      </div>

      {/* Confirm-on-spend — the generic DS Dialog (never the credit-spend confirm). A neutral
          priced question (what is bought, for how much — it claims no charge); its confirm
          carries the price. */}
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
              {pendingConfirm ? (
                <>
                  {" "}
                  · <span className="bb-mono">{formatInr(pendingConfirm.priceInr)}</span>
                </>
              ) : null}
            </Button>
          </>
        }
      >
        {pendingConfirm ? (
          <>
            Upgrade to the <span className="bb-mono">{pendingConfirm.maxActiveVacancies}</span>
            -posting tier for <span className="bb-mono">{formatInr(pendingConfirm.priceInr)}</span>?
          </>
        ) : null}
      </Dialog>
    </>
  );
}
