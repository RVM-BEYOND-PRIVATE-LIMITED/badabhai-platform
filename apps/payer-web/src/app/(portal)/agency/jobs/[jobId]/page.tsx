import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
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
import { Badge } from "../../../../../components/ds";

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
  // Fail closed on a non-uuid segment BEFORE it reaches the authed API path.
  if (!z.string().uuid().safeParse(jobId).success) notFound();
  const job = await getAgencyJob(jobId);
  if (!job) notFound();

  const active = isActiveJob(job);
  return (
    <>
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">{job.title}</h1>
          <p className="page-head__sub">
            One of your agency&rsquo;s own vacancies — what you asked for and how many people
            have applied. No worker identities are shown here.
          </p>
        </div>
        <div className="page-head__actions">
          <Badge tone={active ? "success" : "neutral"} upper>
            {active ? "open" : "closed"}
          </Badge>
        </div>
      </div>

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
    </>
  );
}
