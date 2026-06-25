"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upgradeCapacityAction } from "./actions";

/**
 * Client capacity-tier picker (the QUOTA-PAUSE "Stream A" upgrade leg). Tiers come from
 * CONFIG (passed in as props from the server page) — never hardcoded here. Price + the
 * vacancy allowance are DISPLAY-only; selecting sends ONLY the tier CODE to the (mock-money)
 * Server Action (XT5: the client NEVER sends a price/amount/quota). There is no payment
 * form, no card field, no real money — the backend mock-upgrades (real_call:false).
 *
 * Mirrors {@link import("../credits/credits-panel").CreditsPanel}: a window.confirm step
 * precedes the buy (mock-money copy), the buttons are disabled while submitting, and the
 * result region is aria-live='polite'.
 */
export type CapacityTier = { code: string; priceInr: number; maxActiveVacancies: number };

export function CapacityPanel({ tiers }: { tiers: CapacityTier[] }) {
  const router = useRouter();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

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
        setMessage(`Capacity upgraded — ${res.resumedCount} posting(s) resumed.`);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <>
      {tiers.length === 0 ? (
        <div className="empty">No capacity tiers are currently offered.</div>
      ) : (
        <div className="cards">
          {tiers.map((t) => (
            <div className="card" key={t.code}>
              <h3>{t.code.replace(/_/g, " ")}</h3>
              <div className="big">₹{t.priceInr.toLocaleString("en-IN")}</div>
              <p>{t.maxActiveVacancies} concurrent vacancies</p>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button
                  className="btn"
                  type="button"
                  disabled={pendingCode !== null}
                  onClick={() => onUpgrade(t)}
                >
                  {pendingCode === t.code ? "Upgrading…" : "Upgrade (mock)"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div aria-live="polite">
        {message ? <p className="note">{message}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </>
  );
}
