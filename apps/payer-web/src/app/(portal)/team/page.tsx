import Link from "next/link";
import { requireOwner } from "../../../lib/auth/org-roles";
import { listOrgMembers } from "../../../lib/org-members";
import { TeamManager } from "./team-manager";

export const dynamic = "force-dynamic";

/**
 * OWNER-only TEAM (user management) — wired to the LIVE org API (ADR-0027 / B5.5).
 *
 * {@link requireOwner} gates the route SERVER-SIDE: a Recruiter gets a NEUTRAL 404 (not a
 * nav-only hide — the nav merely omits the link as an affordance; THIS is the decision). The
 * member directory + the invite/remove actions bind to the caller's SERVER-HELD org (XB-A).
 * Faceless: members render with a server-masked email + role + status only — no raw PII.
 */
export default async function TeamPage() {
  await requireOwner();
  const members = await listOrgMembers();

  return (
    <>
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Team</h1>
          <p className="page-head__sub">
            Invite recruiters to your hiring desk and manage who can post, search, and unlock.
            Billing &amp; wallet stay with owners.
          </p>
        </div>
      </div>

      <TeamManager members={members} />
    </>
  );
}
