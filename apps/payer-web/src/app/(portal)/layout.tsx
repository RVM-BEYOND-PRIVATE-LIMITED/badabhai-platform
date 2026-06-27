import Link from "next/link";
import type { ReactNode } from "react";
import { requirePayer } from "../../lib/auth";
import { getOrgRole } from "../../lib/auth/org-roles";
import { getCredits } from "../../lib/payer-api";
import { BadaBhaiLogo, Badge, ThemeToggle } from "../../components/ds";
import { AccountMenu } from "./account-menu";
import { LogoutButton } from "./logout-button";
import { PortalNav } from "./portal-nav";

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
        {/* Brand lockup → Dashboard (the portal home). Authorization is unchanged: the
            target route is itself behind requirePayer(). */}
        <Link className="portal-top__brand" href="/dashboard" aria-label="BadaBhai — go to dashboard">
          <BadaBhaiLogo size={28} wavy />
          <span className="portal-top__role">for {isAgency ? "Agencies" : "Employers"}</span>
        </Link>

        {/* Role-aware primary nav (links + which ones render decided HERE; the active-route
            highlight is added client-side). The SERVER gate (requireOwner/requireAgent) — not
            the nav — is the authorization. */}
        <PortalNav isAgency={isAgency} isOwner={isOwner} />

        <div className="portal-top__right">
          {balance != null ? (
            <Badge tone="success" icon="lock-key-open">
              <span className="bb-mono">{balance}</span> unlocks
            </Badge>
          ) : null}
          {/* Light/dark theme — a per-user display preference, role-agnostic. Visible on
              every authenticated page, next to the account menu. */}
          <ThemeToggle />
          <AccountMenu
            orgName={session.displayLabel}
            email={session.email}
            phoneLast4={session.phoneLast4}
            role={session.role}
            status={session.status}
          />
          <LogoutButton />
        </div>
      </header>

      <main className="portal-main">{children}</main>
    </div>
  );
}
