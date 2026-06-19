"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CreditPack } from "../../../lib/contracts";
import { topUpAction } from "./actions";

/**
 * Client credit-pack picker. Packs come from CONFIG (passed in as props from the
 * server page) — never hardcoded here. Top-up calls the MOCK Server Action; there
 * is no payment form, no card field, no real money (XT5 / E-R2).
 */
export function CreditsPanel({ packs, balance }: { packs: CreditPack[]; balance: number }) {
  const router = useRouter();
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function onBuy(code: string) {
    setError(null);
    setMessage(null);
    setPendingCode(code);
    startTransition(async () => {
      const res = await topUpAction({ packCode: code });
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
      <p className="page-sub">
        <span className="badge">Current balance: {balance}</span>
      </p>

      {packs.length === 0 ? (
        <div className="empty">No credit packs are currently offered.</div>
      ) : (
        <div className="cards">
          {packs.map((p) => (
            <div className="card" key={p.code}>
              <h3>{p.code.replace(/_/g, " ")}</h3>
              <div className="big">₹{p.priceInr.toLocaleString("en-IN")}</div>
              <p>{p.credits} unlock credits</p>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button
                  className="btn"
                  type="button"
                  disabled={pendingCode !== null}
                  onClick={() => onBuy(p.code)}
                >
                  {pendingCode === p.code ? "Adding…" : "Buy (mock)"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {message ? <p className="note">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );
}
