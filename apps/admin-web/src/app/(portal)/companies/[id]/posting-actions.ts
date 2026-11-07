"use server";

import { z } from "zod";
import { adminFetch } from "../../../../lib/admin-http";
import { describeAdminActionError } from "../../../../lib/describe-admin-error";
import { getJobPosting, type JobPostingDetail } from "../../../../lib/entities";
import type { AdminActionFailure, AdminActionSuccess } from "../../../../lib/admin-action-result";

/**
 * Admin posting control from a company's Postings tab (A9, #2579; API #2566).
 *
 * One route family, one capability (`manage_postings`). Every write carries a closed reason code
 * and a 15–500 character note; the API commits the SoR change, `audit_logs`, one
 * `admin.action_performed` and the domain event in one transaction.
 */

const REASON_MIN = 15;
const REASON_MAX = 500;

export interface PostingReasonInput {
  reasonCode: string;
  reasonText: string;
}

const reasonSchema = z.object({
  reason_code: z.string().min(1).max(64),
  reason_text: z.string().trim().min(REASON_MIN).max(REASON_MAX),
});

const resultSchema = z.object({
  target_id: z.string(),
  entity_type: z.enum(["job_posting", "job"]),
  changed: z.boolean(),
});

export interface PostingWriteSuccess extends AdminActionSuccess {
  targetId: string;
  entityType: "job_posting" | "job";
}
export type PostingWriteOutcome = PostingWriteSuccess | AdminActionFailure;

function reasonBody(reason: PostingReasonInput) {
  return reasonSchema.safeParse({
    reason_code: reason.reasonCode,
    reason_text: reason.reasonText,
  });
}

async function write(
  postingId: string,
  path: "edit" | "pause" | "resume" | "close" | "hide" | "unhide" | "verify" | "reject",
  reason: PostingReasonInput,
  body: Record<string, unknown> = {},
  success: string,
  noChange: string,
): Promise<PostingWriteOutcome> {
  const parsed = reasonBody(reason);
  if (!parsed.success) {
    return { ok: false, error: `Explain the reason in at least ${REASON_MIN} characters.` };
  }
  try {
    const res = await adminFetch(`/admin/postings/${encodeURIComponent(postingId)}/${path}`, {
      method: path === "edit" ? "PATCH" : "POST",
      body: { ...parsed.data, ...body },
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      targetId: res.target_id,
      entityType: res.entity_type,
      message: res.changed ? success : noChange,
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function hidePostingAction(
  postingId: string,
  reason: PostingReasonInput,
): Promise<PostingWriteOutcome> {
  return write(
    postingId,
    "hide",
    reason,
    {},
    "Posting hidden from the worker feed and every search.",
    "Already hidden — no change.",
  );
}

export async function unhidePostingAction(
  postingId: string,
  reason: PostingReasonInput,
): Promise<PostingWriteOutcome> {
  return write(
    postingId,
    "unhide",
    reason,
    {},
    "Posting visible again.",
    "Not hidden — no change.",
  );
}

export async function pausePostingAction(
  postingId: string,
  reason: PostingReasonInput,
): Promise<PostingWriteOutcome> {
  return write(
    postingId,
    "pause",
    reason,
    {},
    "Posting paused.",
    "Already paused — no change.",
  );
}

export async function resumePostingAction(
  postingId: string,
  reason: PostingReasonInput,
): Promise<PostingWriteOutcome> {
  return write(
    postingId,
    "resume",
    reason,
    {},
    "Posting resumed.",
    "Already open — no change.",
  );
}

export async function closePostingAction(
  postingId: string,
  reason: PostingReasonInput,
): Promise<PostingWriteOutcome> {
  return write(
    postingId,
    "close",
    reason,
    {},
    "Posting closed. A closed posting cannot be reopened.",
    "Already closed — no change.",
  );
}

export async function verifyPostingAction(
  postingId: string,
  reason: PostingReasonInput,
): Promise<PostingWriteOutcome> {
  return write(
    postingId,
    "verify",
    reason,
    {},
    "Posting verified.",
    "Already verified — no change.",
  );
}

export async function rejectPostingAction(
  postingId: string,
  reason: PostingReasonInput,
): Promise<PostingWriteOutcome> {
  return write(
    postingId,
    "reject",
    reason,
    {},
    "Posting rejected in trust review.",
    "Already rejected — no change.",
  );
}

export async function editPostingAction(
  postingId: string,
  changes: Record<string, unknown>,
  reason: PostingReasonInput,
): Promise<PostingWriteOutcome> {
  if (Object.keys(changes).length === 0) {
    return { ok: false, error: "Change a field before saving." };
  }
  return write(
    postingId,
    "edit",
    reason,
    { changes },
    "Posting updated.",
    "No change — the posting already matched.",
  );
}

export interface PostingDetailOutcome {
  ok: boolean;
  posting?: JobPostingDetail;
  error?: string;
}

/** Read a posting's full card for the edit drawer (a Server Action: not a page render read). */
export async function readPostingDetailAction(
  postingId: string,
): Promise<PostingDetailOutcome> {
  try {
    return { ok: true, posting: await getJobPosting(postingId) };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export interface PostingApplicantCount {
  applied: number;
  skipped: number;
  total: number;
}

export type PostingApplicantOutcome =
  | { ok: true; counts: PostingApplicantCount }
  | { ok: false; error: string };

/**
 * How many workers have acted on a posting. Hiding is a T1 action for a posting nobody has
 * seen, and a reason-gated consequential one once applicants exist.
 */
export async function readPostingApplicantCountAction(
  postingId: string,
): Promise<PostingApplicantOutcome> {
  try {
    const posting = await getJobPosting(postingId);
    const applied = posting.applied_count;
    const skipped = posting.skipped_count;
    return { ok: true, counts: { applied, skipped, total: applied + skipped } };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
