"use server";

import { z } from "zod";
import { pausePosting, resumePosting, topUpPostingQuota } from "../../../lib/payer-api";
import type { PostingSummary } from "../../../lib/contracts";

/**
 * Job-management Server Actions (ADR-0019 Phase 1 — WAITING mock).
 *
 * Every action binds to the SERVER-HELD session payer (XB-A) inside the data seam —
 * the client supplies ONLY the posting id, never a payer id. A posting that isn't the
 * caller's returns the SAME neutral not-found (no cross-tenant existence oracle). The
 * underlying job-postings controller is InternalServiceGuard, so these are mock shims
 * until a payer-authed lifecycle endpoint lands (see payer-api.ts ESCALATE notes).
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

export async function topUpQuotaAction(input: { postingId: string }): Promise<PostingActionResult> {
  const valid = parseId(input.postingId);
  if (!valid.ok) return valid;
  try {
    const posting = await topUpPostingQuota({ postingId: input.postingId });
    if (!posting) return { ok: false, error: "That posting could not be found." };
    return { ok: true, posting };
  } catch {
    return { ok: false, error: "Could not top up the quota right now. Please retry." };
  }
}
