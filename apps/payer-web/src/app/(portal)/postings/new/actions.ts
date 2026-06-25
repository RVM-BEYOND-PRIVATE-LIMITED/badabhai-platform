"use server";

import { createPostingInputSchema } from "../../../../lib/contracts";
import { createPosting } from "../../../../lib/payer-api";

/**
 * Create-posting Server Action. The posting is bound to the SERVER-HELD session's
 * payer (XB-A) inside `createPosting` — the client never supplies a payer id. Free
 * through launch (no charge): the price is surfaced from a config flag, never a
 * hardcoded 0 (pricing-config.ts / ADR-0013 escalation).
 *
 * `createPostingInputSchema` is the SERVER-side AUTHORITY here: it re-validates the
 * demand fields the form mirrors (trade enum, ordered C10-bounded pay/experience, raw
 * `vacancies`) AND re-runs the `description` PII screen (`looksLikePii`) — so a client
 * that bypasses the inline check still cannot smuggle a phone/email through.
 */
export type CreatePostingResult =
  | { ok: true; postingId: string }
  | { ok: false; error: string };

export async function createPostingAction(input: {
  tradeKey: string;
  roleTitle: string;
  locationLabel: string;
  description: string;
  vacancies: number;
  payMin?: number;
  payMax?: number;
  minExperienceYears?: number;
  maxExperienceYears?: number;
}): Promise<CreatePostingResult> {
  const parsed = createPostingInputSchema.safeParse({
    tradeKey: input.tradeKey,
    roleTitle: input.roleTitle,
    locationLabel: input.locationLabel || undefined,
    description: input.description || undefined,
    vacancies: input.vacancies,
    payMin: input.payMin,
    payMax: input.payMax,
    minExperienceYears: input.minExperienceYears,
    maxExperienceYears: input.maxExperienceYears,
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
