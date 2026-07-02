"use server";

import { z } from "zod";
import { pausePosting, resumePosting, topUpPostingQuota } from "../../../lib/payer-api";
import { quotaTopUpTiers } from "../../../lib/pricing-config";
import type { PostingQuotaResult, PostingSummary } from "../../../lib/contracts";

/**
 * Job-management Server Actions (ADR-0019 Phase 1).
 *
 * Every action binds to the SERVER-HELD session payer (XB-A) inside the data seam —
 * the client supplies ONLY the posting id (+ a config'd tier code for the top-up), never a
 * payer id. A posting that isn't the caller's returns the SAME neutral not-found (no
 * cross-tenant existence oracle). PAUSE/RESUME stay mock shims (the backend lifecycle has no
 * `paused` state); the QUOTA TOP-UP is now LIVE (POST /payer/job-postings/:id/quota-topup, #180).
 */

export type PostingActionResult =
  | { ok: true; posting: PostingSummary }
  | { ok: false; error: string };

/** The LIVE quota top-up result — the REAL raised applicant quota, or a neutral failure. */
export type QuotaTopUpActionResult =
  | { ok: true; quota: PostingQuotaResult }
  | { ok: false; error: string };

const postingIdSchema = z.string().uuid();

function parseId(postingId: string): { ok: true } | { ok: false; error: string } {
  return postingIdSchema.safeParse(postingId).success
    ? { ok: true }
    : { ok: false, error: "That posting could not be found." };
}

export async function pausePostingAction(input: {
  postingId: string;
}): Promise<PostingActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  try {
    const posting = await pausePosting({ postingId: input.postingId });
    if (!posting) return { ok: false, error: "That posting could not be found." };
    return { ok: true, posting };
  } catch {
    return { ok: false, error: "Could not pause the posting right now. Please retry." };
  }
}

export async function resumePostingAction(input: {
  postingId: string;
}): Promise<PostingActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  try {
    const posting = await resumePosting({ postingId: input.postingId });
    if (!posting) return { ok: false, error: "That posting could not be found." };
    return { ok: true, posting };
  } catch {
    return { ok: false, error: "Could not resume the posting right now. Please retry." };
  }
}

/**
 * LIVE applicant-quota top-up (B2 / #180). Input is `{ postingId, tier }` — the `tier` is a
 * CONFIG'd quota-top-up tier CODE (validated against the catalog; an arbitrary string is rejected
 * neutrally, never forwarded). The seam prices it server-side and binds the posting via the PATH +
 * the session payer (XB-A: no payer_id ever leaves the client). A foreign/unknown posting OR a
 * posting with no active plan to top up returns a neutral not-available. Money is MOCK.
 */
export async function topUpQuotaAction(input: {
  postingId: string;
  tier: string;
}): Promise<QuotaTopUpActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  // Value guard (NOT authz): the tier must be one of the config'd quota-top-up codes.
  if (!quotaTopUpTiers().some((t) => t.code === input.tier)) {
    return { ok: false, error: "Choose a top-up tier." };
  }
  try {
    const quota = await topUpPostingQuota({ postingId: input.postingId, tier: input.tier });
    if (!quota) return { ok: false, error: "Applicant top-up isn't available for this posting yet." };
    return { ok: true, quota };
  } catch {
    return { ok: false, error: "Could not top up the quota right now. Please retry." };
  }
}
