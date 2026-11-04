"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import {
  jobPostingChatMessageInputSchema,
  type JobPostingChatTranscript,
  type JobPostingChatTurn,
} from "../../../../../lib/contracts";
import {
  getJobPostingChatTranscript,
  publishJobPostingChatSession,
  sendJobPostingChatMessage,
  startJobPostingChatSession,
} from "../../../../../lib/payer-api";
import { isPayerValidationError } from "../../../../../lib/payer-errors";
import { roleKindInputSchema } from "../../../../../lib/job-roles";
import { POSTING_TRADE_REQUIRED_MESSAGE } from "../../../../../lib/posting-trades";

/**
 * AI job-posting chat Server Actions (ADR-0035 — the 5 frozen payer-authed endpoints).
 *
 * Every action binds to the SERVER-HELD session payer (XB-A) inside the data seam: the
 * client passes ONLY a session id + its own typed text, never a payer id and never the
 * company/org name (rule A — the org name is auto-filled server-side at publish and never
 * reaches the LLM).
 *
 * `jobPostingChatMessageInputSchema` is the SERVER-side re-validation of what the client
 * form already screened (length + the `looksLikePii` phone/email heuristic), so a client
 * that bypasses the inline check still cannot smuggle an obvious phone/email into the turn.
 * The backend's fail-closed pseudonymization gateway remains the real authority — this is
 * the same UX-parity screen the manual posting form runs on its description field.
 *
 * NEUTRALITY: an unknown OR not-owned session collapses to the SAME "could not be found"
 * copy the seam's neutral-404 → `null` mapping produces (no cross-tenant existence oracle).
 */

const sessionIdSchema = z.string().uuid();

/** Same cap as the manual `areaSchema`; the publish route re-validates it server-side. */
const areaInputSchema = z.string().trim().min(1).max(120);

const NOT_FOUND = "That conversation could not be found.";

export type ChatTurnResult =
  | { ok: true; turn: JobPostingChatTurn }
  | { ok: false; error: string };

export type ChatTranscriptResult =
  | { ok: true; transcript: JobPostingChatTranscript }
  | { ok: false; error: string };

export type ChatPublishResult =
  /**
   * `unsetCardFields` (#1727) are the worker-card columns the created posting
   * holds NULL. Carried to the client so it can name them: publish never
   * refuses a thin draft, so this is the only place the payer learns which rows
   * of his worker's card are empty.
   */
  | { ok: true; postingId: string; unsetCardFields: string[] }
  | { ok: false; error: string };

/** Start a brand-new chat for the session payer. Body is empty (no payer id, no org name). */
export async function startJobPostingChatAction(): Promise<ChatTurnResult> {
  try {
    const turn = await startJobPostingChatSession();
    return { ok: true, turn };
  } catch {
    return { ok: false, error: "Could not start the chat right now. Please retry." };
  }
}

/** Send one payer turn. The body is exactly `{ session_id, text }` — never a payer id. */
export async function sendJobPostingChatMessageAction(input: {
  sessionId: string;
  text: string;
}): Promise<ChatTurnResult> {
  const parsed = jobPostingChatMessageInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  try {
    const turn = await sendJobPostingChatMessage(parsed.data);
    if (!turn) return { ok: false, error: NOT_FOUND };
    return { ok: true, turn };
  } catch {
    return { ok: false, error: "Could not send that message right now. Please retry." };
  }
}

/**
 * Hydrate a past session's transcript — the CROSS-DEVICE resume path (the conversation may
 * have been started in the payer mobile app; ownership is the account, not the device).
 */
export async function resumeJobPostingChatAction(input: {
  sessionId: string;
}): Promise<ChatTranscriptResult> {
  if (!sessionIdSchema.safeParse(input.sessionId).success) {
    return { ok: false, error: NOT_FOUND };
  }
  try {
    const transcript = await getJobPostingChatTranscript(input.sessionId);
    if (!transcript) return { ok: false, error: NOT_FOUND };
    return { ok: true, transcript };
  } catch {
    return { ok: false, error: "Could not load that conversation right now. Please retry." };
  }
}

/**
 * Publish the session's draft as a REAL job posting (the unchanged `createForPayer` path).
 * On success the caller routes to the posting's EDIT page so any remaining card gaps are named.
 *
 * `roleKind` (#2490) is the publish-step role pick — the same closed set the manual form
 * re-validates. REQUIRED since #2645: it is the draft's trade, and a company job that names none
 * of the 16 can never go live (#2635), so a publish without one is refused here, before anything
 * is sent (the chat checks it against the 16 the API served first). It also picks the card art.
 *
 * `area` (#2493) is the COARSE locality bucket — prefilled from the interview draft and
 * editable at publish. OPTIONAL: absent stores NULL, so the worker card shows the city alone.
 */
export async function publishJobPostingChatAction(input: {
  sessionId: string;
  roleKind?: string;
  area?: string;
}): Promise<ChatPublishResult> {
  if (!sessionIdSchema.safeParse(input.sessionId).success) {
    return { ok: false, error: NOT_FOUND };
  }
  if (!input.roleKind) return { ok: false, error: POSTING_TRADE_REQUIRED_MESSAGE };
  if (!roleKindInputSchema.safeParse(input.roleKind).success) {
    return { ok: false, error: "Pick a valid role." };
  }
  const area = input.area?.trim() || undefined;
  if (area !== undefined && !areaInputSchema.safeParse(area).success) {
    return { ok: false, error: "Keep the area under 120 characters." };
  }
  try {
    const published = await publishJobPostingChatSession(input.sessionId, input.roleKind, area);
    if (!published) return { ok: false, error: NOT_FOUND };
    revalidatePath("/postings");
    return {
      ok: true,
      postingId: published.jobPostingId,
      unsetCardFields: published.unsetCardFields,
    };
  } catch (e) {
    // #1912 — a validation 400 carries `issues[].path` + a static, field-NAMING message
    // (e.g. "remove contact details from the title"). Surface it: the chat has no per-field
    // inputs, so the named message IS the field-level error the payer needs, not the
    // generic retry copy.
    if (isPayerValidationError(e)) {
      const messages = e.issues.map((i) => i.message).filter((m) => m.length > 0);
      if (messages.length > 0) {
        return { ok: false, error: messages.join("; ") };
      }
    }
    // A 409 (draft not ready / already published) and every transport failure collapse to
    // ONE retryable message — the draft preview already shows what is still missing.
    return { ok: false, error: "Could not publish this posting yet. Please retry." };
  }
}
