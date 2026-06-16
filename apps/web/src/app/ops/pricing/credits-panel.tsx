"use client";

import { useState } from "react";
import { isUuid, type CreditPackOption } from "@/lib/pricing-view";
import { fetchPayerCreditsAction, topUpCreditsAction } from "./actions";

/**
 * Payer credit balance + MOCK top-up panel (ADR-0010 / ADR-0013).
 *
 * SECURITY: this component runs in the BROWSER and therefore never sees the
 * `INTERNAL_SERVICE_TOKEN`. It calls Server Actions (`actions.ts`) that attach the
 * secret server-side and return only PII-free, already-mapped state. The balance
 * is the payer's OWN — the one legitimately-knowable signal (not a worker oracle).
 *
 * NO-LOG: nothing here logs the payer id, the balance, or the top-up result. The
 * top-up is explicitly labelled MOCK — there is no real money in alpha.
 */
export function CreditsPanel({ packs }: { packs: CreditPackOption[] }) {
  const [payerId, setPayerId] = useState("");
  const [activePayer, setActivePayer] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [packCode, setPackCode] = useState(packs[0]?.code ?? "");
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpError, setTopUpError] = useState<string | null>(null);
  const [topUpMsg, setTopUpMsg] = useState<string | null>(null);

  const payerValid = isUuid(payerId);

  async function onLoad(e: React.FormEvent) {
    e.preventDefault();
    setLoadError(null);
    setTopUpError(null);
    setTopUpMsg(null);
    setBalance(null);
    if (!payerValid) {
      setLoadError("Enter a valid payer id (UUID).");
      return;
    }
    setLoadBusy(true);
    const res = await fetchPayerCreditsAction(payerId.trim());
    setLoadBusy(false);
    if (res.ok) {
      setActivePayer(payerId.trim());
      setBalance(res.balance);
    } else {
      setActivePayer(null);
      setLoadError(res.error);
    }
  }

  async function onTopUp() {
    if (!activePayer) return;
    if (!packCode) {
      setTopUpError("Pick a credit pack.");
      return;
    }
    setTopUpBusy(true);
    setTopUpError(null);
    setTopUpMsg(null);
    const res = await topUpCreditsAction({ payerId: activePayer, packCode });
    setTopUpBusy(false);
    if (res.ok) {
      setBalance(res.balance);
      setTopUpMsg(
        `MOCK top-up: +${res.credits} credits (${res.packCode}). New balance ${res.balance}.`,
      );
    } else {
      setTopUpError(res.error);
    }
  }

  return (
    <div className="form" style={{ maxWidth: 640 }}>
      <p className="note">
        <strong>MOCK — no real money.</strong> This is an alpha credit top-up seam
        (TD34). Real Razorpay is a later human-gated stream. The balance shown is the
        payer&rsquo;s OWN — not a signal about any candidate.
      </p>

      <form onSubmit={onLoad} className="field">
        <label htmlFor="credits_payer_id">
          Payer id<span className="req">*</span>
        </label>
        <input
          id="credits_payer_id"
          className="input mono"
          placeholder="00000000-0000-4000-8000-000000000000"
          value={payerId}
          onChange={(e) => setPayerId(e.target.value)}
        />
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn" type="submit" disabled={loadBusy || !payerValid}>
            {loadBusy ? "Loading…" : "Load balance"}
          </button>
        </div>
        {loadError ? <p className="error-text">{loadError}</p> : null}
      </form>

      {activePayer && balance !== null ? (
        <>
          <p className="page-sub" style={{ margin: 0 }}>
            Payer <span className="mono">{activePayer}</span> ·{" "}
            <span className="badge">Balance: {balance}</span>
          </p>

          {packs.length === 0 ? (
            <p className="page-sub">
              The catalog defines no credit packs — nothing to top up.
            </p>
          ) : (
            <div className="field">
              <label htmlFor="pack_code">Credit pack</label>
              <select
                id="pack_code"
                className="select"
                value={packCode}
                onChange={(e) => setPackCode(e.target.value)}
              >
                {packs.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} — ₹{p.priceInr} / {p.credits} credits ({p.windowDays}
                    d)
                  </option>
                ))}
              </select>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button
                  className="btn"
                  type="button"
                  disabled={topUpBusy || !packCode}
                  onClick={onTopUp}
                >
                  {topUpBusy ? "Topping up…" : "MOCK top-up"}
                </button>
              </div>
              {topUpError ? <p className="error-text">{topUpError}</p> : null}
              {topUpMsg ? (
                <p className="page-sub" style={{ margin: 0 }}>
                  <span className="badge">{topUpMsg}</span>
                </p>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
