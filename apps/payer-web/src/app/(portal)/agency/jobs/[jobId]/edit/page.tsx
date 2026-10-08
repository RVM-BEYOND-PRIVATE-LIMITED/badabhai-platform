import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getAgencyJob, listMatchSkills } from "../../../../../../lib/payer-api";
import { requireAgent } from "../../../../../../lib/auth/roles";
import { agencyFlags } from "../../../../../../lib/config";
import type { MatchSkillWire } from "../../../../../../lib/contracts";
import { isEditableJob } from "../../../../../../lib/agency-view";
import { PageHeader } from "../../../../../../components/page-header";
import { EditAgencyPosting } from "./edit-agency-posting";

export const dynamic = "force-dynamic";

/**
 * Agency "Edit posting" (final sweep F02) — the one place an agency edits one of its OWN `jobs`
 * rows. It replaced the inline editor on the Postings list, which opened inside the row's card
 * below the page head and the row header, so the worker card and "Save changes" started below a
 * laptop's fold. The structure is the company edit page's: back to the posting (by its title) ·
 * H1 · the form, with the page head leading the FORM column so the card-preview rail starts at the
 * top of the content (the same fit rule as New posting).
 *
 * SECURITY: `requireAgent()` FIRST, then the agency-portal flag, then a uuid guard before the id
 * reaches the authed API path — like every sibling agency page. The read binds to the server-held
 * session (XB-A) and crosses `assertNoAgencyPII` at the seam; an unknown OR not-owned job is the
 * SAME neutral 404 (no oracle). The save goes through `updateAgencyJobAction`, which re-asserts the
 * role itself (a Server Action is independently invocable).
 *
 * A closed or suspended posting has no edit door anywhere in the portal (`isEditableJob`): closed
 * is terminal and the API refuses its edit; suspended is system-owned. An old link to its edit
 * page lands on its details instead of a form whose save could only fail.
 */
export default async function EditAgencyPostingPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  await requireAgent();
  if (!agencyFlags().agencyPortalEnabled) notFound();
  const { jobId } = await params;
  // Fail closed on a non-uuid segment BEFORE it reaches the authed API path.
  if (!z.string().uuid().safeParse(jobId).success) notFound();
  const job = await getAgencyJob(jobId);
  if (!job) notFound();
  const detailHref = `/agency/jobs/${jobId}`;
  if (!isEditableJob(job)) redirect(detailHref);

  // ADR-0050 §6.1 step 2 (#2104) — the closed match vocabulary, read SERVER-side (the Bearer
  // never reaches the browser) AFTER the gates, as New posting does. A failed read hands the form
  // `[]`, which it reports and refuses to save on: the picker's chips are what the pick is made
  // from, so without them an edit could only erase or misstate it.
  let matchSkills: MatchSkillWire[] = [];
  try {
    matchSkills = await listMatchSkills();
  } catch {
    matchSkills = [];
  }

  // The page head leads the FORM column, so the card-preview rail starts beside it at the top.
  // Back to the posting by its own name — its details page's H1, and the applicants page's back
  // label: one label per destination.
  const lead = (
    <PageHeader
      back={{ href: detailHref, label: job.title }}
      title="Edit posting"
      description={`Change the role, location, pay, timing, chips or description for ${job.title} — the card preview updates as you edit.`}
    />
  );

  return (
    // KEYED ON THE SAVED REVISION: a form seeded from an older copy of this posting (a cached page
    // restored by Back after a save, a refresh after a concurrent edit) remounts from the current
    // one instead of keeping stale values — and a stale `initial` for the clear diff.
    <EditAgencyPosting key={job.updatedAt} job={job} matchSkills={matchSkills} lead={lead} />
  );
}
