import Link from "next/link";
import { requireOwner } from "../../../lib/auth/org-roles";
import { Card } from "../../../components/ds";

export const dynamic = "force-dynamic";

/**
 * OWNER-only TEAM (user management) — COMING SOON (alpha cut).
 *
 * {@link requireOwner} still gates the route SERVER-SIDE (a Recruiter gets a NEUTRAL 404). Team
 * member management (invite → accept → remove) is BUILT on the org-members API but NOT scoped into
 * the alpha cut yet, so this renders a clear coming-soon state with NO dead fetch and no
 * no-op form. Turning it live = land the org-members API + team wiring (ADR-0027 B5.3 / B5.5) —
 * an OWNER scope decision; the `TeamManager` + `org-members` seam are kept for that swap.
 * PII-free: nothing here reads or renders a member.
 */
export default async function TeamPage() {
  await requireOwner();

  return (
    <>
      <p className="chrome-sub" style={{ marginBottom: "var(--space-2)" }}>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="chrome-title">Team</h1>
      <p className="chrome-sub">
        Invite recruiters to your hiring desk — post, search, and unlock together. Billing &amp;
        wallet stay with owners.
      </p>

      <Card variant="outline" className="team-note">
        <p className="team-note__msg">
          <strong>Coming soon.</strong> Team member management is on the way. You&rsquo;ll be able
          to invite recruiters by email, manage roles, and remove members here.
        </p>
      </Card>
    </>
  );
}
