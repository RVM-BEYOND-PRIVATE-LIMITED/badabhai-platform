import Link from "next/link";

/**
 * Neutral 404 (ADR-0019 Phase 1) — matches the role-guard neutral style.
 *
 * Reached for an unknown route AND for a `notFound()` from the role/tenant guards
 * (e.g. an `employer` hitting an agency-only section, or a not-owned resource). It is
 * deliberately INDISTINGUISHABLE from "does not exist" — no "forbidden" oracle, no leak
 * that a gated section exists, no PII. A Server Component (no client state needed).
 */
export default function NotFound() {
  return (
    <div className="login-wrap">
      <div className="form" style={{ textAlign: "center" }}>
        <h1 className="page-title">Not found</h1>
        <p className="page-sub">
          This page doesn&rsquo;t exist, or isn&rsquo;t available to your account.
        </p>
        <div className="btn-row" style={{ justifyContent: "center" }}>
          <Link className="btn" href="/dashboard">
            Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
