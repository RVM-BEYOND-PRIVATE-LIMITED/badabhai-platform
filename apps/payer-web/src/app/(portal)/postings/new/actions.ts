"use server";

import { createPostingInputSchema } from "../../../../lib/contracts";
import { createPosting } from "../../../../lib/payer-api";

/**
 * Create-posting Server Action. The posting is bound to the SERVER-HELD session's
 * payer (XB-A) inside `createPosting` — the client never supplies a payer id. Free
 * through launch (no charge): the price is surfaced from a config flag, never a
 * hardcoded 0 (pricing-config.ts / ADR-0013 escalation).
 */
export type CreatePostingResult =
  | { ok: true; postingId: string }
  | { ok: false; error: string };

export async function createPostingAction(input: {
  roleTitle: string;
  locationLabel: string;
  description: string;
  vacancyBand: string;
}): Promise<CreatePostingResult> {
  const parsed = createPostingInputSchema.safeParse({
    roleTitle: input.roleTitle,
    locationLabel: input.locationLabel || undefined,
    description: input.description || undefined,
    vacancyBand: input.vacancyBand,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  try {
    const posting = await createPosting(parsed.data);
    return { ok: true, postingId: posting.id };
  } catch {
    return { ok: false, error: "Could not create the posting right now. Please retry." };
  }
}
