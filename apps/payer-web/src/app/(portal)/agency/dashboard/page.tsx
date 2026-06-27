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
 * The agency child components (agency-jobs-manager / invite-panel / referral-funnel /
 * parked-modules + their actions) continue to live in this directory and are imported by
 * `/dashboard`'s AgentSections — only this page entry became a redirect.
 */
export default function AgencyDashboardRedirect(): never {
  redirect("/dashboard");
}
