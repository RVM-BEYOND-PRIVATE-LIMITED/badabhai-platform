import { notFound } from "next/navigation";
import { z } from "zod";
import { getAgencyJob } from "../../../../../lib/payer-api";
import { requireAgent } from "../../../../../lib/auth/roles";
import { agencyFlags } from "../../../../../lib/config";
import {
  day,
  experienceBandLabel,
  neededByLabel,
  payBandLabel,
  tradeLabel,
} from "../../../../../lib/agency-view";
import { bandLabel } from "../../../../../lib/masking";
import { cardFieldsFromAgencyJob } from "../../../../../lib/job-card-view";
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
      />

      <div className="posting-layout">
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Vacancy details</h2>
          </div>
          <div className="panel__body">
            {/* FACELESS: bands, counts and dates only — every value below is derived from the
                vacancy itself, never from an applicant. */}
            <dl className="kv">
              <dt className="kv__k">Trade</dt>
              <dd className="kv__v">{tradeLabel(job.tradeKey)}</dd>
              <dt className="kv__k">Location</dt>
              <dd className="kv__v">{bandLabel([job.city, job.area]) || "—"}</dd>
              <dt className="kv__k">Pay band</dt>
              <dd className="kv__v bb-mono">{payBandLabel(job.payMin, job.payMax)}</dd>
              <dt className="kv__k">Experience</dt>
              <dd className="kv__v">
                {experienceBandLabel(job.minExperienceYears, job.maxExperienceYears)}
              </dd>
              <dt className="kv__k">Needed by</dt>
              <dd className="kv__v">{neededByLabel(job.neededBy)}</dd>
              <dt className="kv__k">Applicants</dt>
              <dd className="kv__v ui-num">{job.applicantsReceived}</dd>
              <dt className="kv__k">Posted</dt>
              <dd className="kv__v bb-mono">{day(job.createdAt)}</dd>
            </dl>
          </div>
        </section>

        <aside className="posting-preview" aria-label="Job card">
          <JobCardPreview fields={cardFieldsFromAgencyJob(job)} />
        </aside>
      </div>
    </>
  );
}
