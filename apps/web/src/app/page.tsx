import Link from "next/link";

export default function DashboardPage() {
  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">
        Internal ops console for BadaBhai worker profiling. <span className="badge">Phase 1</span>
      </p>

      <div className="cards">
        <Link className="card" href="/ops/workers">
          <h3>Workers →</h3>
          <p>Browse profiled workers and their generated profiles.</p>
        </Link>
        <Link className="card" href="/ops/applicants">
          <h3>Applicants →</h3>
          <p>Read-only swipe-to-apply decisions, by job or by worker.</p>
        </Link>
        <Link className="card" href="/ops/events">
          <h3>Events →</h3>
          <p>Read-only stream of the event-first audit log.</p>
        </Link>
        <Link className="card" href="/ops/ai-jobs">
          <h3>AI Jobs →</h3>
          <p>Status of pseudonymization, extraction, and resume jobs.</p>
        </Link>
      </div>

      <div className="footer">
        <strong>In Phase 1:</strong> worker profiling + profile generation only. Employer posting,
        unlock, payments, payouts, boosts, ranking/matching, and production legal flows are
        intentionally out of scope.
      </div>
    </>
  );
}
