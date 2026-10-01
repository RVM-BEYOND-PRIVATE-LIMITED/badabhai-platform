import { requirePayer } from "../../../../../lib/auth";
import { getOrgRole } from "../../../../../lib/auth/org-roles";
import { applicantsScreen } from "./applicants-screen";

export const dynamic = "force-dynamic";

/**
 * Faceless applicant feed for one of the payer's OWN company postings (ADR-0019 Decision E).
 * The screen itself is shared with the agency route (see ./applicants-screen.tsx); this route
 * supplies its way back up — the posting it belongs to — and the Postings list.
 *
 * `requirePayer()` is the gate (the portal layout runs it too); the org role only decides an
 * AFFORDANCE: whether a zero balance may link to the Owner-only Credits page.
 */
export default async function ApplicantsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePayer();
  const { id } = await params;
  return applicantsScreen({
    jobId: id,
    back: { href: `/postings/${id}`, label: "Posting details" },
    listHref: "/postings",
    canBuyCredits: getOrgRole(session) === "owner",
  });
}
