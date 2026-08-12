import Link from "next/link";
import type { ReactNode } from "react";
import { requirePayer } from "../../lib/auth";
import { getOrgRole } from "../../lib/auth/org-roles";
import { getCredits } from "../../lib/payer-api";
import { BadaBhaiLogo, Badge, ThemeToggle } from "../../components/ds";
import { AccountMenu } from "./account-menu";
import { AppShell } from "./app-shell";
import { navSections } from "./nav-model";
import { PortalBreadcrumb } from "./portal-breadcrumb";

export const dynamic = "force-dynamic";

/**
 * Authenticated portal shell (IA-1 — rebuilt from a wrapping top nav onto a levelled left
 * rail + sticky header).
 *
 * ONLY THE VISUAL AND NAVIGATIONAL LAYER CHANGED. The authorization model is byte-for-byte
 * the one that was here before, and is still ROLE-AWARE on two dimensions:
 *  - ACCOUNT role (`session.role` employer|agent) → product LABELING (Employers vs Agencies)
 *    and which route group is offered;
 *  - ORG role (`getOrgRole` owner|recruiter) → which Owner-only nav AFFORDANCES show.
 *
 * `requirePayer()` resolves the SERVER-HELD signed session (or redirects to /login), so
 * every page here is guaranteed a payer principal — and every data call binds to THAT
 * payer's id (XB-A).
 *
 * AUTHORIZATION IS THE SERVER GATE, NEVER THE NAV. The rail only hides links a member
 * cannot use, as an affordance — a Recruiter who navigates straight to /credits or /team
 * still hits `requireOwner()` and gets a NEUTRAL 404. Agency-only authz is `requireAgent()`
 * inside that route group, not the missing link. The opaque payer is rendered only as
 * coarse role badges.
 *
 * The balance chip is a courtesy read; it FAILS SOFT (hidden on a read error) so a
 * transient credits outage never blanks the whole shell.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  // Org-role is for AFFORDANCES only (which links to show). The gate is the decision
  // (requireOwner). See nav-model.ts for why this is false in staging/production today.
  const isOwner = getOrgRole(session) === "owner";

  const sections = navSections({ isAgency, isOwner });

  let balance: number | null = null;
  try {
    balance = (await getCredits()).balance;
  } catch {
    balance = null; // fail soft — the shell still renders without the chip
  }

  return (
    <AppShell
      sections={sections}
      brand={
        /* Brand lockup → Dashboard (the portal home). Authorization is unchanged: the
           target route is itself behind requirePayer(). */
        <Link
          className="pshell__brandlink"
          href="/dashboard"
          aria-label="BadaBhai — go to dashboard"
        >
          <BadaBhaiLogo variant="mark" size={30} />
          <span className="pshell__brandtext">
            <span className="pshell__brandname">BadaBhai</span>
            <span className="pshell__brandrole">
              for {isAgency ? "Agencies" : "Employers"}
            </span>
          </span>
        </Link>
      }
      header={
        <>
          <PortalBreadcrumb sections={sections} />
          <div className="pshell__headeractions">
            {balance != null ? (
              /* The wallet position is the number a payer checks most often and the one
                 that blocks the core loop when it hits zero, so it is a LINK to the wallet
                 rather than a decorative chip. Recruiters have no /credits route, so it
                 stays display-only for them. */
              isOwner ? (
                <Link className="pshell__balance" href="/credits">
                  <i className="ph ph-lock-key-open" aria-hidden="true" />
                  <span className="ui-num pshell__balancenum">{balance}</span>
                  <span className="pshell__balancelabel">unlocks</span>
                </Link>
              ) : (
                <span className="pshell__balance pshell__balance--static">
                  <i className="ph ph-lock-key-open" aria-hidden="true" />
                  <span className="ui-num pshell__balancenum">{balance}</span>
                  <span className="pshell__balancelabel">unlocks</span>
                </span>
              )
            ) : null}
            {/* Light/dark theme — a per-user display preference, role-agnostic. */}
            <ThemeToggle />
            {/* Sign-out lives INSIDE this menu. The shell used to carry a second,
                standalone sign-out icon beside it; two controls for one destructive action
                is a duplicate affordance, and the menu is where a user looks for it. */}
            <AccountMenu
              orgName={session.displayLabel}
              email={session.email}
              phoneLast4={session.phoneLast4}
              role={session.role}
              status={session.status}
            />
          </div>
        </>
      }
      footer={
        <div className="pshell__whoami">
          <Badge tone={isAgency ? "info" : "neutral"} upper>
            {isAgency ? "Agency" : "Company"}
          </Badge>
        </div>
      }
    >
      {children}
    </AppShell>
  );
}
