"use server";

import { createPostingInputSchema, matchSelectionInputSchema } from "../../../../lib/contracts";
import { createPosting, publishPostingWithMatchSkills } from "../../../../lib/payer-api";
import { isPayerValidationError, isPostingTradeRequired } from "../../../../lib/payer-errors";
import {
  mapPostingIssues,
  postingTradeRequiredFieldErrors,
} from "../../../../lib/posting-field-errors";
import { POSTING_TRADE_REQUIRED_MESSAGE } from "../../../../lib/posting-trades";
import { reachAfterPublish } from "../../../../lib/published-reach.server";
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
 *
 * `reached` is the published posting's reach ("Reached N workers"), read via reach-preview right
 * after the publish; null when unpublished or when that read failed (the confirmation then shows
 * no count, never a guessed one).
 *
 * #2645 — A COMPANY JOB IS ALWAYS ONE OF THE 16 TRADES (#2635). The role is REQUIRED here too (the
 * form's check is UX; this is the boundary), and the trade form always rides the create (`{}` when
 * no chip was picked), so the server derives the match set from the trade. A publish the API
 * refuses with `posting_trade_required` leaves the created draft: `tradeRequired` tells the form to
 * open that draft's edit page at its trade picker.
 */
export type CreatePostingResult =
  | {
      ok: true;
      postingId: string;
      published: boolean;
      reached: number | null;
      /** The publish was refused for want of one of the 16 trades (#2635); the draft exists. */
      tradeRequired?: true;
    }
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
  /** Migration 0141 — the display-only rung and the selected chip answers. */
  tradeLevel?: string;
  tradeAnswers?: Record<string, string[]>;
  matchSkillIds: string[];
  untickedRelatedIds: string[];
}): Promise<CreatePostingResult> {
  // #2645 — refused BEFORE anything is created: a job without a trade could never go live.
  if (!input.roleKind) {
    return {
      ok: false,
      error: POSTING_TRADE_REQUIRED_MESSAGE,
      fieldErrors: postingTradeRequiredFieldErrors(),
    };
  }
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
    tradeLevel: input.tradeLevel,
    // Always the trade form (#2645): `{}` still names the trade, so the server derives the set.
    tradeAnswers: input.tradeAnswers ?? {},
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
    const published = (await publishPostingWithMatchSkills(postingId, selection.data)) !== null;
    const reached = published ? await reachAfterPublish(selection.data, parsed.data.roleKind) : null;
    return { ok: true, postingId, published, reached };
  } catch (e) {
    if (isPostingTradeRequired(e)) {
      return { ok: true, postingId, published: false, reached: null, tradeRequired: true };
    }
    return { ok: true, postingId, published: false, reached: null };
  }
}
