import { getPaceAlerts, type PaceAlerts } from "@/lib/api";

// Live ops data — always fetched fresh from the API at request time.
export const dynamic = "force-dynamic";

/**
 * PACE — ops intervention surface (ADR-0021).
 *
 * Lists jobs whose deterministic supply-widening run (area → [gated] adjacent trade)
 * kept thin good-fit supply past the 6–24h window and therefore raised an OPS ALERT
 * for a human to step in. FACELESS: opaque `jobId` + the widen stage + the above-floor
 * supply count + timestamps only — never a worker, employer, or location (the API
 * returns none and this view never fetches or invents any).
 */
export default async function PaceAlertsPage() {
  let data: PaceAlerts | null = null;
  let error: string | null = null;
  try {
    data = await getPaceAlerts();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <>
      <h1 className="page-title">PACE · Ops alerts</h1>
      <p className="page-sub">
        Jobs whose supply-widening waves couldn&apos;t lift good-fit supply above the floor within
        the window — flagged for human intervention. Deterministic, no LLM, faceless.
      </p>
      <p className="note">
        PACE only ever <strong>adds</strong> candidates (widens the travel area, then — when a
        ratified adjacency map exists — related trades). An alert here means the automated levers
        were exhausted and supply is still thin.
      </p>

      {error ? (
        <p className="page-sub">
          <span className="badge">API unavailable</span> {error}
        </p>
      ) : !data || data.alerts.length === 0 ? (
        <div className="empty">No PACE ops alerts. Either supply is healthy or PACE is disabled.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Job ID</th>
              <th>Stage</th>
              <th>Supply (above-floor)</th>
              <th>Started</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.alerts.map((a) => (
              <tr key={a.jobId}>
                <td className="mono">{a.jobId}</td>
                <td>
                  <span className="badge">{a.stage}</span>
                </td>
                <td>{a.supplyCount}</td>
                <td>{new Date(a.startedAt).toLocaleString()}</td>
                <td>{new Date(a.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="footer">
        Faceless surface: opaque job ids + widen stage + supply counts + timestamps only. No
        worker/employer/location is returned by the API or shown here.
      </div>
    </>
  );
}
