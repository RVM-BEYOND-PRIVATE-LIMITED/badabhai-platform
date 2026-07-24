import { listPendingAgencyKyc, type AgencyKycPendingRow } from "@/lib/api";
import { maskLast4 } from "@/lib/agency-kyc-view";
import { AgencyKycRowActions } from "./agency-kyc-actions";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/** Format an ISO timestamp for display, falling back to the raw string. */
function fmt(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/**
 * Ops Agency-KYC review queue (ADR-0022 Amendment 2).
 *
 * Lists PENDING agency KYC submissions for a human operator to Verify (flip to
 * `verified` — the gate the agency payout flow requires) or Reject with a bounded
 * reason code. Both actions are behind the API's `InternalServiceGuard`; the shared
 * secret is attached server-side and never reaches the browser.
 *
 * MASKED BY DESIGN: the API returns only the last-4 of PAN/bank — there is no
 * endpoint that returns the full PAN/bank, and this page never requests or renders
 * one. "Verify" is a MANUAL ops review — there is no automated registry check.
 */
export default async function AgencyKycPage() {
  let rows: AgencyKycPendingRow[] | null = null;
  let error: string | null = null;
  try {
    rows = await listPendingAgencyKyc();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <h1 className="page-title">Agency KYC</h1>
      <p className="page-sub">
        Pending agency KYC submissions awaiting manual review (ADR-0022). Verifying
        flips the agency to <span className="mono">verified</span> — the gate the
        agency payout flow requires.
      </p>
      <p className="note">
        <strong>Manual review — no automated registry check.</strong> &ldquo;Verify&rdquo;
        records an operator&rsquo;s decision; it does not validate the PAN/bank against
        any external registry. Only the last-4 of PAN/bank is ever shown — the full
        values are never returned by the API.
      </p>

      {error ? (
        <p className="page-sub">
          <span className="badge">API unavailable</span> {error}
        </p>
      ) : !rows || rows.length === 0 ? (
        <div className="empty">
          No pending agency KYC submissions. The queue is clear.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Payer ID</th>
              <th>Submitted</th>
              <th>PAN</th>
              <th>Bank</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.payerId}>
                <td className="mono">{r.payerId}</td>
                <td>{fmt(r.submittedAt)}</td>
                <td className="mono">{maskLast4(r.panLast4)}</td>
                <td className="mono">{maskLast4(r.bankLast4)}</td>
                <td>
                  <AgencyKycRowActions payerId={r.payerId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="footer">
        Masked surface: only last-4 of PAN/bank is ever returned or shown. Verify /
        Reject are behind the InternalServiceGuard — the shared secret stays
        server-side.
      </div>
    </>
  );
}
