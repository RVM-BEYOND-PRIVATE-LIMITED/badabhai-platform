"use server";

import { jobDescriptionDraftInputSchema } from "../../../lib/contracts";
import { draftJobDescription } from "../../../lib/payer-api";

/**
 * Draft the job Description from a Hinglish voice transcript (#2720).
 *
 * Runs SERVER-SIDE because the payer API seam is `server-only` (the bearer lives
 * in an httpOnly cookie). The browser only ever hands over the recognised text.
 *
 * `description: null` is a VALID answer: the poster's own text stands (mock
 * posture, deadline, blocked input, an all-irrelevant transcript, unreachable
 * ai-service). Nothing is stored — the form fills its editable box and the
 * normal create/edit path persists the reviewed text.
 */
export type DraftDescriptionResult =
  | { ok: true; description: string | null; isMock: boolean }
  | { ok: false; error: string };

export async function draftDescriptionAction(input: {
  spokenText: string;
  tradeLabel?: string;
  roleLabel?: string;
}): Promise<DraftDescriptionResult> {
  const parsed = jobDescriptionDraftInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "That voice note could not be read.",
    };
  }
  try {
    const draft = await draftJobDescription(parsed.data);
    return { ok: true, description: draft.description, isMock: draft.isMock };
  } catch {
    return { ok: false, error: "Could not draft the description. Try again." };
  }
}
