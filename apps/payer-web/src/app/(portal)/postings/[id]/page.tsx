import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getPosting } from "../../../../lib/payer-api";
import { requirePayer } from "../../../../lib/auth";
import { Badge, Card } from "../../../../components/ds";

export const dynamic = "force-dynamic";

/**
 * Manage-posting DETAIL (ADR-0019 Phase 1) — the caller's OWN posting via the LIVE
 * `GET /payer/job-postings/:id` (XB-A: the seam binds tenancy to the server-held
 * session; the route param is only the posting id). An unknown OR not-owned id is the
 * SAME neutral 404 (no-oracle) → `notFound()`. FACELESS: the payer's own fields only —
 * no worker name/phone ever reaches this page.
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
      <p className="postings-back">
        <Link href="/postings">← Manage postings</Link>
      </p>
      <div className="posting-card__head">
        <h1 className="postings-title">{posting.roleTitle}</h1>
        <Badge tone={statusTone(posting.status)} upper>
          {posting.status}
        </Badge>
      </div>

      <Card padding="md" className="posting-card">
        <dl className="reveal-card__dl">
          <dt>Location</dt>
          <dd>{posting.locationLabel ?? "Location flexible"}</dd>
          <dt>Vacancies</dt>
          <dd className="bb-mono">{posting.vacancyBand}</dd>
          <dt>Applicants</dt>
          <dd>
            <span className="bb-mono">{posting.applicantCount}</span> /{" "}
            <span className="bb-mono">{posting.applicantQuota ?? "—"}</span>
          </dd>
          <dt>Posted</dt>
          <dd className="bb-mono">{day(posting.createdAt)}</dd>
        </dl>
      </Card>

      <p className="postings-sub">
        <Link className="postings-link" href={`/postings/${posting.id}/applicants`}>
          View applicants →
        </Link>{" "}
        <Link className="postings-link" href={`/postings/${posting.id}/edit`}>
          Edit this posting →
        </Link>
      </p>
    </>
  );
}
