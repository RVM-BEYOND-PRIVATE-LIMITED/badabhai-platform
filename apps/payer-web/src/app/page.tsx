"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getIdentity, type PayerIdentity } from "../lib/session";

/**
 * Entry page. Client-only (the session lives in the browser): shows a sign-in CTA
 * when there is no stored token, or a link straight to the dashboard when there is.
 */
export default function HomePage() {
  const [identity, setIdentity] = useState<PayerIdentity | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setIdentity(getIdentity());
    setReady(true);
  }, []);

  if (!ready) {
    return <p className="page-sub">Loading…</p>;
  }

  return (
    <>
      <h1 className="page-title">
        Hire from BadaBhai <span className="badge">Phase 1</span>
      </h1>
      <p className="page-sub">
        Self-serve access for Companies and Agencies. Sign in to view your credit balance and the
        contacts you have unlocked.
      </p>

      {identity ? (
        <div className="card">
          <h3>You are signed in</h3>
          <p className="page-sub">
            {identity.role === "agent" ? "Agency" : "Company"} · {identity.email}
          </p>
          <Link className="btn" href="/dashboard">
            Go to dashboard →
          </Link>
        </div>
      ) : (
        <div className="card">
          <h3>Get started</h3>
          <div className="btn-row">
            <Link className="btn" href="/auth?mode=signup">
              Create an account
            </Link>
            <Link className="btn btn-secondary" href="/auth?mode=login">
              I already have an account
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
