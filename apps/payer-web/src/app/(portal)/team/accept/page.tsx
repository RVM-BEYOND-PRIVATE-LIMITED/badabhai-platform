import { requirePayer } from "../../../../lib/auth";
import { PageHeader } from "../../../../components/page-header";
import { AcceptInvite } from "./accept-invite";

export const dynamic = "force-dynamic";

/**
 * Invite ACCEPT landing (ADR-0027 / B5.5) — the page the accept-link email points at
 * (MEMBER_INVITE_ACCEPT_URL = `…/team/accept`). NOT owner-gated: any logged-in payer may accept an
 * invite addressed to them. {@link requirePayer} redirects to /login when there is no session, so
 * the invitee signs in first; the API then binds the accept to that verified identity (XB-A) and
 * to the invited email. The single-use token rides the URL only — it is handed straight to the
 * action, never logged or rendered.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  await requirePayer();
  const { token } = await searchParams;

  // `.team-accept-page` only NAMESPACES this screen's layout rules (the "W3-B" block in
  // globals.css) — it carries no styling of its own.
  return (
    <div className="team-accept-page">
      <PageHeader
        title="Join a team"
        description="Accept your invite to join the hiring desk you were added to."
      />
      <AcceptInvite token={typeof token === "string" ? token : ""} />
    </div>
  );
}
