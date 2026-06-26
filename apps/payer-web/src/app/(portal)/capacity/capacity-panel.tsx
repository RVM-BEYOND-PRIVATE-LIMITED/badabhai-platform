"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Toast } from "../../../components/ds";
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
 * tabular and a DS Button wired to the EXISTING live POST /payer/capacity action. A
 * window.confirm step precedes the buy (mock-money copy), the buttons disable while
 * submitting, and the result region is aria-live='polite' (DS Toast).
 */
export type CapacityTier = { code: string; priceInr: number; maxActiveVacancies: number };

export function CapacityPanel({ tiers }: { tiers: CapacityTier[] }) {
  const router = useRouter();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The largest concurrent allowance is the "most capacity" tile — config-derived, never a
  // literal. Used only to flag the tile; the price/allowance themselves always come from config.
  const topTierCode =
    tiers.length > 0
      ? tiers.reduce((a, b) => (a.maxActiveVacancies >= b.maxActiveVacancies ? a : b)).code
      : null;

  function onUpgrade(tier: CapacityTier) {
    // Confirm step. Money is MOCK — the copy says so; no real payment is taken.
    const ok = window.confirm(
      `Upgrade to the ${tier.maxActiveVacancies}-vacancy tier for ₹${tier.priceInr.toLocaleString("en-IN")}? ` +
        "This is a mock upgrade — no real payment is taken.",
    );
    if (!ok) return;
    setError(null);
    setMessage(null);
    setPendingCode(tier.code);
    startTransition(async () => {
      // Send ONLY the tier CODE (XT5 / XB-A) — never the displayed price/allowance.
      const res = await upgradeCapacityAction({ tier: tier.code });
      setPendingCode(null);
      if (res.ok) {
        setMessage(`Capacity recorded — ${res.resumedCount} posting(s) resumed.`);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <>
      {tiers.length === 0 ? (
        <Card variant="flat" className="capacity-empty">
          No capacity tiers are currently offered.
        </Card>
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
              <div className="capacity-tier__price bb-mono">
                ₹{t.priceInr.toLocaleString("en-IN")}
              </div>
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
    </>
  );
}
