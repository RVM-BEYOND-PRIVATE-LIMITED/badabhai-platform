import { requireOwner } from "../../../lib/auth/org-roles";
import { listOrgMembers, type OrgMemberView } from "../../../lib/org-members";
import { PageHeader } from "../../../components/page-header";
import { TeamManager } from "./team-manager";

export const dynamic = "force-dynamic";

/**
 * OWNER-only TEAM (user management) — wired to the LIVE org API (ADR-0027 / B5.5).
 *
 * {@link requireOwner} gates the route SERVER-SIDE: a Recruiter gets a NEUTRAL 404 (not a
 * nav-only hide — the nav merely omits the link as an affordance; THIS is the decision). The
 * member directory + the invite/remove actions bind to the caller's SERVER-HELD org (XB-A).
 * Faceless: members render with a server-masked email + role + status only — no raw PII.
 *
 * A failed members read stays ON the page (F30): it used to throw to the (portal) error boundary,
 * taking the head and the invite form with it. `null` tells the manager the read failed (never
 * `[]`, which would say the team is empty); it shows the standard in-place error with a Retry
 * where the list goes, and keeps the invite form — inviting does not depend on that read.
 */
export default async function TeamPage() {
  await requireOwner();
  let members: OrgMemberView[] | null = null;
  try {
    members = await listOrgMembers();
  } catch {
    members = null;
  }

  // `.team-page` only NAMESPACES this screen's layout rules (the "W3-B" block in globals.css)
  // — it carries no styling of its own.
  return (
    <div className="team-page">
      <PageHeader
        title="Team"
        description="Invite recruiters to your hiring desk and manage who can post, search and unlock — billing and credits stay with owners."
      />

      <TeamManager members={members} />
    </div>
  );
}
