import Link from "next/link";
import { notFound } from "next/navigation";
import { getPostingDraft } from "../../../../../lib/payer-api";
import { requirePayer } from "../../../../../lib/auth";
import { EditPostingForm } from "./edit-posting-form";

export const dynamic = "force-dynamic";

/**
 * Edit-posting page (ADR-0019 Phase 1) — prefilled from the caller's OWN posting via
 * the LIVE `GET /payer/job-postings/:id` draft read (XB-A; unknown OR not-owned id is
 * the SAME neutral 404 → `notFound()`). The stored row keeps only the vacancy BAND, so
 * the count field prefills the band's lower bound (the server re-derives the band from
 * whatever count is submitted).
 */

/** The band's lower bound as an editable starting count ("2-5" → 2, "25+" → 25, "1" → 1). */
function bandLowerBound(band: string): number {
  const n = parseInt(band, 10);
  return Number.isNaN(n) || n <= 0 ? 1 : n;
}

export default async function EditPostingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePayer();
  const { id } = await params;
  const draft = await getPostingDraft(id);
  if (!draft) notFound();

  return (
    <>
      <p className="postings-back">
        <Link href={`/postings/${id}`}>← Posting details</Link>
      </p>
      <h1 className="postings-title">Edit posting</h1>
      <p className="postings-sub">{draft.summary.roleTitle}</p>
      <EditPostingForm
        postingId={id}
        initial={{
          roleTitle: draft.summary.roleTitle,
          locationLabel: draft.summary.locationLabel,
          vacanciesHint: bandLowerBound(draft.summary.vacancyBand),
          description: draft.description,
        }}
      />
    </>
  );
}
