import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgencyJob } from "../../../../../lib/payer-api";
import { requireAgent } from "../../../../../lib/auth/roles";
import {
  day,
  experienceBandLabel,
  isActiveJob,
  neededByLabel,
  payBandLabel,
  tradeLabel,
} from "../../../../../lib/agency-view";
import { bandLabel } from "../../../../../lib/masking";
import { Badge, Card } from "../../../../../components/ds";

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
  const { jobId } = await params;
  const job = await getAgencyJob(jobId);
  if (!job) notFound();

  const active = isActiveJob(job);
  return (
    <>
      <p className="postings-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="agency-job__head">
        <h1 className="postings-title">{job.title}</h1>
        <Badge tone={active ? "success" : "neutral"} upper>
          {active ? "open" : "closed"}
        </Badge>
      </div>

      <Card padding="md" className="agency-job">
        <dl className="reveal-card__dl">
          <dt>Trade</dt>
          <dd>{tradeLabel(job.tradeKey)}</dd>
          <dt>Location</dt>
          <dd>{bandLabel([job.city, job.area]) || "—"}</dd>
          <dt>Pay band</dt>
          <dd className="bb-mono">{payBandLabel(job.payMin, job.payMax)}</dd>
          <dt>Experience</dt>
          <dd>{experienceBandLabel(job.minExperienceYears, job.maxExperienceYears)}</dd>
          <dt>Needed by</dt>
          <dd>{neededByLabel(job.neededBy)}</dd>
          <dt>Applicants</dt>
          <dd className="bb-mono">{job.applicantsReceived}</dd>
          <dt>Posted</dt>
          <dd className="bb-mono">{day(job.createdAt)}</dd>
        </dl>
      </Card>
    </>
  );
}
