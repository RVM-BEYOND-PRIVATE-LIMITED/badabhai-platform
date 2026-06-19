"use server";

import { z } from "zod";
import { requestUnlock, revealMaskedResume } from "../../../../../lib/payer-api";
import {
  mapRevealResult,
  mapUnlockResult,
  type RevealView,
  type UnlockView,
} from "../../../../../lib/unlock-view";

/**
 * Server Actions for the unlock + masked-reveal flow (ADR-0010 / resume-disclosure
 * addendum, re-run for the external payer in ADR-0019 Decision E).
 *
 * SECURITY:
 *  - XB-A: the payer is resolved from the SERVER-HELD session inside the data seam;
 *    the client supplies only a postingId + opaque workerId, never a payer id.
 *  - XB-C (no-oracle): the mappers collapse every deny cause to ONE neutral view;
 *    no branch here infers the cause; nothing is logged.
 *  - XB-E: the reveal returns masked initials + a masked-PDF link + NO phone.
 *  - XB-D: there is NO bulk endpoint — one (posting, worker) per call.
 */

const uuid = z.string().uuid();

export type UnlockActionResult =
  | { ok: true; view: UnlockView }
  | { ok: false; error: string };

export async function unlockAction(input: {
  postingId: string;
  workerId: string;
}): Promise<UnlockActionResult> {
  if (!uuid.safeParse(input.postingId).success || !uuid.safeParse(input.workerId).success) {
    return { ok: false, error: "Invalid request." };
  }
  try {
    const result = await requestUnlock(input);
    return { ok: true, view: mapUnlockResult(result) };
  } catch {
    return { ok: false, error: "Unlock failed (service unavailable). Please retry." };
  }
}

export type RevealActionResult =
  | { ok: true; view: RevealView }
  | { ok: false; error: string };

export async function revealAction(input: {
  unlockId: string;
}): Promise<RevealActionResult> {
  if (!uuid.safeParse(input.unlockId).success) {
    return { ok: false, error: "Invalid request." };
  }
  try {
    const result = await revealMaskedResume(input);
    return { ok: true, view: mapRevealResult(result) };
  } catch {
    return { ok: false, error: "Reveal failed (service unavailable). Please retry." };
  }
}
