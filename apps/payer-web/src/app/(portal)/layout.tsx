import Link from "next/link";
import type { ReactNode } from "react";
import { requirePayer } from "../../lib/auth";
import { getOrgRole } from "../../lib/auth/org-roles";
import { getCredits } from "../../lib/payer-api";
import { BadaBhaiLogo, Badge } from "../../components/ds";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";

/**
 * Authenticated portal shell (DS0.3 — rebuilt onto the BadaBhai Design System chrome).
 * Only the VISUAL layer changed; the authorization model is untouched and ROLE-AWARE on
 * two dimensions:
 *  - ACCOUNT role (`session.role` employer|agent) → product LABELING (Employers vs Agencies);
 *  - ORG role (`getOrgRole` owner|recruiter) → which Owner-only nav AFFORDANCES show.
 *
 * `requirePayer()` resolves the SERVER-HELD signed session (or redirects to /login), so every
 * page here is guaranteed a payer principal — and every data call binds to THAT payer's id (XB-A).
 * The DEMAND loop (post → browse masked → unlock → contact) is shared by every member; the
 * Owner-only surfaces are billing/wallet (Credits) and user management (Team).
 *
 * AUTHORIZATION IS THE SERVER GATE, NEVER THE NAV. The nav only hides links a member can't use
 * as an affordance — a Recruiter who navigates straight to /credits or /team still hits
 * `requireOwner()` and gets a NEUTRAL 404. Agency-only authz is `requireAgent()` inside that route
 * group, not the missing link. The opaque payer is rendered only as coarse role badges.
 *
 * The balance chip is a courtesy read; it FAILS SOFT (hidden on a read error) so a transient
 * credits outage never blanks the whole shell.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  // Org-role is for AFFORDANCES only (which links to show). The gate is the decision (requireOwner).
  const isOwner = getOrgRole(session) === "owner";

  let balance: number | null = null;
  try {
    balance = (await getCredits()).balance;
  } catch {
    balance = null; // fail soft — the shell still renders without the chip
  }

  return (
    <div className="portal-shell">
      <header className="portal-top">
        <div className="portal-top__brand">
          <BadaBhaiLogo size={28} />
          <span className="portal-top__role">for {isAgency ? "Agencies" : "Employers"}</span>
        </div>

        <nav className="portal-nav" aria-label="Primary">
          <Link className="portal-nav__link" href="/dashboard">
            Dashboard
          </Link>
          <Link className="portal-nav__link" href="/postings/new">
            {isAgency ? "Post a vacancy" : "Post a job"}
          </Link>
          <Link className="portal-nav__link" href="/postings">
            {isAgency ? "Manage vacancies" : "Manage postings"}
          </Link>
          <Link className="portal-nav__link" href="/capacity">
            Capacity
          </Link>
          {/* Owner-only affordances (billing/wallet + user management). The SERVER gate
              (requireOwner → neutral 404) — not this conditional — is the authorization. */}
          {isOwner ? (
            <Link className="portal-nav__link" href="/credits">
              Credits
            </Link>
          ) : null}
          {isOwner ? (
            <Link className="portal-nav__link" href="/team">
              Team
            </Link>
          ) : null}
          {isAgency ? (
            <Link className="portal-nav__link" href="/agency/dashboard">
              Agency dashboard
            </Link>
          ) : null}
          {isAgency ? (
            <Link className="portal-nav__link" href="/agency/referrals">
              Referrals &amp; payouts
            </Link>
          ) : null}
        </nav>

        <div className="portal-top__right">
          {balance != null ? (
            <Badge tone="success" icon="lock-key-open">
              <span className="bb-mono">{balance}</span> unlocks
            </Badge>
          ) : null}
          <span className="portal-acct">
            <span className="portal-acct__label">{session.displayLabel}</span>
            <Badge tone="neutral">{isAgency ? "agency" : "employer"}</Badge>
            <Badge tone={isOwner ? "brand" : "neutral"}>{isOwner ? "owner" : "recruiter"}</Badge>
          </span>
          <LogoutButton />
        </div>
      </header>

      <main className="portal-main">{children}</main>
    </div>
  );
}
