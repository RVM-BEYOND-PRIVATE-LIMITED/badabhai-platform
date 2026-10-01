import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAgent } from "../../../../../../lib/auth/roles";
import { getOrgRole } from "../../../../../../lib/auth/org-roles";
import { agencyFlags } from "../../../../../../lib/config";
import { applicantsScreen } from "../../../../postings/[id]/applicants/applicants-screen";

export const dynamic = "force-dynamic";

/**
 * Applicants for one of the agency's OWN postings (`jobs`). Before this route an agency posting's
 * applicants were reachable from no page at all (the detail page had no link, and the only feed
 * lived under the company `/postings` tree).
 *
 * It renders the SAME faceless feed screen as a company posting's applicants, over the SAME
 * endpoint — `GET /payer/reach/jobs/:jobId/applicants`, which the agency jobs controller
 * documents as the applicant route for an agency job. Nothing new is read or exposed; the
 * endpoint's own ownership check (unknown OR not-owned → the same neutral 404) is the authority,
 * and the screen renders that as its neutral not-found.
 *
 * SECURITY: `requireAgent()` FIRST, then the agency-portal flag, then a uuid check before the id
 * reaches the authed API path — the same order as the posting's detail page above it.
 */
export default async function AgencyPostingApplicantsPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const session = await requireAgent();
  if (!agencyFlags().agencyPortalEnabled) notFound();
  const { jobId } = await params;
  if (!z.string().uuid().safeParse(jobId).success) notFound();

  return applicantsScreen({
    jobId,
    back: { href: `/agency/jobs/${jobId}`, label: "Posting details" },
    listHref: "/agency/jobs",
    canBuyCredits: getOrgRole(session) === "owner",
  });
}
