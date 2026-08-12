import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getPosting } from "../../../../lib/payer-api";
import { requirePayer } from "../../../../lib/auth";
import { Badge } from "../../../../components/ds";

export const dynamic = "force-dynamic";

/**
 * Manage-posting DETAIL (ADR-0019 Phase 1) — the caller's OWN posting via the LIVE
 * `GET /payer/job-postings/:id` (XB-A: the seam binds tenancy to the server-held
 * session; the route param is only the posting id). An unknown OR not-owned id is the
 * SAME neutral 404 (no-oracle) → `notFound()`. FACELESS: the payer's own fields only —
 * no worker name/phone ever reaches this page.
 *
 * UI-1: page-back / page-head (with the status Badge + the two onward actions) and the
 * fields as the shared `.kv` description list inside a panel.
 */

function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused") return "warning";
  return "neutral";
}

export default async function PostingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePayer();
  const { id } = await params;
  // Fail closed on a non-uuid segment BEFORE it reaches the authed API path.
  if (!z.string().uuid().safeParse(id).success) notFound();
  const posting = await getPosting(id);
  if (!posting) notFound();

  return (
    <>
      <p className="page-back">
        <Link href="/postings">← Manage postings</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">{posting.roleTitle}</h1>
          <p className="page-head__sub">
            What this posting says and where it stands. Applicants stay masked until you
            unlock them.
          </p>
        </div>
        <div className="page-head__actions">
          <Badge tone={statusTone(posting.status)} upper>
            {posting.status}
          </Badge>
          <Link
            className="bb-btn bb-btn--primary bb-btn--sm"
            href={`/postings/${posting.id}/applicants`}
          >
            <i className="ph ph-users-three" aria-hidden="true" />
            <span>View applicants</span>
          </Link>
          <Link
            className="bb-btn bb-btn--secondary bb-btn--sm"
            href={`/postings/${posting.id}/edit`}
          >
            <i className="ph ph-pencil-simple" aria-hidden="true" />
            <span>Edit posting</span>
          </Link>
        </div>
      </div>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Posting details</h2>
        </div>
        <div className="panel__body">
          <dl className="kv">
            <dt className="kv__k">Location</dt>
            <dd className="kv__v">{posting.locationLabel ?? "Location flexible"}</dd>
            <dt className="kv__k">Vacancies</dt>
            <dd className="kv__v bb-mono">{posting.vacancyBand}</dd>
            <dt className="kv__k">Applicants</dt>
            <dd className="kv__v">
              <span className="bb-mono">{posting.applicantCount}</span> /{" "}
              <span className="bb-mono">{posting.applicantQuota ?? "—"}</span>
            </dd>
            <dt className="kv__k">Posted</dt>
            <dd className="kv__v bb-mono">{day(posting.createdAt)}</dd>
          </dl>
        </div>
      </section>
    </>
  );
}
