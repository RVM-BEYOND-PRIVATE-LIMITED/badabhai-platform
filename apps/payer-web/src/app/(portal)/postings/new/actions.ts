"use server";

import { createPostingInputSchema, matchSelectionInputSchema } from "../../../../lib/contracts";
import { createPosting, publishPostingWithMatchSkills } from "../../../../lib/payer-api";

/**
 * Create-posting Server Action. The posting is bound to the SERVER-HELD session's
 * payer (XB-A) inside `createPosting` — the client never supplies a payer id. Free
 * through launch (no charge): the price is surfaced from a config flag, never a
 * hardcoded 0 (pricing-config.ts / ADR-0013 escalation).
 *
 * `createPostingInputSchema` (mirrored by the action's server Zod) stays the AUTHORITY
 * here: it re-validates the demand fields the form mirrors (trade enum, ordered C10-
 * bounded pay/experience, raw `vacancies`) AND re-runs the `description` PII screen
 * (`looksLikePii`) — so a client that bypasses the inline check still cannot smuggle a
 * phone/email through.
 *
 * TWO CALLS, ONE BUTTON (ADR-0036). `POST /payer/job-postings` creates a DRAFT and does
 * not accept match skills; `PATCH` attaches them and publishes. So "Post job" is create
 * → publish, in that order, and only the PATCH makes the posting visible to a worker.
 * Splitting them across two screens was the alternative and it is worse: a draft with no
 * match skills reaches NOBODY and looks identical on the list to one that reaches
 * hundreds, so a payer who stopped halfway would believe they had posted a job.
 *
 * A FAILED PUBLISH IS REPORTED AS A DRAFT, NOT AS A FAILURE. The posting exists at that
 * point; claiming the create failed would invite a retry that creates a second one.
 */
export type CreatePostingResult =
  | { ok: true; postingId: string; published: boolean }
  | { ok: false; error: string };

export async function createPostingAction(input: {
  tradeKey: string;
  roleTitle: string;
  locationLabel: string;
  description: string;
  vacancies: number;
  payMin?: number;
  payMax?: number;
  minExperienceYears?: number;
  maxExperienceYears?: number;
  matchSkillIds: string[];
  untickedRelatedIds: string[];
}): Promise<CreatePostingResult> {
  const parsed = createPostingInputSchema.safeParse({
    tradeKey: input.tradeKey,
    roleTitle: input.roleTitle,
    locationLabel: input.locationLabel || undefined,
    description: input.description || undefined,
    vacancies: input.vacancies,
    payMin: input.payMin,
    payMax: input.payMax,
    minExperienceYears: input.minExperienceYears,
    maxExperienceYears: input.maxExperienceYears,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }

  // The match half is validated BEFORE anything is created: a posting with no match
  // skills can be published and would simply reach nobody, so refusing here is what
  // keeps "published" and "reaching someone" the same thing on this path.
  const selection = matchSelectionInputSchema.safeParse({
    matchSkillIds: input.matchSkillIds,
    untickedRelatedIds: input.untickedRelatedIds,
  });
  if (!selection.success) {
    return { ok: false, error: "Pick at least one skill so workers can find this job." };
  }

  let postingId: string;
  try {
    postingId = (await createPosting(parsed.data)).id;
  } catch {
    return { ok: false, error: "Could not create the posting right now. Please retry." };
  }

  try {
    const published = await publishPostingWithMatchSkills(postingId, selection.data);
    // `null` is the neutral 404 — impossible for a posting we just created as this
    // payer, but it is not a publish either, so it is reported honestly as a draft.
    return { ok: true, postingId, published: published !== null };
  } catch {
    return { ok: true, postingId, published: false };
  }
}
