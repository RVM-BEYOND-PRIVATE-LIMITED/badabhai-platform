"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { CreditPack } from "../../../lib/contracts";
import { Button, Card, Dialog, InlineNotice } from "../../../components/ds";
import { CountUp } from "../../../components/ds/count-up";
import { useToast } from "../../../components/ds/toast-provider";
import { formatInr } from "../../../lib/format";
import { earlierPurchaseMessage, priceChangedMessage } from "../../../lib/purchase-messages";
import { creditsErrorMessage } from "../../../lib/credits-messages";
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
 *
 * NO "MOCK" WORDING (owner ruling 2026-10-07, F35): a pack's button reads "Buy" in both modes
 * and the confirm carries no mock disclaimer. Only the copy changed — the mode still decides
 * the flow (and the busy label: "Opening…" for checkout, "Adding…" for the top-up).
 *
 * SHOWN == CHARGED (#2085). A pack's `priceInr` is the price it is charged (the catalog's
 * `prices[]`), and it is the ONE price its tile shows (#2744: catalogue values only — no struck
 * list price, no per-unlock rate, no "best value"). The purchase sends back the exact number the
 * payer saw — the confirm's price (mock) or the tile's (real, which has no confirm of its own) —
 * as `expected_price_inr`. A changed price is refused by the API with nothing bought: the panel
 * says so in the neutral notice, refreshes the page so the new price shows, and retires the
 * purchase key (the next confirm is a new purchase). It never retries on its own.
 *
 * ONE SUCCESS PATTERN (#2583): a completed purchase is announced as a toast from the portal's
 * ToastProvider — once, dismissing itself — with the new balance counting up from the old one.
 * The neutral notice and the error stay in this panel's own region: they are about this panel and
 * must not vanish on a timer. Only the FIRST pack's Buy, in the catalogue's order, is the primary
 * action; the others are secondary, so the screen has one primary. It marks a position, never a
 * value: no pack is singled out as the better buy (#2744).
 */
export function CreditsPanel({ packs, real = false }: { packs: CreditPack[]; real?: boolean }) {
  const router = useRouter();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<CreditPack | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const toast = useToast();

  /** The purchase is DONE: a success toast, the balance counting up to the server's figure. */
  function announcePurchase(lead: string, creditsAdded: number, balance: number): void {
    toast.show({
      tone: "success",
      title: "Credits added",
      message: (
        <>
          {lead}New balance: <CountUp from={balance - creditsAdded} to={balance} /> credits.
        </>
      ),
    });
  }

  // ONE idempotency key per PURCHASE, not per attempt (#1046). Minted when the payer COMMITS
  // (the confirm below), held across every retry of that SAME pack so the backend dedupes a
  // re-tap into a replay (charged once), and reset on success or a genuinely new pack so a real
  // second purchase gets a FRESH key. A ref, not state: reusing a key must not trigger a render,
  // and the value must survive re-renders. PII-free (`crypto.randomUUID()`), no payer id (XB-A).
  // It also remembers the price it was first confirmed at (#2085 L2 — see confirmMockTopUp).
  const purchaseKeyRef = useRef<{ key: string; packCode: string; priceInr: number } | null>(null);

  /** Reuse the pending key for a retry of the SAME pack; mint a fresh one otherwise. */
  function idempotencyKeyFor(pack: CreditPack): string {
    if (purchaseKeyRef.current === null || purchaseKeyRef.current.packCode !== pack.code) {
      purchaseKeyRef.current = {
        key: crypto.randomUUID(),
        packCode: pack.code,
        priceInr: pack.priceInr,
      };
    }
    return purchaseKeyRef.current.key;
  }

  function resetBanners(): void {
    setError(null);
    setNotice(null);
  }

  /**
   * MOCK mode — the buy opens a DS confirm Dialog (no native `window.confirm`). Clicking a
   * pack only ARMS the confirmation; {@link confirmMockTopUp}, wired to the dialog's Confirm
   * button, runs the actual top-up. Behaviour is otherwise unchanged.
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
    // ONE KEY, ONE CONFIRMED PRICE (#2085 L2). A key still held for this pack belongs to an earlier
    // attempt whose outcome is unknown (still processing, a failure, a dropped connection). Reusing
    // it is what stops a retry buying twice — the API replays the FIRST attempt — so it is never
    // swapped for a fresh key while held. But that replay is the first attempt's purchase, at the
    // first attempt's price: sent after the payer confirmed a DIFFERENT price, the panel would
    // announce a purchase this dialog never described. So that confirm is not sent; the payer is
    // told an earlier purchase may still be processing. Deliberate: a hold (until the page is
    // reloaded and the earlier attempt's effect shows) over a second charge or a mislabelled one.
    const held = purchaseKeyRef.current;
    if (held !== null && held.packCode === pack.code && held.priceInr !== pack.priceInr) {
      setNotice(earlierPurchaseMessage(held.priceInr));
      return;
    }
    setPendingCode(pack.code);
    // One key per purchase, reused across a retry of THIS pack (safe re-tap after a timeout).
    const idempotencyKey = idempotencyKeyFor(pack);
    startTransition(async () => {
      // The price sent back is the one the dialog showed for this pack (#2085).
      const res = await topUpAction({
        packCode: pack.code,
        idempotencyKey,
        expectedPriceInr: pack.priceInr,
      });
      setPendingCode(null);
      if (res.ok) {
        // TERMINAL success — the purchase is DONE. Drop the key so a genuine next buy mints a fresh one.
        purchaseKeyRef.current = null;
        announcePurchase(`Added ${res.creditsAdded} credits. `, res.creditsAdded, res.balance);
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
      } else if ("priceChanged" in res) {
        // #2085 — nothing was bought. A new confirm at the new price is a NEW purchase, so the
        // key is retired (reusing it would replay this refusal); the page re-reads the price.
        purchaseKeyRef.current = null;
        setNotice(priceChangedMessage(res.currentPriceInr));
        router.refresh();
      } else {
        // KEEP the key: the next tap of this SAME pack replays it and the server dedupes.
        setError(creditsErrorMessage(res.error));
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
        //    an amount to charge; it says which pack, and the price on that pack's tile
        //    (#2085) so the server can refuse a price that changed since.
        const order = await createOrderAction({
          packCode: pack.code,
          expectedPriceInr: pack.priceInr,
        });
        if (!order.ok) {
          if ("priceChanged" in order) {
            // No order exists, so no checkout opens at a price the payer did not see.
            setNotice(priceChangedMessage(order.currentPriceInr));
            router.refresh();
          } else {
            setError(creditsErrorMessage(order.error));
          }
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
          setError(creditsErrorMessage(verified.error));
          return;
        }
        announcePurchase(
          verified.creditsAdded > 0
            ? `Payment successful. Added ${verified.creditsAdded} credits. `
            : "Payment successful. ",
          verified.creditsAdded,
          verified.balance,
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
            <Icon name={ACTION_ICON.credits} />
          </span>
          <h3 className="state__title">No credit packs on offer</h3>
          <p className="state__body">
            There is nothing to buy right now — this usually means the price list is being updated.
            Your existing balance is unaffected; check back shortly.
          </p>
        </div>
      ) : (
        <div className="cred-pack-grid">
          {packs.map((p, i) => {
            // Catalogue values only (#2744): the pack's credits and the price it is charged.
            return (
              <Card key={p.code} className="cred-pack">
                <div className="cred-pack__head">
                  <span className="cred-pack__name">Pack {p.credits}</span>
                </div>
                <div className="cred-pack__price">
                  <strong className="bb-mono">{formatInr(p.priceInr)}</strong>
                  <span className="cred-pack__gst">+ GST</span>
                </div>
                <p className="cred-pack__line">
                  <Icon name="check" /> <span className="bb-mono">{p.credits}</span> unlock credits
                </p>
                <Button
                  variant={i === 0 ? "primary" : "secondary"}
                  block
                  disabled={pendingCode !== null}
                  loading={pendingCode === p.code}
                  onClick={() => onBuy(p)}
                >
                  {pendingCode === p.code ? (
                    real ? "Opening…" : "Adding…"
                  ) : (
                    <>
                      {`Buy Pack ${p.credits}`}
                      <Icon name={ACTION_ICON.next} />
                    </>
                  )}
                </Button>
              </Card>
            );
          })}
        </div>
      )}

      <div aria-live="polite" className="credits-result">
        {notice ? <InlineNotice tone="info">{notice}</InlineNotice> : null}
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      </div>

      {/* Confirm-on-spend — the DS Dialog replaces the native `window.confirm`. Copy names the
          pack + price, and the post-confirm logic lives on the Confirm button. */}
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
            <span className="bb-mono">{formatInr(pendingConfirm.priceInr)}</span>?
          </>
        ) : null}
      </Dialog>
    </>
  );
}
