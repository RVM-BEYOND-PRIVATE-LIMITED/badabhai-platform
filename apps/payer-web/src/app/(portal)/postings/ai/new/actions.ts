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

const NOT_FOUND = "That conversation could not be found.";

export type ChatTurnResult =
  | { ok: true; turn: JobPostingChatTurn }
  | { ok: false; error: string };

export type ChatTranscriptResult =
  | { ok: true; transcript: JobPostingChatTranscript }
  | { ok: false; error: string };

export type ChatPublishResult =
  | { ok: true; postingId: string }
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
 * On success the caller routes to the posting's EXISTING detail page — no new detail UI.
 */
export async function publishJobPostingChatAction(input: {
  sessionId: string;
}): Promise<ChatPublishResult> {
  if (!sessionIdSchema.safeParse(input.sessionId).success) {
    return { ok: false, error: NOT_FOUND };
  }
  try {
    const published = await publishJobPostingChatSession(input.sessionId);
    if (!published) return { ok: false, error: NOT_FOUND };
    revalidatePath("/postings");
    return { ok: true, postingId: published.jobPostingId };
  } catch {
    // A 409 (draft not ready / already published) and every transport failure collapse to
    // ONE retryable message — the draft preview already shows what is still missing.
    return { ok: false, error: "Could not publish this posting yet. Please retry." };
  }
}
