"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CreditPack } from "../../../lib/contracts";
import { Badge, Button, Card, Toast } from "../../../components/ds";
import { formatInr } from "../../../lib/format";
import { topUpAction } from "./actions";

/**
 * Client credit-pack picker (DS1.4 re-skin) — pack tiles as DS Cards. Packs come from
 * CONFIG (passed in as props from the server page) — never hardcoded here. The per-credit
 * "best value" pack is derived from the config prices (not a literal). Top-up calls the
 * (mock-money) Server Action; there is no payment form, no card field, no real money
 * (XT5 / E-R2). The backend mock-purchases (real_call:false) — there is NO Razorpay.
 *
 * HARDENING (C6): a confirm step precedes the buy, and the result region is aria-live.
 */
export function CreditsPanel({ packs }: { packs: CreditPack[] }) {
  const router = useRouter();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The best ₹/credit pack — config-derived (the larger packs carry the real discount), never a
  // hardcoded "1000". Used only to flag the tile; the price itself always comes from the catalog.
  const bestValueCode =
    packs.length > 0
      ? packs.reduce((a, b) => (a.priceInr / a.credits <= b.priceInr / b.credits ? a : b)).code
      : null;

  function onBuy(pack: CreditPack) {
    // Confirm step (C6). Money is MOCK — the copy says so; no real payment is taken.
    const ok = window.confirm(
      `Add ${pack.credits} credits for ${formatInr(pack.priceInr)}? ` +
        "This is a mock top-up — no real payment is taken.",
    );
    if (!ok) return;
    setError(null);
    setMessage(null);
    setPendingCode(pack.code);
    startTransition(async () => {
      const res = await topUpAction({ packCode: pack.code });
      setPendingCode(null);
      if (res.ok) {
        setMessage(`Added ${res.creditsAdded} credits. New balance: ${res.balance}.`);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <>
      {packs.length === 0 ? (
        <Card variant="flat" className="credits-empty">
          No credit packs are currently offered.
        </Card>
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
                {pendingCode === p.code ? "Adding…" : "Buy (mock)"}
              </Button>
            </Card>
          ))}
        </div>
      )}

      <div aria-live="polite" className="credits-result">
        {message ? <Toast tone="success">{message}</Toast> : null}
        {error ? <Toast tone="danger">{error}</Toast> : null}
      </div>
    </>
  );
}
