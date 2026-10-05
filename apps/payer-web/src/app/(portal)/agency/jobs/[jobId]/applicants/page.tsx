import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requireAgent } from "../../../../../../lib/auth/roles";
import { getOrgRole } from "../../../../../../lib/auth/org-roles";
import { agencyFlags } from "../../../../../../lib/config";
import { getAgencyJob, getApplicantFeed, getCredits } from "../../../../../../lib/payer-api";
import type { ApplicantFeed } from "../../../../../../lib/contracts";
import { Card } from "../../../../../../components/ds";
import { PageHeader } from "../../../../../../components/page-header";
import { RetryButton } from "../../../../../../components/retry-button";
import { ApplicantActions } from "../../../../postings/[id]/applicants/applicant-actions";

export const dynamic = "force-dynamic";

/**
 * Faceless applicant feed for one of the agency's OWN `jobs` rows (#1956).
 *
 * Since #1955 an owned agency job returns ONLY the workers who applied (`applications.job_id`,
 * `action = 'applied'`), ranked, whether or not `MATCH_V1_ENABLED` is on — so, unlike the
 * company posting feed, the copy here says "applied", never "suggested". A job nobody applied
 * to is a `200 { applicants: [] }` → the "No one has applied yet" empty state.
 *
 * XB-A: the feed is fetched payer-scoped; a job that isn't the caller's returns the SAME neutral
 * 404 as an unknown one (no cross-tenant existence oracle) → `notFound()`. XB-C: rows are
 * faceless (opaque id + banded signals) — no name/phone/employer. The AGENCY job id is passed as
 * the disclosure/unlock context; the backend normalises it (#1955).
 *
 * Reuses the SAME `ApplicantActions` pipeline the company posting feed uses. That read chain is
 * shape-driven (`score`/`components` legacy vs `applicationId` V1), so an agency row renders
 * here exactly as it does on a company posting — never branched on the id.
 */
export default async function AgencyJobApplicantsPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const session = await requireAgent();
  if (!agencyFlags().agencyPortalEnabled) notFound();

  const { jobId } = await params;
  // Fail closed on a non-uuid segment BEFORE it reaches the authed API path.
  if (!z.string().uuid().safeParse(jobId).success) notFound();

  // Name the posting from its own read (the detail page's H1 is the job title). A job that is
  // unknown OR not owned is the same neutral 404.
  const job = await getAgencyJob(jobId);
  if (!job) notFound();

  // The feed is the page's primary content; a balance-read failure must not blank it (each has
  // its own try/catch, same shape as the company applicants page).
  let feed: ApplicantFeed | null = null;
  let feedError = false;
  let jobNotFound = false;
  try {
    feed = await getApplicantFeed(jobId);
    if (!feed) jobNotFound = true;
  } catch {
    feedError = true;
  }

  let balance: number | null = null;
  try {
    balance = (await getCredits()).balance;
  } catch {
    // Balance unavailable → the feed renders with Unlock enabled; never blank it.
    balance = null;
  }

  const header = {
    back: { href: `/agency/jobs/${jobId}`, label: job.title },
    title: "Applicants",
    description: `Everyone who applied to ${job.title}, best match first and faceless until you unlock a contact.`,
  };

  if (feed && feed.applicants.length > 0) {
    return (
      <div className="applicants-page">
        <ApplicantActions
          header={header}
          // The agency job id IS the disclosure/unlock context (the backend normalises it).
          postingId={feed.postingId}
          applicants={feed.applicants}
          // Balance is an affordance hint only — a failed read keeps Unlock enabled.
          balance={balance ?? 1}
          canBuyCredits={getOrgRole(session) === "owner"}
        />
      </div>
    );
  }

  return (
    <div className="applicants-page">
      <PageHeader {...header} back={jobNotFound ? undefined : header.back} />

      {jobNotFound ? (
        // NEUTRAL not-found: the union of "does not exist" and "not yours".
        <Card>
          <div className="state">
            <span className="state__icon">
              <Icon name="file-dashed" />
            </span>
            <h2 className="state__title">No posting found here</h2>
            <p className="state__body">It may not exist, or it isn&rsquo;t one of your postings.</p>
            <div className="state__actions">
              <Link className="bb-btn bb-btn--secondary" href="/agency/jobs">
                <Icon name={ACTION_ICON.posting} />
                <span>Postings</span>
              </Link>
            </div>
          </div>
        </Card>
      ) : feedError || !feed ? (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
            </span>
            <h2 className="state__title">We couldn&rsquo;t load applicants</h2>
            <p className="state__body">
              This is usually temporary — nothing about this posting has changed. Please retry.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="state">
            <span className="state__icon">
              <Icon name={ACTION_ICON.users} />
            </span>
            <h2 className="state__title">No one has applied yet</h2>
            <p className="state__body">
              When workers apply to this posting they appear here — faceless — best match first.
              Nothing is needed from you meanwhile.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
