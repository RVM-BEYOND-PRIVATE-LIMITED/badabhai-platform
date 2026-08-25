import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
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

/**
 * A count INSIDE the stored band, as the edit seed ("2-5" → 2, "1" → 1, "25+" → 26).
 * "25+" must seed 26, NOT 25: the backend band boundary is STRICTLY greater than 25
 * (25 falls in "11-25"), so seeding 25 would downgrade the band if ever submitted.
 * (Belt: the form also OMITS an untouched count from the PATCH entirely.)
 */
function bandRepresentativeCount(band: string): number {
  if (band.endsWith("+")) {
    const n = parseInt(band, 10);
    return Number.isNaN(n) ? 1 : n + 1;
  }
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
  // Fail closed on a non-uuid segment BEFORE it reaches the authed API path (a
  // percent-encoded path could otherwise aim the server-held Bearer at another route).
  if (!z.string().uuid().safeParse(id).success) notFound();
  const draft = await getPostingDraft(id);
  if (!draft) notFound();

  return (
    <>
      <p className="page-back">
        <Link href={`/postings/${id}`}>← Posting details</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Edit posting</h1>
          {/* The role title is the payer's OWN posting field — it identifies which posting
              is being edited. FACELESS: no worker field is ever rendered here. */}
          <p className="page-head__sub">
            Change the role title, location, vacancy count, pay, shift, timing or
            description for {draft.summary.roleTitle}.
          </p>
        </div>
      </div>
      <EditPostingForm
        postingId={id}
        initial={{
          roleTitle: draft.summary.roleTitle,
          locationLabel: draft.summary.locationLabel,
          vacanciesHint: bandRepresentativeCount(draft.summary.vacancyBand),
          description: draft.description,
          city: draft.city,
          payMin: draft.payMin,
          payMax: draft.payMax,
          shift: draft.shift,
          neededBy: draft.neededBy,
        }}
      />
    </>
  );
}
