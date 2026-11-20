"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePayer } from "../../../../../lib/auth";
import {
  getApplicantStageOptions,
  getCredits,
  getUnlockContact,
  requestUnlock,
  reveal,
  revealMaskedResume,
  setApplicantStage,
} from "../../../../../lib/payer-api";
import type { BalanceReading } from "../../../../../lib/contracts";
import { isPayerRateLimited, isPayerStatus } from "../../../../../lib/payer-errors";
import { APPLICANT_STAGES, type ApplicantStage } from "../../../../../lib/applicant-stages";
import {
  mapContactLookup,
  mapContactResult,
  mapRevealResult,
  mapUnlockResult,
  NEUTRAL_UNLOCK_MESSAGE,
  type ContactLookupView,
  type ContactView,
  type RevealView,
  type UnlockView,
} from "../../../../../lib/unlock-view";
import type { ApplicantStageOptions } from "../../../../../lib/contracts";

/**
 * Server Actions for the unlock + reveal flow (ADR-0010 / ADR-0019 Decision E).
 *
 * SECURITY:
 *  - XB-A: the payer is resolved from the SERVER-HELD session inside the data seam
 *    (the payer JWT). The client supplies only a postingId + opaque workerId (a search
 *    row's unlock: the workerId alone), never a payer id.
 *  - XB-C (no-oracle): the mappers collapse every deny cause to ONE neutral view;
 *    no branch here infers the cause; nothing is logged.
 *  - REVEAL = ROUTED contact handle ONLY (no phone/number anywhere) — LIVE endpoint.
 *  - XB-D: there is NO bulk endpoint — one (posting, worker) per call.
 */

const uuid = z.string().uuid();

/**
 * `readBack` (#2585): the payer's OWN balance, read back from `GET /payer/credits` right after a
 * GRANT, with when this server read it (`asOf`) — so the screen's zero-balance checks and the
 * shell's credits chip show what the unlock left, with no reload, and outrank any figure read
 * before it (components/live-balance.ts). Null when nothing was granted (no read is made) or the
 * read failed (the grant still stands; the screens keep the figure they had). Never computed: the
 * unlock response carries no balance, and only the server knows what a grant cost (re-granting a
 * live one is free).
 */
export type UnlockActionResult =
  | { ok: true; view: UnlockView; readBack: BalanceReading | null }
  | { ok: false; error: string };

export async function unlockAction(input: {
  postingId: string;
  workerId: string;
}): Promise<UnlockActionResult> {
  if (!uuid.safeParse(input.postingId).success || !uuid.safeParse(input.workerId).success) {
    return { ok: false, error: "Invalid request." };
  }
  return spendUnlock(input.postingId, input.workerId);
}

/**
 * The SAME unlock for a candidate found through the all-candidates search (`/candidates`, ADR-0040
 * E2): he applied to no posting, so there is no job context — `job_id` goes out as an explicit
 * null (the API's own default). The client names only the opaque worker id; the server still
 * decides every spend (the one neutral body for every deny cause, F-3).
 *
 * `isSample` is the row's own flag (R74): a sample row is refused HERE with the API's own neutral
 * view and no network call. Never sent on — the API refuses a sample unlock regardless.
 */
export async function candidateUnlockAction(input: {
  workerId: string;
  isSample: boolean;
}): Promise<UnlockActionResult> {
  if (!uuid.safeParse(input.workerId).success || typeof input.isSample !== "boolean") {
    return { ok: false, error: "Invalid request." };
  }
  if (input.isSample) {
    return {
      ok: true,
      view: { kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE },
      readBack: null,
    };
  }
  return spendUnlock(null, input.workerId);
}

/**
 * One ids-only unlock call — the posting context, or null for none — mapped to its view; a grant
 * also reads the balance back. A neutral answer reads nothing: nothing was granted, so nothing was
 * spent (and no balance ever travels beside a deny).
 */
async function spendUnlock(postingId: string | null, workerId: string): Promise<UnlockActionResult> {
  let view: UnlockView;
  try {
    view = mapUnlockResult(await requestUnlock({ postingId, workerId }));
  } catch {
    return { ok: false, error: "Unlock failed (service unavailable). Please retry." };
  }
  if (view.kind === "granted") {
    return { ok: true, view, readBack: await balanceAfterGrant() };
  }
  if (view.kind === "insufficient") {
    // The refusal carries the company's own spendable balance; publish it at once.
    return {
      ok: true,
      view,
      readBack: { balance: view.creditsAvailable, asOf: Date.now() },
    };
  }
  return { ok: true, view, readBack: null };
}

/**
 * The balance a grant left: `GET /payer/credits`, the payer's own (not reach-capped), stamped with
 * this server's clock just before the read. Null on a failed read.
 */
async function balanceAfterGrant(): Promise<BalanceReading | null> {
  const asOf = Date.now();
  try {
    return { balance: (await getCredits()).balance, asOf };
  } catch {
    return null;
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

/** #2747 — the contact read's outcome: the typed view, or a polite retry reason. */
export type UnlockContactActionResult =
  | { ok: true; view: ContactLookupView }
  | { ok: false; error: "limited" | "failed" };

/**
 * #2747 — read what a credit opens, EVERY time the contact screen opens. The response is
 * `no-store`; this action returns it to the screen and nothing here caches, stores or logs it (no
 * name, no number, no body). A 404 is the rule being off for the company and maps to `off`; the
 * neutral 200 body says nothing new; a 429 is the hourly disclosure cap.
 */
export async function readUnlockContactAction(input: {
  unlockId: string;
}): Promise<UnlockContactActionResult> {
  await requirePayer();
  if (!uuid.safeParse(input.unlockId).success) {
    return { ok: false, error: "failed" };
  }
  try {
    return { ok: true, view: mapContactLookup(await getUnlockContact(input.unlockId)) };
  } catch (e) {
    return { ok: false, error: isPayerRateLimited(e) ? "limited" : "failed" };
  }
}

/**
 * #2747 — `GET /payer/reach/applicant-stages`, read once per board load (and again after a 400
 * on an outcome move). Null while the board flag is off or the read failed: the screen then draws
 * today's board.
 */
export async function applicantStageOptionsAction(): Promise<ApplicantStageOptions | null> {
  await requirePayer();
  try {
    return await getApplicantStageOptions();
  } catch {
    return null;
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
  | {
      ok: false;
      reason: "gone" | "rate-limited" | "stage-not-open" | "unavailable" | "failed";
    };

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
    if (isPayerRateLimited(e)) return { ok: false, reason: "rate-limited" };
    // #2747: a 400 on an outcome stage means the switch is not open for this company (the same
    // body the route always gave for a value outside the three); a 503 means the pilot list could
    // not be read, so nothing was saved. Both put the row back.
    if (isPayerStatus(e, 400)) return { ok: false, reason: "stage-not-open" };
    if (isPayerStatus(e, 503)) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "failed" };
  }
}
