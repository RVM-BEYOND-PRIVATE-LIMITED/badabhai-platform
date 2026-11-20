"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../../../components/ds";
import { openCheckout } from "../../credits/razorpay-checkout";
import { verifyPaymentAction } from "../../credits/actions";
import {
  buyManagedHiringAction,
  requestCallbackAction,
} from "./managed-hiring-actions";
import type { ManagedHiringOrder, ManagedHiringQuote } from "../../../../lib/managed-hiring";

function inr(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

/**
 * #2751 — the Managed Hiring card on a job page. The quote decides what is offered: a tier price
 * (paid tap opens checkout.js here on the web) or, above the largest tier, "Request a call".
 * No label promises a hire; the server's terms line shows wherever the product is offered.
 */
export function ManagedHiringCard({
  jobPostingId,
  quote,
  order,
}: {
  jobPostingId: string;
  quote: ManagedHiringQuote;
  order: ManagedHiringOrder | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(
    quote.offer === "callback" && quote.callback_request_id !== null,
  );

  async function buy(): Promise<void> {
    if (quote.offer !== "order") return;
    setBusy(true);
    const res = await buyManagedHiringAction({
      jobPostingId,
      expectedPriceInr: quote.price.price_inr,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!res.ok) {
      setBusy(false);
      setError(res.error);
      return;
    }
    const paid = await openCheckout({
      orderId: res.checkout.provider_order_id,
      keyId: res.checkout.key_id,
      amount: res.checkout.amount,
      currency: res.checkout.currency,
      name: "BadaBhai",
      description: "Managed Hiring",
    });
    if (paid.outcome === "success") {
      await verifyPaymentAction({
        orderId: paid.orderId,
        paymentId: paid.paymentId,
        signature: paid.signature,
      });
    }
    setBusy(false);
    router.refresh();
  }

  async function call(): Promise<void> {
    setBusy(true);
    const res = await requestCallbackAction(jobPostingId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAsked(true);
    router.refresh();
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Managed Hiring</h2>
      </div>
      <div className="panel__body">
        {quote.offer === "order" ? (
          <>
            <p className="panel__sub">
              <span className="bb-mono">{inr(quote.price.total_paise)}</span> ({inr(quote.price.taxable_paise)} plus
              GST {inr(quote.price.gst_paise)}) · at least {quote.target_count} phone-confirmed
              interested workers in {quote.working_days} working days, free extension to day{" "}
              {quote.extension_days}.
            </p>
            {order ? (
              <div className="kv">
                <p className="panel__sub">
                  Status: <strong>{order.status.replace(/_/g, " ")}</strong> ·{" "}
                  {order.confirmed_count} of {order.target_count} confirmed
                  {order.due_at ? ` · ${deadline(order.due_at)}` : ""}
                </p>
                {order.checkout ? (
                  <Button variant="primary" onClick={() => void buy()} disabled={busy}>
                    Finish payment
                  </Button>
                ) : null}
                {order.workers.length > 0 ? (
                  <ul className="panel__sub">
                    {order.workers.map((w) => (
                      <li key={w.worker_id}>
                        <span className="bb-mono">{w.worker_id.slice(0, 8)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <Button variant="primary" onClick={() => void buy()} disabled={busy} loading={busy}>
                Buy Managed Hiring
              </Button>
            )}
          </>
        ) : (
          <>
            {asked ? (
              <p className="panel__sub">We will call you.</p>
            ) : (
              <Button variant="primary" onClick={() => void call()} disabled={busy} loading={busy}>
                Request a call
              </Button>
            )}
          </>
        )}
        <p className="panel__sub">{quote.terms}</p>
        {error ? <p className="applicant__error">{error}</p> : null}
      </div>
    </section>
  );
}

function deadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `by the end of ${new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10)}`;
}
