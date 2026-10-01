import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getPostingDetail } from "../../../../lib/payer-api";
import { requirePayer } from "../../../../lib/auth";
import { Badge } from "../../../../components/ds";
import { JobCardPreview } from "../../../../components/job-card-preview";
import { toJobCardView } from "../../../../lib/job-card-view";
import { jobRoleLabel } from "../../../../lib/job-roles";

export const dynamic = "force-dynamic";

/**
 * Manage-posting DETAIL (PR-B) — the caller's OWN posting via the LIVE `GET /payer/job-postings/:id`
 * detail read (XB-A; unknown OR not-owned → neutral 404 → `notFound()`). FACELESS: the payer's own
 * fields only. Shows the SAME {@link JobCardPreview} the form previews (one mapper), plus the kv
 * facts. A DRAFT gets a "Finish and publish" CTA — a draft reaches nobody until it is published.
 */

function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused" || status === "suspended") return "warning";
  return "neutral";
}

export default async function PostingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePayer();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const detail = await getPostingDetail(id);
  if (!detail) notFound();

  const { summary, card, description } = detail;
  const view = toJobCardView(card);
  const isDraft = summary.status === "draft";

  return (
    <>
      <p className="page-back">
        <Link href="/postings">← Manage postings</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">{summary.roleTitle}</h1>
          <p className="page-head__sub">
            What this posting says and where it stands. Applicants stay masked until you unlock them.
          </p>
        </div>
        <div className="page-head__actions">
          <Badge tone={statusTone(summary.status)} upper>
            {summary.status}
          </Badge>
          {isDraft ? (
            <Link className="bb-btn bb-btn--primary bb-btn--sm" href={`/postings/${summary.id}/edit`}>
              <i className="ph-fill ph-rocket-launch" aria-hidden="true" />
              <span>Finish and publish</span>
            </Link>
          ) : (
            <Link
              className="bb-btn bb-btn--primary bb-btn--sm"
              href={`/postings/${summary.id}/applicants`}
            >
              <i className="ph-fill ph-users-three" aria-hidden="true" />
              <span>View applicants</span>
            </Link>
          )}
          <Link className="bb-btn bb-btn--secondary bb-btn--sm" href={`/postings/${summary.id}/edit`}>
            <i className="ph-fill ph-pencil-simple" aria-hidden="true" />
            <span>Edit posting</span>
          </Link>
        </div>
      </div>

      {isDraft ? (
        <div className="alert alert--info">
          <i className="ph-fill ph-info alert__icon" aria-hidden="true" />
          <div className="alert__text">
            <p className="alert__title">This posting is a draft</p>
            <p className="alert__body">
              A draft reaches nobody. Finish the card and publish it so workers can find the job.
            </p>
          </div>
        </div>
      ) : null}

      <div className="posting-layout">
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Posting details</h2>
          </div>
          <div className="panel__body">
            {/* Anything the card beside this list ALSO shows is formatted by the card's own mapper
                (`toJobCardView`), so the two can never disagree about one posting. */}
            <dl className="kv">
              <dt className="kv__k">Location</dt>
              <dd className="kv__v">{view.place || "—"}</dd>
              <dt className="kv__k">Location note</dt>
              <dd className="kv__v">{summary.locationLabel ?? "—"}</dd>
              <dt className="kv__k">Role</dt>
              <dd className="kv__v">{jobRoleLabel(card.role_kind) ?? "—"}</dd>
              <dt className="kv__k">Openings</dt>
              <dd className="kv__v bb-mono">{summary.vacancyBand}</dd>
              <dt className="kv__k">Applicants</dt>
              <dd className="kv__v">
                <span className="bb-mono">{summary.applicantCount}</span> /{" "}
                <span className="bb-mono">{summary.applicantQuota ?? "—"}</span>
              </dd>
              <dt className="kv__k">Posted</dt>
              <dd className="kv__v bb-mono">{day(summary.createdAt)}</dd>
              <dt className="kv__k">Description</dt>
              <dd className="kv__v kv__v--prose">{description ?? "—"}</dd>
            </dl>
          </div>
        </section>

        <aside className="posting-preview" aria-label="Job card">
          <div className="posting-preview__scroll">
            <JobCardPreview fields={card} />
          </div>
        </aside>
      </div>
    </>
  );
}
