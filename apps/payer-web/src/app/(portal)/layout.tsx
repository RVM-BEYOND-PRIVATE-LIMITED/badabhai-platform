import Link from "next/link";
import type { ReactNode } from "react";
import { requirePayer } from "../../lib/auth";
import { getOrgRole } from "../../lib/auth/org-roles";
import { agencyFlags } from "../../lib/config";
import { getCredits } from "../../lib/payer-api";
import { BadaBhaiLogo, Badge, ThemeToggle } from "../../components/ds";
import { NavPendingCue } from "../../components/nav-pending";
import { AccountMenu } from "./account-menu";
import { BalanceChip } from "./balance-chip";
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
 *  - ACCOUNT role (`session.role` employer|agent) → product LABELING (Company vs Agency)
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
 * The agency items follow the agency-portal flag their pages check (nav-model.ts), so a
 * switched-off agency surface leaves the rail rather than linking to 404s.
 *
 * The balance chip is a courtesy read; it FAILS SOFT (hidden on a read error) so a
 * transient credits outage never blanks the whole shell. It is the ONE place the shell shows
 * the balance, in "credits" (the unit every billing surface uses) with the wallet icon.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await requirePayer();
  const isAgency = session.role === "agent";
  // Org-role is for AFFORDANCES only (which links to show). The gate is the decision
  // (requireOwner). See nav-model.ts for why this is false in staging/production today.
  const isOwner = getOrgRole(session) === "owner";

  const sections = navSections({
    isAgency,
    isOwner,
    agencyPortalEnabled: agencyFlags().agencyPortalEnabled,
  });

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
           target route is itself behind requirePayer(). The rail is a Shift Blue band, so
           the lockup takes its on-ink form; the persona is its caption. */
        <Link
          className="pshell__brandlink"
          href="/dashboard"
          aria-label="BadaBhai — go to dashboard"
        >
          <BadaBhaiLogo
            theme="ink"
            size={30}
            sub={`for ${isAgency ? "Agencies" : "Companies"}`}
          />
          {/* A client child: this layout stays a server component (components/nav-pending.tsx). */}
          <NavPendingCue label="Dashboard" />
        </Link>
      }
      header={
        <>
          <PortalBreadcrumb sections={sections} />
          <div className="pshell__headeractions">
            {balance != null ? (
              /* The balance is the number a payer checks most often and the one that blocks
                 the core loop when it hits zero, so for an owner it is a LINK to Credits rather
                 than a decorative chip. Recruiters have no /credits route, so it stays
                 display-only for them. Below ~540px its unit word is hidden visually; the chip
                 keeps an accessible name and a tooltip (balance-chip.tsx). */
              <BalanceChip balance={balance} linkToCredits={isOwner} />
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
