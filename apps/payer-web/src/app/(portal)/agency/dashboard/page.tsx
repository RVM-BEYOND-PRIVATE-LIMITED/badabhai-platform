import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * AGENCY DASHBOARD (legacy route) → permanently consolidated into the single role-aware
 * `/dashboard` (MERGE-1). The agency demand modules now render inline on `/dashboard` for an
 * `agent` session (see ../../dashboard/agent-sections.tsx). This route is kept ONLY so old
 * links / bookmarks / any residual `/agency/dashboard` href still resolve — it `redirect()`s
 * server-side to `/dashboard`.
 *
 * SECURITY: no agency data is read or rendered here. The role gate + faceless agency reads now
 * live on the `/dashboard` agent branch (`AgentSections` re-asserts `requireAgent()`,
 * fail-closes on the portal flag, and wraps every payload in `assertNoAgencyPII`). The
 * `#agency-vacancies` fragment is preserved on the destination, so a deep link to the vacancy
 * manager still lands there.
 *
 * The agency child components continue to live in this directory: referral-funnel and
 * parked-modules are imported by `/dashboard`'s AgentSections, agency-jobs-manager by the Postings
 * page (`/agency/jobs`), agency-job-form by New posting and Edit posting, and the invite + batch
 * panels by Referrals — only this page entry became a redirect.
 */
export default function AgencyDashboardRedirect(): never {
  redirect("/dashboard");
}
