"use server";

import {
  createUnlock,
  revealUnlock,
  getPayerCredits,
  type UnlockResult,
  type RevealResult,
} from "@/lib/api";
import {
  mapUnlockResult,
  mapRevealResult,
  isUuid,
  type UnlockView,
  type RevealView,
} from "@/lib/unlock-view";

/**
 * Server Actions for the contact unlock + reveal UI (ADR-0010, Stream A).
 *
 * SECURITY — why this file exists: `POST /unlocks`, `POST /unlocks/:id/reveal`,
 * and `GET /payers/:id/credits` are behind the API's `InternalServiceGuard`. The
 * shared `INTERNAL_SERVICE_TOKEN` is attached server-side by `apiPostInternal` /
 * `apiGetInternal` (read from `process.env`, NEVER `NEXT_PUBLIC_*`). These actions
 * run ONLY on the server (`"use server"`), so the secret never reaches the browser
 * bundle. The client component calls these actions and receives only PII-free,
 * already-mapped view state — never the secret, never a raw API response, never a
 * phone number.
 *
 * NO-LOG (constraint 5): nothing in this path logs the unlock result, the reveal
 * result, the relay handle, or the payer_id. The mappers in `unlock-view.ts`
 * preserve the NO-ORACLE property (every "unavailable" cause is identical).
 */

/** PII-free balance result handed to the client (or an honest error). */
export type CreditsActionResult =
  | { ok: true; balance: number }
  | { ok: false; error: string };

/** Look up the payer's OWN credit balance — the one legitimately-knowable signal. */
export async function fetchPayerCreditsAction(
  payerId: string,
): Promise<CreditsActionResult> {
  if (!isUuid(payerId)) {
    return { ok: false, error: "Enter a valid payer id (UUID)." };
  }
  try {
    const credits = await getPayerCredits(payerId);
    return { ok: true, balance: credits.balance };
  } catch {
    // Do NOT surface the raw error (could hint at guard/secret state). Honest,
    // generic message only — and nothing is logged.
    return {
      ok: false,
      error: "Could not load the payer balance (backend or service token).",
    };
  }
}

/** Unlock view, or an honest error when the action itself throws (network / 401). */
export type UnlockActionResult =
  | { ok: true; view: UnlockView }
  | { ok: false; error: string };

/**
 * Attempt to unlock a candidate for a payer. Returns the mapped view — granted or
 * the single neutral state. The cause of an "unavailable" is never disclosed.
 */
export async function unlockContactAction(input: {
  payerId: string;
  workerId: string;
  jobId: string;
}): Promise<UnlockActionResult> {
  if (!isUuid(input.payerId)) {
    return { ok: false, error: "Enter a valid payer id (UUID) first." };
  }
  try {
    const result: UnlockResult = await createUnlock({
      payer_id: input.payerId,
      worker_id: input.workerId,
      job_id: input.jobId,
    });
    return { ok: true, view: mapUnlockResult(result) };
  } catch {
    return {
      ok: false,
      error: "Unlock failed (backend unavailable or service token unset).",
    };
  }
}

/** Reveal view, or an honest error when the action itself throws (network / 401). */
export type RevealActionResult =
  | { ok: true; view: RevealView }
  | { ok: false; error: string };

/**
 * Reveal the ROUTED RELAY HANDLE for a granted unlock. Returns the handle view
 * (relay handle / channel / expiry — never a phone) or the neutral state.
 */
export async function revealContactAction(
  unlockId: string,
): Promise<RevealActionResult> {
  try {
    const result: RevealResult = await revealUnlock(unlockId);
    return { ok: true, view: mapRevealResult(result) };
  } catch {
    return {
      ok: false,
      error: "Reveal failed (backend unavailable or service token unset).",
    };
  }
}
