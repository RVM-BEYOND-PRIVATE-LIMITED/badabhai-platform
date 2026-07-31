"use server";

import { z } from "zod";
import { looksLikeActionContextPii } from "@badabhai/validators";
import { createAgencyInvite } from "../../../../lib/payer-api";
import { requireAgent } from "../../../../lib/auth/roles";

/**
 * Create-invite Server Action (ADR-0022, LIVE).
 *
 * VERTICAL AUTHZ (XB-A / XT3): a Server Action is independently invocable, so it enforces
 * the agent role gate ITSELF — `requireAgent()` is the FIRST statement (an employer hits
 * the SAME neutral notFound() the page does; no oracle).
 *
 * FACELESS: the ONLY input is an optional, non-PII campaign tag — there is NO phone/name/
 * email/worker-id field (the agency never types a contact). The owner `inviter_payer_id`
 * is the SERVER-HELD session (XB-A), stamped server-side. The response is an OPAQUE
 * code/link only.
 *
 * NEUTRAL FAILURE: the per-payer mint cap AND a Redis fail-closed BOTH surface from the
 * seam as the SAME `{ ok: false }` (identical backend 429, no leaked reason) → mapped to
 * ONE neutral error string. We NEVER fake a success and NEVER reveal which cause it was.
 */

/**
 * The campaign tag is PII-screened at the boundary, using the SAME helper as the backend
 * DTO (`campaignTag` in agency.dto.ts) rather than a local regex.
 *
 * WHY THE SHARED HELPER, AND WHY THE STRICTER ONE. This field is written to
 * `agency_invites.campaign` AND emitted in the `agency_invite.created` payload — an
 * invariant-#2 sink. The local regex this replaces mirrored `looksLikePii`, which catches
 * only email shapes and long digit runs, so a worker's NAME typed as a campaign tag passed
 * every screen and landed on the event spine. `looksLikeActionContextPii` adds the
 * name/address shapes.
 *
 * That stricter check is safe HERE specifically because a campaign tag is a short non-PII
 * label ("diwali-drive"), the same shape as the actions-context bag it was written for — not
 * legitimate title-case free text like a job title ("Night Shift Operator"), which is what
 * rules the name check out of the general `looksLikePii`. Scoped to this field on purpose.
 *
 * We name the field, never echo the offending content.
 */
const campaignSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((s) => !looksLikeActionContextPii(s), {
    message: "The campaign tag must be a non-PII label — use a short slug like diwali-drive, never a person's name, phone, or email.",
  });

const NEUTRAL_FAILURE = "Could not create an invite right now. Please try again shortly.";

export type CreateInviteResult =
  | { ok: true; code: string; link: string }
  | { ok: false; error: string };

export async function createInviteAction(input: {
  campaign?: string;
}): Promise<CreateInviteResult> {
  await requireAgent(); // role gate FIRST — employer → neutral notFound().

  let campaign: string | undefined;
  const raw = input.campaign?.trim();
  if (raw) {
    const parsed = campaignSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }
    campaign = parsed.data;
  }

  try {
    const invite = await createAgencyInvite({ campaign });
    // `{ ok: false }` is the SINGLE neutral failure for BOTH the mint cap AND a Redis
    // fail-closed (identical 429, no leaked reason). Never a fake success.
    if (!invite.ok) return { ok: false, error: NEUTRAL_FAILURE };
    return { ok: true, code: invite.code, link: invite.link };
  } catch {
    // Any other transient failure is neutralized too (no reason leaked).
    return { ok: false, error: NEUTRAL_FAILURE };
  }
}
