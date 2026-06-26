import Link from "next/link";
import { requireOwner } from "../../../lib/auth/org-roles";
import { listOrgMembers } from "../../../lib/org-members";
import { Card } from "../../../components/ds";
import { TeamManager } from "./team-manager";

export const dynamic = "force-dynamic";

/**
 * OWNER-only TEAM (user management) — org-RBAC scaffold.
 *
 * {@link requireOwner} gates the route SERVER-SIDE: a Recruiter gets a NEUTRAL 404 (not a
 * nav-only hide — the nav merely omits the link as an affordance; THIS is the decision). The
 * member directory + the invite/remove actions bind to a clearly-STUBBED data source — there is
 * no org/member API yet (see lib/org-members.ts // STUB). PII-free: opaque ids + coarse labels.
 */
export default async function TeamPage() {
  await requireOwner();
  const members = await listOrgMembers();

  return (
    <>
      <p className="chrome-sub" style={{ marginBottom: "var(--space-2)" }}>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="chrome-title">Team</h1>
      <p className="chrome-sub">
        Invite recruiters to your hiring desk and manage who can post, search, and unlock.
        Billing &amp; wallet stay with Owners.
      </p>

      <Card variant="outline" className="team-note">
        <p className="team-note__msg">
          <strong>Scaffold.</strong> Inviting and removing members activates when the org
          directory API lands — nothing here charges, emails, or persists anyone yet.
        </p>
      </Card>

      <TeamManager members={members} />
    </>
  );
}
