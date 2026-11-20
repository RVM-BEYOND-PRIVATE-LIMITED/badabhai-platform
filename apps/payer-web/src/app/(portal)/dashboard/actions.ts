"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePayer } from "../../../lib/auth";
import { recordUnlockOutcome } from "../../../lib/payer-api";
import { isPayerRateLimited, isPayerStatus, PayerConflictError } from "../../../lib/payer-errors";
import {
  unlockCompanyOutcomeSchema,
  type UnlockCompanyOutcome,
  type UnlockOutcome,
} from "../../../lib/contracts";

/**
 * #2984 §4 — the company's answer to "Did you hire this person?".
 *
 * A Server Action is an independently invocable POST endpoint, so `requirePayer()` runs FIRST —
 * before validation and before the seam. The body it accepts is the whole intent: one unlock id,
 * one closed outcome and the caller's per-intent idempotency key. Nothing else may ride along
 * (`.strict()`): there is no slot for a payer id (XB-A), a worker, a posting, a note or a date.
 *
 * Failures are a closed reason union, never the API's text:
 *  - `not_found` — the neutral 404 (the switch is off, or the unlock is not this tenant's): the
 *    card hides itself.
 *  - `rate_limited` / `in_flight` / `unavailable` — retryable; the row stays and the client can
 *    reuse the SAME idempotency key.
 *  - `invalid_request` — the input was refused before any network.
 */

const inputSchema = z
  .object({
    unlockId: z.string().uuid(),
    outcome: unlockCompanyOutcomeSchema,
    idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();

export type UnlockOutcomeFailureReason =
  | "invalid_request"
  | "not_found"
  | "rate_limited"
  | "in_flight"
  | "unavailable";

export type RecordUnlockOutcomeActionResult =
  | {
      ok: true;
      unlockId: string;
      outcome: UnlockCompanyOutcome;
      previousOutcome: UnlockOutcome | null;
      answeredAt: string;
      changed: boolean;
    }
  | { ok: false; reason: UnlockOutcomeFailureReason; error: string };

const COPY: Record<UnlockOutcomeFailureReason, string> = {
  invalid_request: "That answer wasn’t valid. Please retry.",
  not_found: "This follow-up is no longer available.",
  rate_limited: "Too many answers right now. Please try again later.",
  in_flight: "We’re already saving that answer. Please retry.",
  unavailable: "Couldn’t save that answer. Please retry.",
};

export async function recordUnlockOutcomeAction(input: {
  unlockId: string;
  outcome: UnlockCompanyOutcome;
  idempotencyKey: string;
}): Promise<RecordUnlockOutcomeActionResult> {
  await requirePayer(); // GATE FIRST — authorization precedes validation and the seam.

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_request", error: COPY.invalid_request };
  }

  try {
    const recorded = await recordUnlockOutcome(parsed.data);
    // Only the dashboard holds this control; nothing else is rebuilt.
    revalidatePath("/dashboard");
    return {
      ok: true,
      unlockId: recorded.unlockId,
      outcome: recorded.outcome,
      previousOutcome: recorded.previousOutcome,
      answeredAt: recorded.answeredAt,
      changed: recorded.changed,
    };
  } catch (e) {
    const reason = failureReason(e);
    return { ok: false, reason, error: COPY[reason] };
  }
}

/** The closed reason for a refused write — statuses and one machine-readable 409 only. */
function failureReason(e: unknown): UnlockOutcomeFailureReason {
  if (isPayerStatus(e, 404)) return "not_found";
  if (isPayerRateLimited(e)) return "rate_limited";
  if (e instanceof PayerConflictError) return "in_flight";
  if (isPayerStatus(e, 400)) return "invalid_request";
  return "unavailable";
}
