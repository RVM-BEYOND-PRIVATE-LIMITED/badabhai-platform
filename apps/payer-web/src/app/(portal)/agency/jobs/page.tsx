import { notFound } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { listAgencyJobs } from "../../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../../lib/assert-no-agency-pii";
import type { AgencyJob } from "../../../../lib/contracts";
import { Card } from "../../../../components/ds";
import { PageHeader } from "../../../../components/page-header";
import { RetryButton } from "../../../../components/retry-button";
import { AgencyJobsManager } from "../dashboard/agency-jobs-manager";

export const dynamic = "force-dynamic";

/**
 * Agency "Postings" (owner ruling 2026-10-01) — the agency's OWN postings, i.e. rows of the
 * `jobs` table the worker feed reads (ADR-0022), managed in one place: pause, resume and close in
 * the row, and links to each posting's details, applicants (`/agency/jobs/<id>/applicants`, the
 * workers who applied — #1955/#1956) and edit page (`/agency/jobs/<id>/edit`). "New posting"
 * (`/agency/jobs/new`) creates one.
 *
 * An agency posts AGENCY jobs only: the company posting surface (`/postings*`, `job_postings`)
 * is not offered to agents, and an agent who opens it is sent here (see postings/page.tsx).
 *
 * SECURITY (role authz / XB-A): `requireAgent()` FIRST (an employer gets the neutral 404 every
 * agency route gives), then the agency-portal flag (off → the route does not exist), exactly
 * like its siblings. The list read binds to the server-held session; every payload crosses
 * {@link assertNoAgencyPII} at the render boundary. FACELESS: bands, counts, status only.
 *
 * DEGRADE: a failed read is a neutral retry state — never an empty list that would read as
 * "you have no postings".
 */
export default async function AgencyPostingsPage() {
  await requireAgent();
  if (!agencyFlags().agencyPortalEnabled) notFound();

  let jobs: AgencyJob[] | null = null;
  try {
    jobs = assertNoAgencyPII(await listAgencyJobs(), "payer/agency/jobs");
  } catch {
    jobs = null;
  }

  // `.agency-postings-page` only NAMESPACES this screen — it carries no styling of its own.
  return (
    <div className="agency-postings-page">
      <PageHeader
        title="Postings"
        description="Every posting your agency has published, with the controls to edit, pause, resume or close it."
        primaryAction={{ href: "/agency/jobs/new", label: "New posting", icon: ACTION_ICON.create }}
      />
      {jobs ? (
        <AgencyJobsManager jobs={jobs} />
      ) : (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
            </span>
            <h2 className="state__title">Postings are unavailable right now</h2>
            <p className="state__body">
              The list could not be read. Nothing has changed — your postings are still there.
              Please retry shortly.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
