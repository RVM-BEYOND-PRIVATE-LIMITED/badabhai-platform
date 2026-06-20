"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  getOwnCredits,
  getOwnUnlocks,
  logout,
  type CreditsResponse,
  type UnlockProjection,
} from "../../lib/api";
import { clearSession, getIdentity, type PayerIdentity } from "../../lib/session";

/**
 * Authenticated payer dashboard. Renders ONLY the signed-in payer's OWN data:
 *   - credit balance  (GET /payers/:id/credits — :id is the SESSION payer's id)
 *   - own unlocks      (GET /unlocks)
 *
 * The `:payerId` path comes from the stored session identity, NEVER from a user
 * input field — there is no way to read another tenant's data from this UI, and
 * the server (PayerAuthGuard + assertPayerOwns) is the real isolation boundary.
 */
export default function DashboardPage() {
  const router = useRouter();
  const [identity, setIdentity] = useState<PayerIdentity | null>(null);
  const [credits, setCredits] = useState<CreditsResponse | null>(null);
  const [unlocks, setUnlocks] = useState<UnlockProjection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (id: PayerIdentity) => {
      setLoading(true);
      setError(null);
      try {
        const [c, u] = await Promise.all([getOwnCredits(id.payerId), getOwnUnlocks()]);
        setCredits(c);
        setUnlocks(u.unlocks);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace("/auth?mode=login");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load your data.");
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    const id = getIdentity();
    if (!id) {
      router.replace("/auth?mode=login");
      return;
    }
    setIdentity(id);
    void load(id);
  }, [router, load]);

  async function onLogout() {
    try {
      await logout();
    } catch {
      // Best-effort server revoke; we clear the local session regardless.
    }
    clearSession();
    router.replace("/");
  }

  if (!identity) return <p className="page-sub">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">
        {identity.role === "agent" ? "Agency" : "Company"} account · {identity.email}
      </p>

      {error && (
        <p className="error-text" role="alert">
          <span className="badge">API unavailable</span> {error}
        </p>
      )}

      <div className="card">
        <h3>Credit balance</h3>
        {loading ? (
          <p className="page-sub" style={{ margin: 0 }}>
            Loading…
          </p>
        ) : credits ? (
          <>
            <div className="balance">{credits.balance}</div>
            <p className="page-sub" style={{ margin: "4px 0 0" }}>
              credits available for contact unlocks
            </p>
          </>
        ) : (
          <p className="page-sub" style={{ margin: 0 }}>
            Balance unavailable.
          </p>
        )}
        <p className="page-sub" style={{ margin: "12px 0 0", fontSize: 12 }}>
          Credit packs are a mock action in Phase 1 — no real payment is taken
          (PAYMENTS_ENABLE_REAL=false).
        </p>
      </div>

      <div className="card">
        <h3>Your unlocks</h3>
        {loading ? (
          <p className="page-sub" style={{ margin: 0 }}>
            Loading…
          </p>
        ) : !unlocks || unlocks.length === 0 ? (
          <div className="empty">No contacts unlocked yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Unlock</th>
                <th>Status</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {unlocks.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.id}</td>
                  <td>{u.status}</td>
                  <td>{u.expires_at ? new Date(u.expires_at).toISOString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="page-sub" style={{ margin: "12px 0 0", fontSize: 12 }}>
          Projections only — never a worker&apos;s phone, name, or routing handle.
        </p>
      </div>

      <div className="btn-row">
        <button className="btn btn-secondary" type="button" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </>
  );
}
