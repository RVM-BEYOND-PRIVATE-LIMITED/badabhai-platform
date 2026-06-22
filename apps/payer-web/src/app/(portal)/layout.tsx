import Link from "next/link";
import type { ReactNode } from "react";
import { requirePayer } from "../../lib/auth";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";

/**
 * Authenticated portal shell, ROLE-AWARE (agency DEMAND extension).
 *
 * `requirePayer()` resolves the SERVER-HELD signed session (or redirects to /login),
 * so every page here is guaranteed a payer principal — and every data call binds to
 * THAT payer's id (XB-A). The DEMAND loop (post → browse masked → unlock → credits)
 * is SHARED by both roles; only the shell LABELING differs by `session.role`:
 *  - an `agent` (agency) sees agency-labeled DEMAND sections + a static, parked
 *    "Referrals & payouts" nav item (SUPPLY is PARKED — that page builds nothing);
 *  - an `employer` (company) sees the company labeling and NO agency-only nav.
 *
 * The role here drives LABELS only. The actual agency-only authz is SERVER-enforced
 * inside the agency route group (`requireAgent()` → neutral 404 for an employer),
 * never by hiding a link. The opaque payer_id is never rendered.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await requirePayer();
  const isAgency = session.role === "agent";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          {isAgency ? "BadaBhai for Agencies" : "BadaBhai for Employers"}
          <small>{isAgency ? "Agency hiring desk" : "Self-serve hiring"} · staging (mock)</small>
        </div>
        <nav className="topnav">
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/postings/new">{isAgency ? "Post a vacancy" : "Post a job"}</Link>
          <Link href="/postings">{isAgency ? "Manage vacancies" : "Manage postings"}</Link>
          <Link href="/capacity">Capacity</Link>
          <Link href="/credits">Credits</Link>
          {isAgency ? <Link href="/agency/dashboard">Agency dashboard</Link> : null}
          {isAgency ? <Link href="/agency/referrals">Referrals &amp; payouts</Link> : null}
        </nav>
        <div className="session-chip">
          <span>
            {session.displayLabel} ·{" "}
            <span className="badge">{isAgency ? "agency" : "employer"}</span>
          </span>
          <LogoutButton />
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
