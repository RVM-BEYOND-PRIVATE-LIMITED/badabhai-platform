import { notFound } from "next/navigation";
import { z } from "zod";
import { ACTION_ICON } from "@badabhai/icons";
import { getAgencyJob } from "../../../../../lib/payer-api";
import { requireAgent } from "../../../../../lib/auth/roles";
import { agencyFlags } from "../../../../../lib/config";
import { day, isEditableJob, tradeLabel } from "../../../../../lib/agency-view";
import {
  cardFieldsFromAgencyJob,
  experienceLabel,
  neededByLabel,
  toJobCardView,
} from "../../../../../lib/job-card-view";
import { jobRoleLabel } from "../../../../../lib/job-roles";
import { Badge } from "../../../../../components/ds";
import { JobCardPreview } from "../../../../../components/job-card-preview";
import { PageHeader } from "../../../../../components/page-header";

/** The DS Badge tone for a vacancy's REAL 4-state status (open|paused|suspended|closed). */
function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused" || status === "suspended") return "warning";
  return "neutral";
}

export const dynamic = "force-dynamic";

/**
 * AGENCY single-job DETAIL (ADR-0022) — one of the caller's OWN jobs via the LIVE,
 * agent-only `GET /payer/agency/jobs/:jobId` (PayerAuthGuard + PayerRoleGuard; XB-A —
 * the seam binds tenancy to the server-held agent session). `requireAgent()` renders a
 * plain not-found for any non-agent session (no role leak); an unknown OR not-owned
 * job is the SAME neutral 404 (no-oracle) → `notFound()`. FACELESS by construction:
 * ids / status / bands / counts only — no worker identity on this page, ever.
 *
 * HEADER (final sweep F14 — the company detail's contract): status · primary "Applicants" (the
 * posting's REAL applicants, #1956) · secondary "Edit posting" (its own page, F02). Edit is offered
 * only where the Postings row offers it (`isEditableJob`: open or paused).
 */
export default async function AgencyJobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  await requireAgent();
  // Same flag gate as every sibling agency page (it was the one agency page without it).
  if (!agencyFlags().agencyPortalEnabled) notFound();
  const { jobId } = await params;
  // Fail closed on a non-uuid segment BEFORE it reaches the authed API path.
  if (!z.string().uuid().safeParse(jobId).success) notFound();
  const job = await getAgencyJob(jobId);
  if (!job) notFound();
  const card = cardFieldsFromAgencyJob(job);
  const view = toJobCardView(card);

  return (
    <>
      <PageHeader
        back={{ href: "/agency/jobs", label: "Postings" }}
        title={job.title}
        description="What this posting asks for and how many people have applied — no worker identities are shown."
        status={
          <Badge tone={statusTone(job.status)} upper>
            {job.status}
          </Badge>
        }
        // The REAL applicants for this agency job (#1956) — the feed serves the workers who
        // applied since #1955.
        primaryAction={{
          href: `/agency/jobs/${jobId}/applicants`,
          label: "Applicants",
          icon: ACTION_ICON.users,
        }}
        secondaryActions={
          isEditableJob(job)
            ? [
                {
                  href: `/agency/jobs/${jobId}/edit`,
                  label: "Edit posting",
                  icon: ACTION_ICON.edit,
                },
              ]
            : []
        }
      />

      <div className="posting-layout">
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Posting details</h2>
          </div>
          <div className="panel__body">
            {/* FACELESS: bands, counts and dates only — every value below is derived from the
                vacancy itself, never from an applicant. Anything the card beside this list ALSO
                shows is formatted by the card's own mapper, so the two never disagree. */}
            <dl className="kv">
              <dt className="kv__k">Role</dt>
              <dd className="kv__v">{jobRoleLabel(card.role_kind) ?? "—"}</dd>
              <dt className="kv__k">Trade</dt>
              <dd className="kv__v">{tradeLabel(job.tradeKey)}</dd>
              <dt className="kv__k">Location</dt>
              <dd className="kv__v">{view.place || "—"}</dd>
              <dt className="kv__k">Pay band</dt>
              <dd className="kv__v bb-mono">{view.salary?.band ?? "—"}</dd>
              <dt className="kv__k">Experience</dt>
              <dd className="kv__v">
                {experienceLabel(card.min_experience_years, card.max_experience_years) ?? "—"}
              </dd>
              <dt className="kv__k">Needed by</dt>
              <dd className="kv__v">{neededByLabel(card.needed_by) ?? "—"}</dd>
              <dt className="kv__k">Applicants</dt>
              <dd className="kv__v ui-num">{job.applicantsReceived}</dd>
              <dt className="kv__k">Posted</dt>
              <dd className="kv__v bb-mono">{day(job.createdAt)}</dd>
              <dt className="kv__k">Description</dt>
              <dd className="kv__v kv__v--prose">{job.description ?? "—"}</dd>
            </dl>
          </div>
        </section>

        <aside className="posting-preview" aria-label="Worker card preview">
          <div className="posting-preview__scroll">
            <JobCardPreview fields={card} />
          </div>
        </aside>
      </div>
    </>
  );
}
