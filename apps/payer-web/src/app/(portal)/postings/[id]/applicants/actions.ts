"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePayer } from "../../../../../lib/auth";
import {
  requestUnlock,
  reveal,
  revealMaskedResume,
  setApplicantStage,
} from "../../../../../lib/payer-api";
import { isPayerRateLimited } from "../../../../../lib/payer-errors";
import { APPLICANT_STAGES, type ApplicantStage } from "../../../../../lib/applicant-stages";
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

/**
 * SAVED STAGE (owner ruling 2026-10-07; API #2137): move one applicant on a posting's New /
 * Shortlist / Passed board. The board (applicant-actions.tsx) calls this ONLY when its rows came
 * with a `stage` — the server saves stages; without one the board is local and never calls it.
 *
 *  - SESSION FIRST: {@link requirePayer} before anything is read or sent (no session → /login).
 *    XB-A: the client names only the posting (`jobId`, a company posting's or an agency job's id),
 *    the opaque worker id and the stage — never a payer id; the server checks ownership.
 *  - VALIDATED: ids are UUIDs and the stage one of the three (`.strict()`: an extra key is refused
 *    here, as the API's body is strict) — a malformed call never reaches the API.
 *  - THE ANSWER IS THE SERVER'S: success returns the stage the server now holds, which the board
 *    reconciles to. A failure returns a REASON, never a message the API wrote:
 *     · `gone` — the neutral 404 (not the payer's posting, the applicant no longer on its feed, or
 *       stages no longer saved: one answer, no oracle). The list is out of date, so this
 *       revalidates the portal's pages: the response carries the page re-rendered from fresh
 *       reads, and the board rolls the move back on the list as it now is;
 *     · `rate-limited` — the stage route's own hourly cap (or its fail-closed path);
 *     · `failed` — anything else (a refused request, a 5xx, an unreadable answer).
 *    Only `gone` revalidates: a saved move needs no re-read (the board already shows it), and
 *    every re-read of a feed spends the payer's hourly reach budget.
 */
export type StageActionResult =
  | { ok: true; stage: ApplicantStage; changed: boolean }
  | { ok: false; reason: "gone" | "rate-limited" | "failed" };

const stageInputSchema = z
  .object({ jobId: uuid, workerId: uuid, stage: z.enum(APPLICANT_STAGES) })
  .strict();

export async function setApplicantStageAction(input: {
  jobId: string;
  workerId: string;
  stage: ApplicantStage;
}): Promise<StageActionResult> {
  await requirePayer();
  const parsed = stageInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "failed" };
  try {
    const change = await setApplicantStage(parsed.data);
    if (change === null) {
      revalidatePath("/", "layout");
      return { ok: false, reason: "gone" };
    }
    return { ok: true, stage: change.stage, changed: change.changed };
  } catch (e) {
    return { ok: false, reason: isPayerRateLimited(e) ? "rate-limited" : "failed" };
  }
}
