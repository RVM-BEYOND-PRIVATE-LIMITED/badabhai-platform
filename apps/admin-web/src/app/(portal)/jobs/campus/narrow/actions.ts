"use server";

import { z } from "zod";
import { isAdminRequestError } from "../../../../../lib/admin-http";
import { describeAdminActionError } from "../../../../../lib/describe-admin-error";
import { narrowPosting, type NarrowTradeResult } from "../../../../../lib/campus-narrow";
import {
  NARROWABLE_ROLE_KINDS,
  NARROW_REASON_CODES,
  narrowOutcomeCopy,
} from "../../../../../lib/campus-narrow-view";
import { getJobPosting } from "../../../../../lib/entities";

const narrowBodySchema = z
  .object({
    posting_id: z.string().min(1),
    role_kind: z.enum(NARROWABLE_ROLE_KINDS),
    trade_level: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
    reason_code: z.enum(NARROW_REASON_CODES),
    reason_text: z.string().trim().min(15).max(500),
  })
  .strict();

export type NarrowSaveResult =
  | { ok: true; result: NarrowTradeResult }
  | { ok: false; error: string };

/**
 * The server's own words for a refusal are shown here, deliberately: an operator already signed
 * in and holding `manage_postings` is being told why this job was not narrowed. A 5xx or a
 * transport failure is not a refusal to interpret, so it goes through the usual safe copy.
 */
function refusalMessage(err: unknown): string {
  if (isAdminRequestError(err) && err.status >= 400 && err.status < 500) return err.message;
  return describeAdminActionError(err);
}

/**
 * The job's description, read when the dialog opens.
 *
 * The queue row deliberately carries no description — it is a list of ids and titles — so the
 * dialog reads the one posting it is about. A failure is shown in the dialog; it never blanks
 * the queue.
 */
export async function readNarrowDescriptionAction(
  postingId: string,
): Promise<{ ok: true; description: string | null } | { ok: false; error: string }> {
  try {
    const posting = await getJobPosting(postingId);
    return { ok: true, description: posting.description };
  } catch (err) {
    return { ok: false, error: refusalMessage(err) };
  }
}

/**
 * `POST /admin/postings/:id/narrow-trade`.
 *
 * The API answers 200 with an outcome for every rule; only `changed` leaves the queue. Any other
 * outcome is shown with the queue's own copy (a switched-off trade, a closed job, a job that is
 * no longer on the general skill), and the row stays where it is.
 */
export async function narrowTradeAction(input: unknown): Promise<NarrowSaveResult> {
  const parsed = narrowBodySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Choose a trade and write a reason of at least 15 characters.",
    };
  }

  const { posting_id, role_kind, trade_level, reason_code, reason_text } = parsed.data;
  const body = {
    role_kind,
    ...(trade_level ? { trade_level } : {}),
    reason_code,
    reason_text,
  };
  try {
    const result = await narrowPosting(posting_id, body);
    if (result.outcome !== "changed") {
      return { ok: false, error: narrowOutcomeCopy(result.outcome) };
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: refusalMessage(err) };
  }
}
