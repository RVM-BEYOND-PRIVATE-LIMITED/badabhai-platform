import Link from "next/link";
import type { ReactNode } from "react";
import { requirePayer } from "../../lib/auth";
import { getOrgRole } from "../../lib/auth/org-roles";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";

/**
 * Authenticated portal shell, ROLE-AWARE on TWO dimensions:
 *  - ACCOUNT role (`session.role` employer|agent) → product LABELING (company vs agency);
 *  - ORG role (`getOrgRole` owner|recruiter) → which Owner-only nav AFFORDANCES show.
 *
 * `requirePayer()` resolves the SERVER-HELD signed session (or redirects to /login), so every
 * page here is guaranteed a payer principal — and every data call binds to THAT payer's id (XB-A).
 * The DEMAND loop (post → browse masked → unlock → contact) is shared by every member; the
 * Owner-only surfaces are billing/wallet (Credits) and user management (Team).
 *
 * AUTHORIZATION IS THE SERVER GATE, NEVER THE NAV. The nav only hides links a member can't use
 * as an affordance — a Recruiter who navigates straight to /credits or /team still hits
 * `requireOwner()` and gets a NEUTRAL 404. Likewise agency-only authz is `requireAgent()` inside
 * that route group, not the missing link. The opaque payer_id / org role claim is never rendered
 * as anything but the coarse affordance badge below.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  // Org-role is for AFFORDANCES only (which links to show). The gate is the decision (§requireOwner).
  const isOwner = getOrgRole(session) === "owner";

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
          {/* Owner-only affordances (billing/wallet + user management). The SERVER gate
              (requireOwner → neutral 404) — not this conditional — is the authorization. */}
          {isOwner ? <Link href="/credits">Credits</Link> : null}
          {isOwner ? <Link href="/team">Team</Link> : null}
          {isAgency ? <Link href="/agency/dashboard">Agency dashboard</Link> : null}
          {isAgency ? <Link href="/agency/referrals">Referrals &amp; payouts</Link> : null}
        </nav>
        <div className="session-chip">
          <span>
            {session.displayLabel} ·{" "}
            <span className="badge">{isAgency ? "agency" : "employer"}</span>{" "}
            <span className="badge">{isOwner ? "owner" : "recruiter"}</span>
          </span>
          <LogoutButton />
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
