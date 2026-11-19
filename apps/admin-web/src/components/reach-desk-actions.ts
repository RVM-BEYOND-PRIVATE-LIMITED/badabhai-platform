"use server";

import { z } from "zod";
import { adminFetch, isAdminRequestError } from "../lib/admin-http";
import { describeAdminActionError } from "../lib/describe-admin-error";
import {
  logReachAttempt,
  resolveReachCase,
  type ReachAttemptResult,
  type ReachCaseDetail,
  type ReachOutcome,
} from "../lib/reach-desk";

export type ReachCaseResult =
  | { ok: true; detail: ReachCaseDetail }
  | { ok: false; error: string };

const reasonSchema = z.string().trim().min(15).max(500);

export async function logAttemptAction(
  caseId: string,
  result: ReachAttemptResult,
): Promise<ReachCaseResult> {
  try {
    return { ok: true, detail: await logReachAttempt(caseId, result) };
  } catch (err) {
    if (isAdminRequestError(err) && err.body?.code === "CASE_RESOLVED") {
      return { ok: false, error: "This case is already closed." };
    }
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function resolveCaseAction(
  caseId: string,
  outcome: ReachOutcome,
  reasonText: string,
): Promise<ReachCaseResult> {
  if (!reasonSchema.safeParse(reasonText).success) {
    return { ok: false, error: "Reason must be 15–500 characters." };
  }
  try {
    return { ok: true, detail: await resolveReachCase(caseId, outcome, reasonText.trim()) };
  } catch (err) {
    if (isAdminRequestError(err) && err.body?.code === "CASE_RESOLVED") {
      return { ok: false, error: "This case is already closed." };
    }
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export type RevealResult = { ok: true; phone: string } | { ok: false; error: string };

const revealSchema = z.object({ worker_id: z.string(), phone: z.string().min(1) });

/**
 * The desk's reveal goes through the EXISTING reason-gated route (`reveal_pii`), with the case
 * id in the note. Nothing here stores the number.
 */
export async function revealWorkerAction(workerId: string, caseId: string): Promise<RevealResult> {
  try {
    const res = await adminFetch(`/admin/workers/${encodeURIComponent(workerId)}/reveal-contact`, {
      method: "POST",
      body: {
        reason_code: "worker_support_callback",
        note: `Reach desk case ${caseId}`.slice(0, 280),
      },
      schema: revealSchema,
    });
    return { ok: true, phone: res.phone };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
