import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getPostingDetail, listMatchSkills } from "../../../../../lib/payer-api";
import { requirePayer } from "../../../../../lib/auth";
import type { MatchSkillWire } from "../../../../../lib/contracts";
import { PageHeader } from "../../../../../components/page-header";
import { EditPostingForm } from "./edit-posting-form";

export const dynamic = "force-dynamic";

/**
 * Edit-posting page (PR-B) — prefilled from the caller's OWN posting via the LIVE
 * `GET /payer/job-postings/:id` detail read (XB-A; unknown OR not-owned → neutral 404 →
 * `notFound()`). Passes the full CardFields as `initial` (both to seed the form AND to drive the
 * `clear` diff), the match vocabulary + the posting's own match selection (so the skill picker
 * prefills), and the status (draft → Publish is offered; open/paused → Save changes only).
 */

/** A count INSIDE the stored band, as the edit seed ("2-5" → 2, "1" → 1, "25+" → 26). */
function bandRepresentativeCount(band: string): number {
  if (band.endsWith("+")) {
    const n = parseInt(band, 10);
    return Number.isNaN(n) ? 1 : n + 1;
  }
  const n = parseInt(band, 10);
  return Number.isNaN(n) || n <= 0 ? 1 : n;
}

export default async function EditPostingPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePayer();
  const { id } = await params;
  // Fail closed on a non-uuid segment BEFORE it reaches the authed API path.
  if (!z.string().uuid().safeParse(id).success) notFound();
  // Company-only: an agent's older posting is view-only (owner ruling 2026-10-01) → its details.
  if (session.role === "agent") redirect(`/postings/${id}`);
  const detail = await getPostingDetail(id);
  if (!detail) notFound();

  // The match vocabulary is only needed for the DRAFT publish picker; a fetch failure must not
  // block editing a live posting, so it degrades to an empty list (the picker simply doesn't show).
  let matchSkills: MatchSkillWire[] = [];
  try {
    matchSkills = await listMatchSkills();
  } catch {
    matchSkills = [];
  }

  const { summary, card, description } = detail;

  return (
    <>
      <PageHeader
        back={{ href: `/postings/${id}`, label: "Posting details" }}
        title="Edit posting"
        description={`Change the role, location, pay, timing, chips or description for ${summary.roleTitle} — the preview shows the worker’s card as you edit.`}
      />
      <EditPostingForm
        postingId={id}
        status={summary.status}
        matchSkills={matchSkills}
        matchSelection={{
          matchSkillIds: detail.matchSkillIds,
          untickedRelatedIds: detail.untickedRelatedIds,
        }}
        initial={{
          roleTitle: summary.roleTitle,
          vacanciesHint: bandRepresentativeCount(summary.vacancyBand),
          locationLabel: summary.locationLabel,
          description,
          roleKind: card.role_kind,
          city: card.city,
          area: card.area,
          payMin: card.pay_min,
          payMax: card.pay_max,
          payType: card.pay_type,
          minExperienceYears: card.min_experience_years,
          maxExperienceYears: card.max_experience_years,
          shift: card.shift,
          neededBy: card.needed_by,
          requirements: card.requirements,
          benefits: card.benefits,
        }}
      />
    </>
  );
}
