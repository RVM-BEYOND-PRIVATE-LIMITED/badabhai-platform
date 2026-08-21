"use server";

import { z } from "zod";
import { adminFetch } from "../../../../lib/admin-http";
import { describeAdminActionError } from "../../../../lib/describe-admin-error";
import type { AdminActionOutcome } from "../../../../lib/admin-action-result";

/** Mirrors `AdminActionsController.forceClosePosting` (`force_close_posting`). */
const resultSchema = z.object({ target_id: z.string(), changed: z.boolean() });

export async function forceClosePostingAction(postingId: string): Promise<AdminActionOutcome> {
  try {
    const res = await adminFetch(`/admin/job-postings/${encodeURIComponent(postingId)}/close`, {
      method: "POST",
      schema: resultSchema,
    });
    return {
      ok: true,
      changed: res.changed,
      message: res.changed
        ? "Posting force-closed. It is out of the worker feed."
        : "Already closed — no change.",
    };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
