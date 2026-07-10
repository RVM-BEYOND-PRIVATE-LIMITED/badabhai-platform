"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import {
  closePosting,
  pausePosting,
  resumePosting,
  topUpPostingQuota,
  QuotaTopUpNoPlanError,
} from "../../../lib/payer-api";
import type { PostingSummary } from "../../../lib/contracts";

/**
 * Job-management Server Actions (ADR-0019 Phase 1 — LIVE).
 *
 * Every action binds to the SERVER-HELD session payer (XB-A) inside the data seam —
 * the client supplies ONLY the posting id, never a payer id. All four lifecycle routes
 * are the payer-authed `POST /payer/job-postings/:id/{pause|resume|quota-topup|close}`
 * (#178/#180): a posting that isn't the caller's returns the SAME neutral not-found
 * (no cross-tenant existence oracle), and a backend failure surfaces as an error —
 * never as fake data (the mock store is gone from this surface).
 */

export type PostingActionResult =
  | { ok: true; posting: PostingSummary }
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
    revalidatePath("/postings");
    return { ok: true, posting };
  } catch {
    // 409 (not open) and every transport failure collapse to ONE retryable message.
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
    revalidatePath("/postings");
    return { ok: true, posting };
  } catch {
    return { ok: false, error: "Could not resume the posting right now. Please retry." };
  }
}

/** Quota top-up result: success carries a NOTICE (the paid effect is otherwise invisible
 * on the faceless row) and the fresh posting when the re-read succeeded. */
export type TopUpQuotaActionResult =
  | { ok: true; posting: PostingSummary | null; notice: string }
  | { ok: false; error: string };

export async function topUpQuotaAction(input: {
  postingId: string;
}): Promise<TopUpQuotaActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  try {
    const outcome = await topUpPostingQuota({ postingId: input.postingId });
    if (!outcome) return { ok: false, error: "That posting could not be found." };
    revalidatePath("/postings");
    // The charge is committed — say what it bought. A failed fresh-row re-read is NOT a
    // failure (never invite a retry that would double-purchase); tell the user to refresh.
    const notice =
      outcome.posting !== null
        ? `Top-up applied — added ${outcome.addedViews} applicant views.`
        : `Top-up applied (added ${outcome.addedViews} applicant views) — refresh to see it.`;
    return { ok: true, posting: outcome.posting, notice };
  } catch (e) {
    // The ONE distinguishable business deny (409, no active plan): actionable copy.
    // Not an existence oracle — the neutral not-found above already covered ownership.
    if (e instanceof QuotaTopUpNoPlanError) {
      return { ok: false, error: "This posting has no active plan yet — buy a plan first." };
    }
    return { ok: false, error: "Could not top up the quota right now. Please retry." };
  }
}

/** Close one of the caller's OWN postings (terminal; LIVE). Same neutrality contract. */
export async function closePostingAction(input: {
  postingId: string;
}): Promise<PostingActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  try {
    const posting = await closePosting(input.postingId);
    if (!posting) return { ok: false, error: "That posting could not be found." };
    revalidatePath("/postings");
    return { ok: true, posting };
  } catch {
    return { ok: false, error: "Could not close the posting right now. Please retry." };
  }
}
