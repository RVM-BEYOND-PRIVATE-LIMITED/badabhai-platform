"use server";

import { z } from "zod";
import { adminFetch } from "../../../../lib/admin-http";
import { describeAdminActionError } from "../../../../lib/describe-admin-error";
import {
  WORKER_FLAG_REASON_CODES,
  type WorkerFlagReasonCode,
} from "../../../../lib/admin-action-vocabulary";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";

/** Mirrors `AdminActionsController.flagWorker` / `.unflagWorker` (`flag_worker`). */
const resultSchema = z.object({ target_id: z.string(), changed: z.boolean() });

export async function flagWorkerAction(
  workerId: string,
  reasonCode: WorkerFlagReasonCode,
): Promise<AdminActionOutcome> {
  const parsed = z.enum(WORKER_FLAG_REASON_CODES).safeParse(reasonCode);
  if (!parsed.success) return { ok: false, error: "Choose a reason before flagging." };

  try {
    const res = await adminFetch(`/admin/workers/${encodeURIComponent(workerId)}/flag`, {
      method: "POST",
      body: { reason_code: parsed.data },
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed ? "Worker flagged." : "Already has an open flag — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

const unflagReasonSchema = z.string().trim().min(15).max(500);

export async function unflagWorkerAction(
  workerId: string,
  reasonText: string,
): Promise<AdminActionOutcome> {
  const reason = unflagReasonSchema.safeParse(reasonText);
  if (!reason.success) {
    return { ok: false, error: "Add a reason of 15–500 characters before unflagging." };
  }
  try {
    const res = await adminFetch(`/admin/workers/${encodeURIComponent(workerId)}/unflag`, {
      method: "POST",
      body: { reason_code: "worker_unflag", reason_text: reason.data },
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed ? "Flag cleared." : "No open flag to clear — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
