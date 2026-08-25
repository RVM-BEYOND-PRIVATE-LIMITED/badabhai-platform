"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CreditPack } from "../../../lib/contracts";
import { Badge, Button, Card, Dialog, Toast } from "../../../components/ds";
import { formatInr } from "../../../lib/format";
import { createOrderAction, topUpAction, verifyPaymentAction } from "./actions";
import { loadCheckoutScript, openCheckout } from "./razorpay-checkout";

/**
 * Client credit-pack picker. Packs come from CONFIG (passed in as props from the server
 * page) — never hardcoded here, and never an amount this component chooses.
 *
 * TWO MODES, chosen by a SERVER-provided flag:
 *  - `real={false}` (the default): today's MOCK top-up Server Action. Unchanged.
 *  - `real={true}`: create an order server-side → open Razorpay Checkout with it → POST
 *    the result to /verify → refresh the balance.
 *
 * NO SECRET REACHES THIS BUNDLE. The only Razorpay value here is the `rzp_*` KEY ID, and
 * it arrives at runtime on the order response — it is not a `NEXT_PUBLIC_*` build value,
 * not a constant, and not derivable from anything shipped to the browser.
 *
 * HONEST COPY IS A REQUIREMENT, NOT POLISH. A dismissed modal says "cancelled", a failed
 * payment says "failed", and an unconfirmed verification says "if money left your account
 * it will be credited automatically". Nothing in this file can render a success message
 * without a server-confirmed balance behind it.
 */
export function CreditsPanel({ packs, real = false }: { packs: CreditPack[]; real?: boolean }) {
  const router = useRouter();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<CreditPack | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // ONE idempotency key per PURCHASE, not per attempt (#1046). Minted when the payer COMMITS
  // (the confirm below), held across every retry of that SAME pack so the backend dedupes a
  // re-tap into a replay (charged once), and reset on success or a genuinely new pack so a real
  // second purchase gets a FRESH key. A ref, not state: reusing a key must not trigger a render,
  // and the value must survive re-renders. PII-free (`crypto.randomUUID()`), no payer id (XB-A).
  const purchaseKeyRef = useRef<{ key: string; packCode: string } | null>(null);

  /** Reuse the pending key for a retry of the SAME pack; mint a fresh one otherwise. */
  function idempotencyKeyFor(packCode: string): string {
    if (purchaseKeyRef.current === null || purchaseKeyRef.current.packCode !== packCode) {
      purchaseKeyRef.current = { key: crypto.randomUUID(), packCode };
    }
    return purchaseKeyRef.current.key;
  }

  // The best ₹/credit pack — config-derived (the larger packs carry the real discount), never a
  // hardcoded "1000". Used only to flag the tile; the price itself always comes from the catalog.
  const bestValueCode =
    packs.length > 0
      ? packs.reduce((a, b) => (a.priceInr / a.credits <= b.priceInr / b.credits ? a : b)).code
      : null;

  function resetBanners(): void {
    setError(null);
    setMessage(null);
    setNotice(null);
  }

  /**
   * MOCK mode — the buy opens a DS confirm Dialog (no native `window.confirm`). Clicking a
   * pack only ARMS the confirmation; {@link confirmMockTopUp}, wired to the dialog's Confirm
   * button, runs the actual (mock) top-up. Behaviour is otherwise unchanged.
   */
  function onBuyMock(pack: CreditPack): void {
    resetBanners();
    setPendingConfirm(pack);
  }

  /** The dialog's Confirm — run the mock top-up for the armed pack, then refresh the balance. */
  function confirmMockTopUp(): void {
    const pack = pendingConfirm;
    if (!pack) return;
    setPendingConfirm(null);
    resetBanners();
    setPendingCode(pack.code);
    // One key per purchase, reused across a retry of THIS pack (safe re-tap after a timeout).
    const idempotencyKey = idempotencyKeyFor(pack.code);
    startTransition(async () => {
      const res = await topUpAction({ packCode: pack.code, idempotencyKey });
      setPendingCode(null);
      if (res.ok) {
        // TERMINAL success — the purchase is DONE. Drop the key so a genuine next buy mints a fresh one.
        purchaseKeyRef.current = null;
        setMessage(`Added ${res.creditsAdded} credits. New balance: ${res.balance}.`);
        router.refresh();
      } else if ("pending" in res) {
        // A 409 DUPLICATE-IN-FLIGHT (#1185): the FIRST attempt is still running and MAY STILL THROW —
        // this is NOT a completed purchase, so it is NOT a success toast. Show a NEUTRAL processing
        // notice (the balance, if re-read, is current-not-final). KEEP the key so a re-tap replays
        // the SAME key and the backend dedupes it — clearing it here would mint a new key and could
        // double-charge (the exact regression #1178 fixed).
        setNotice(
          typeof res.balance === "number"
            ? `Purchase is still processing. Your balance shows ${res.balance} credits for now — check again in a moment.`
            : "Purchase is still processing — check your balance in a moment.",
        );
        router.refresh();
      } else {
        // KEEP the key: the next tap of this SAME pack replays it and the server dedupes.
        setError(res.error);
      }
    });
  }

  /** REAL mode — order → Razorpay Checkout → server verify → refresh. */
  function onBuyReal(pack: CreditPack): void {
    resetBanners();
    setPendingCode(pack.code);
    startTransition(async () => {
      try {
        // 1. The SERVER creates the order and resolves the price. The client never names
        //    an amount; it only says which pack.
        const order = await createOrderAction({ packCode: pack.code });
        if (!order.ok) {
          setError(order.error);
          return;
        }

        // 2. Load + open checkout. A script that will not load is a failure, never a
        //    silent no-op that leaves the payer staring at a spinner.
        if (!(await loadCheckoutScript())) {
          setError("Couldn't open the payment window. Check your connection and retry.");
          return;
        }
        const result = await openCheckout({
          orderId: order.orderId,
          keyId: order.keyId,
          amount: order.amount,
          currency: order.currency,
          name: "BadaBhai",
          description: `${pack.credits} unlock credits`,
        });

        if (result.outcome === "dismissed") {
          // Closing the modal is not a failure and not a success — say exactly that.
          setNotice("Payment cancelled. You haven't been charged.");
          return;
        }
        if (result.outcome === "failed") {
          setError("Payment failed. No credits were added — you can try again.");
          return;
        }

        // 3. Confirm SERVER-side. The webhook may have already granted; either way the
        //    balance we render comes from the server, never from optimism here.
        const verified = await verifyPaymentAction({
          orderId: result.orderId,
          paymentId: result.paymentId,
          signature: result.signature,
        });
        if (!verified.ok) {
          setError(verified.error);
          return;
        }
        setMessage(
          verified.creditsAdded > 0
            ? `Payment successful. Added ${verified.creditsAdded} credits. New balance: ${verified.balance}.`
            : `Payment successful. Your balance is ${verified.balance} credits.`,
        );
        router.refresh();
      } catch {
        // An unexpected client-side throw must not read as a failed purchase: the webhook
        // settles independently of this browser.
        setError(
          "Something went wrong after payment. If money left your account, your credits will appear shortly.",
        );
      } finally {
        setPendingCode(null);
      }
    });
  }

  const onBuy = real ? onBuyReal : onBuyMock;

  return (
    <>
      {packs.length === 0 ? (
        <div className="state">
          <span className="state__icon">
            <i className="ph ph-wallet" aria-hidden="true" />
          </span>
          <h3 className="state__title">No credit packs on offer</h3>
          <p className="state__body">
            There is nothing to buy right now — this usually means the price list is being
            updated. Your existing balance is unaffected; check back shortly.
          </p>
        </div>
      ) : (
        <div className="credits-packs">
          {packs.map((p) => (
            <Card key={p.code} className="credit-pack">
              <div className="credit-pack__head">
                <span className="credit-pack__name">{p.code.replace(/_/g, " ")}</span>
                {p.code === bestValueCode ? (
                  <Badge tone="brand" upper>
                    Best value
                  </Badge>
                ) : null}
              </div>
              <div className="credit-pack__price bb-mono">{formatInr(p.priceInr)}</div>
              <p className="credit-pack__credits">
                <span className="bb-mono">{p.credits}</span> unlock credits
              </p>
              <Button
                variant="primary"
                block
                disabled={pendingCode !== null}
                loading={pendingCode === p.code}
                onClick={() => onBuy(p)}
              >
                {pendingCode === p.code ? (real ? "Opening…" : "Adding…") : real ? "Buy" : "Buy (mock)"}
              </Button>
            </Card>
          ))}
        </div>
      )}

      <div aria-live="polite" className="credits-result">
        {message ? <Toast tone="success">{message}</Toast> : null}
        {notice ? <Toast tone="neutral">{notice}</Toast> : null}
        {error ? <Toast tone="danger">{error}</Toast> : null}
      </div>

      {/* Confirm-on-spend — the DS Dialog replaces the native `window.confirm`. Copy names the
          pack + price (mock-money), and the post-confirm logic lives on the Confirm button. */}
      <Dialog
        open={pendingConfirm !== null}
        onClose={() => setPendingConfirm(null)}
        title="Add credits?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingConfirm(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={confirmMockTopUp}>
              Add credits
            </Button>
          </>
        }
      >
        {pendingConfirm ? (
          <>
            Add <span className="bb-mono">{pendingConfirm.credits}</span> credits for{" "}
            <span className="bb-mono">{formatInr(pendingConfirm.priceInr)}</span>? This is a mock
            top-up — no real payment is taken.
          </>
        ) : null}
      </Dialog>
    </>
  );
}
