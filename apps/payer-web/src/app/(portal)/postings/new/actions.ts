"use server";

import { createPostingInputSchema, matchSelectionInputSchema } from "../../../../lib/contracts";
import { createPosting, publishPostingWithMatchSkills } from "../../../../lib/payer-api";
import { isPayerValidationError } from "../../../../lib/payer-errors";
import { mapPostingIssues } from "../../../../lib/posting-field-errors";
import { workerCardGap } from "../../../../lib/worker-card-gap";

/**
 * Create-posting Server Action (PR-B). The posting is bound to the SERVER-HELD session's payer
 * (XB-A) inside `createPosting` — the client never supplies a payer id. Free through launch.
 *
 * `createPostingInputSchema` (mirrored by the form) is the AUTHORITY here: it re-validates the card
 * fields (role_kind + city/pay/experience/shift/needed_by + the screened requirement/benefit chips)
 * AND re-runs the `description` PII screen — so a client that bypasses the inline check still cannot
 * smuggle a phone/email through.
 *
 * THE workerCardGap RULE (owner ruling: CREATE + PUBLISH only) is ALSO re-run here — the server is
 * the gap authority for this action, not just the browser. A thin posting (a card with a hole) is
 * refused BEFORE anything is created, so a live posting always traces to a full card.
 *
 * TWO CALLS, ONE BUTTON (ADR-0036). `POST /payer/job-postings` creates a DRAFT (with every card
 * field); `PATCH` attaches the match skills and publishes. "Post job" is create → publish. A FAILED
 * PUBLISH IS REPORTED AS A DRAFT, NOT A FAILURE (the posting exists — a retry would create a second).
 */
export type CreatePostingResult =
  | { ok: true; postingId: string; published: boolean }
  | {
      ok: false;
      error: string;
      /** Per-field messages from a server validation 400 (#1912), keyed by form field. */
      fieldErrors?: Record<string, string>;
    };

export async function createPostingAction(input: {
  roleKind: string;
  roleTitle: string;
  locationLabel: string;
  description: string;
  vacancies: number;
  city: string;
  area: string;
  payMin?: number;
  payMax?: number;
  payType?: string;
  minExperienceYears?: number;
  maxExperienceYears?: number;
  shift?: string;
  neededBy?: string;
  requirements: string[];
  benefits: string[];
  matchSkillIds: string[];
  untickedRelatedIds: string[];
}): Promise<CreatePostingResult> {
  const parsed = createPostingInputSchema.safeParse({
    roleKind: input.roleKind || undefined,
    roleTitle: input.roleTitle,
    locationLabel: input.locationLabel || undefined,
    description: input.description || undefined,
    vacancies: input.vacancies,
    city: input.city || undefined,
    area: input.area || undefined,
    payMin: input.payMin,
    payMax: input.payMax,
    payType: input.payType,
    minExperienceYears: input.minExperienceYears,
    maxExperienceYears: input.maxExperienceYears,
    shift: input.shift,
    neededBy: input.neededBy,
    requirements: input.requirements.length > 0 ? input.requirements : undefined,
    benefits: input.benefits.length > 0 ? input.benefits : undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }

  // GAP RULE (create/publish only) — the server re-runs it so the browser can never bypass it.
  const gap = workerCardGap({
    roleKind: parsed.data.roleKind ?? null,
    city: parsed.data.city ?? "",
    payMin: parsed.data.payMin ?? null,
    payMax: parsed.data.payMax ?? null,
    payType: parsed.data.payType ?? null,
    expMin: parsed.data.minExperienceYears ?? null,
    expMax: parsed.data.maxExperienceYears ?? null,
    shift: parsed.data.shift ?? null,
    neededBy: parsed.data.neededBy ?? null,
    description: parsed.data.description ?? "",
    requirements: parsed.data.requirements ?? [],
    benefits: parsed.data.benefits ?? [],
  });
  if (gap !== null) {
    return { ok: false, error: `${gap.title}: ${gap.message}` };
  }

  // The match half is validated BEFORE anything is created: a posting with no match skill would
  // publish and reach nobody, so refusing here keeps "published" and "reaching someone" the same.
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
  } catch (e) {
    // #1912 — the server screens the worker-visible text too (it is the authority);
    // a refused `role_title` / `description` comes back as per-field issues. Attach
    // each to the field the payer typed into instead of one generic banner.
    if (isPayerValidationError(e)) {
      const { fieldErrors, rest } = mapPostingIssues(e.issues);
      if (Object.keys(fieldErrors).length > 0) {
        return {
          ok: false,
          error: rest.join("; ") || "Check the highlighted fields.",
          fieldErrors,
        };
      }
    }
    return { ok: false, error: "Could not create the posting right now. Please retry." };
  }

  try {
    const published = await publishPostingWithMatchSkills(postingId, selection.data);
    return { ok: true, postingId, published: published !== null };
  } catch {
    return { ok: true, postingId, published: false };
  }
}
