"use server";

import { z } from "zod";
import { requestUnlock, reveal, revealMaskedResume } from "../../../../../lib/payer-api";
import {
  mapContactResult,
  mapRevealResult,
  mapUnlockResult,
  type ContactView,
  type RevealView,
  type UnlockView,
} from "../../../../../lib/unlock-view";

/**
 * Server Actions for the unlock + reveal flow (ADR-0010 / ADR-0019 Decision E).
 *
 * SECURITY:
 *  - XB-A: the payer is resolved from the SERVER-HELD session inside the data seam
 *    (the payer JWT). The client supplies only a postingId + opaque workerId, never
 *    a payer id.
 *  - XB-C (no-oracle): the mappers collapse every deny cause to ONE neutral view;
 *    no branch here infers the cause; nothing is logged.
 *  - REVEAL = ROUTED contact handle ONLY (no phone/number anywhere) — LIVE endpoint.
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

/** LIVE: reveal the ROUTED contact handle for a granted unlock the caller owns. */
export type ContactActionResult =
  | { ok: true; view: ContactView }
  | { ok: false; error: string };

export async function revealContactAction(input: {
  unlockId: string;
}): Promise<ContactActionResult> {
  if (!uuid.safeParse(input.unlockId).success) {
    return { ok: false, error: "Invalid request." };
  }
  try {
    const result = await reveal(input);
    return { ok: true, view: mapContactResult(result) };
  } catch {
    return { ok: false, error: "Reveal failed (service unavailable). Please retry." };
  }
}

/**
 * LIVE: the MASKED resume via the payer-authed `POST /payer/resume-disclosures`
 * (XB-E). The posting id rides along as the disclosure's audit context (optional on
 * the wire — validated here when present). Every deny cause maps to the SAME neutral
 * view (XB-C); a transport failure is a retryable error, never fake data.
 */
export type RevealActionResult =
  | { ok: true; view: RevealView }
  | { ok: false; error: string };

export async function maskedResumeAction(input: {
  unlockId: string;
  workerId: string;
  postingId?: string;
}): Promise<RevealActionResult> {
  if (!uuid.safeParse(input.unlockId).success || !uuid.safeParse(input.workerId).success) {
    return { ok: false, error: "Invalid request." };
  }
  if (input.postingId !== undefined && !uuid.safeParse(input.postingId).success) {
    return { ok: false, error: "Invalid request." };
  }
  try {
    const result = await revealMaskedResume(input);
    return { ok: true, view: mapRevealResult(result) };
  } catch {
    return { ok: false, error: "Reveal failed (service unavailable). Please retry." };
  }
}
