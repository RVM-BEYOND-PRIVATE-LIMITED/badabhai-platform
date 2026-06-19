import Link from "next/link";
import { getDashboard } from "../../../lib/payer-api";
import type { Dashboard } from "../../../lib/contracts";

export const dynamic = "force-dynamic";

/**
 * Payer dashboard (ADR-0019 Phase 1). Shows the payer's OWN postings, credit
 * balance, and unlock history — payer-scoped only (XB-A: the data seam binds to
 * the server-held session id). No raw worker/payer PII anywhere.
 */
export default async function DashboardPage() {
  let data: Dashboard | null = null;
  let error: string | null = null;
  try {
    data = await getDashboard();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error) {
    return (
      <>
        <h1 className="page-title">Dashboard</h1>
        <p className="page-sub">
          <span className="badge badge-warn">Service unavailable</span> We couldn&rsquo;t load
          your account right now. Please retry shortly.
        </p>
      </>
    );
  }
  if (!data) return null;

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Your postings, credits, and unlock history.</p>

      <div className="cards">
        <div className="card">
          <h3>Credit balance</h3>
          <div className="big">{data.credits.balance}</div>
          <p>
            <Link href="/credits">Top up credits →</Link>
          </p>
        </div>
        <div className="card">
          <h3>Open postings</h3>
          <div className="big">{data.postings.filter((p) => p.status === "open").length}</div>
          <p>
            <Link href="/postings/new">Post a job →</Link>
          </p>
        </div>
        <div className="card">
          <h3>Contacts unlocked</h3>
          <div className="big">{data.unlocks.length}</div>
          <p>1 credit per contact</p>
        </div>
      </div>

      <section className="section">
        <h2>Your job postings</h2>
        {data.postings.length === 0 ? (
          <div className="empty">
            You haven&rsquo;t posted a job yet. <Link href="/postings/new">Post your first job</Link>{" "}
            — free through launch.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Location</th>
                <th>Vacancies</th>
                <th>Status</th>
                <th>Applicants</th>
                <th>Posted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.postings.map((p) => (
                <tr key={p.id}>
                  <td>{p.roleTitle}</td>
                  <td>{p.locationLabel ?? "—"}</td>
                  <td>{p.vacancyBand}</td>
                  <td>
                    <span className={p.status === "open" ? "badge badge-ok" : "badge"}>
                      {p.status}
                    </span>
                  </td>
                  <td>{p.applicantCount}</td>
                  <td className="mono">{new Date(p.createdAt).toISOString().slice(0, 10)}</td>
                  <td>
                    <Link href={`/postings/${p.id}/applicants`}>View applicants →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <h2>Unlock history</h2>
        {data.unlocks.length === 0 ? (
          <div className="empty">
            No contacts unlocked yet. Open a posting&rsquo;s applicants to unlock a candidate&rsquo;s
            routed contact.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Candidate (opaque id)</th>
                <th>Status</th>
                <th>Unlocked</th>
                <th>Access until</th>
              </tr>
            </thead>
            <tbody>
              {data.unlocks.map((u) => (
                <tr key={u.unlockId}>
                  <td className="mono">{u.workerId}</td>
                  <td>
                    <span className={u.status === "granted" ? "badge badge-ok" : "badge"}>
                      {u.status}
                    </span>
                  </td>
                  <td className="mono">{new Date(u.createdAt).toISOString().slice(0, 10)}</td>
                  <td className="mono">{new Date(u.expiresAt).toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
