"use server";

import { z } from "zod";
import { looksLikeActionContextPii } from "@badabhai/validators";
import { createAgencyInviteBatch } from "../../../../lib/payer-api";
import { requireAgent } from "../../../../lib/auth/roles";

/**
 * BATCH invite-mint Server Action (ADR-0022 amendment — batch minting).
 *
 * THIS IS NOT BULK UPLOAD. The parked "Bulk Invite Upload" module (parked-modules.tsx,
 * "Not available: consent violation") is DEAD BY DESIGN: it is an INBOUND assertion about
 * real, existing, non-consented people — the agency supplies a list of worker contacts and
 * the platform ends up holding personal data of a data principal who never consented
 * (invariant #6 cannot even be evaluated, because the processing already happened at
 * ingest). No gate revives it.
 *
 * Batch minting is the OPPOSITE DIRECTION and has NO REFERENT: the platform GENERATES N
 * cryptographically random, opaque bearer codes. Each one denotes nobody. The agency's
 * ENTIRE contribution to the request is ONE INTEGER (how many) plus ONE optional non-PII
 * tag applied identically to all N.
 *
 * THE INPUT SHAPE IS THE SECURITY BOUNDARY. `{ count, campaign? }` has arity over NOTHING —
 * it is a cardinality. The instant this body could carry a per-invite element (labels[],
 * recipients[], notes[], names[], phones[], for[], contacts[] — anything array-shaped) the
 * input regains arity over PEOPLE, the direction flips to inbound, and this becomes bulk
 * upload with a weaker identifier. NEVER add an array-typed field here. The backend DTO is
 * `.strict()` so an attempted list is a loud 400, and this action mirrors that shape
 * exactly: it forwards ONLY a number and an optional string.
 *
 * VERTICAL AUTHZ (XB-A / XT3): a Server Action is independently invocable, so it enforces
 * the agent role gate ITSELF — `requireAgent()` is the FIRST statement (an employer hits the
 * SAME neutral notFound() the page does; no oracle). `inviter_payer_id` for all N rows comes
 * from the SERVER-HELD session; there is nowhere in this input to put a payer id.
 *
 * NO SEND: this action mints links and nothing else. It accepts no phone/email/recipient and
 * triggers no outbound message. Delivery stays out-of-band (the agency shares the links
 * itself). That is a permanent boundary — a "send these 50 links" capability would require
 * 50 phone numbers of non-consented people, i.e. bulk upload exactly.
 *
 * NEUTRAL FAILURE: the per-payer mint cap (a batch of N consumes N units, reserved atomically
 * up-front) AND a Redis fail-closed BOTH surface from the seam as the SAME `{ ok: false }`
 * (identical backend 429, no leaked reason) → mapped to ONE neutral error string. We NEVER
 * fake a success and NEVER reveal which cause it was.
 */

/**
 * The campaign tag is PII-screened with the SAME `looksLikeActionContextPii` helper as
 * invite-actions.ts and the backend DTO: a name/phone/email in this human-typed field is a leak risk — the tag
 * is written to the invite row AND emitted in the `agency_invite.created` payload, which is
 * an invariant-#2 sink. A batch multiplies that field's reach by up to 50 per call.
 * We name the field, never the offending content.
 */

/**
 * Server-side batch bound. The backend DTO is the AUTHORITY (`count` max 50); this mirrors
 * it. Deliberately NOT exported: a "use server" module may only export async functions, so
 * the panel keeps its own copy of the bound (same idiom as invite-panel.tsx's TAG_MAX).
 */
const BATCH_MIN = 1;
const BATCH_MAX = 50;

const campaignSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((s) => !looksLikeActionContextPii(s), {
    message: "The campaign tag must be a non-PII label — use a short slug like diwali-drive, never a person's name, phone, or email.",
  });

/**
 * CARDINALITY ONLY. A finite integer in [1, 50] — nothing else parses. `z.number()` rejects
 * a string-coerced value, NaN and Infinity (`.int()` + `.finite()`), so a hostile client
 * cannot smuggle an unbounded or non-numeric count past this action into the seam.
 */
const countSchema = z.number().int().finite().min(BATCH_MIN).max(BATCH_MAX);

const COUNT_FAILURE = `Choose how many links to create — any whole number from ${BATCH_MIN} to ${BATCH_MAX}.`;
const NEUTRAL_FAILURE = "Could not create invite links right now. Please try again shortly.";

export type CreateInviteBatchResult =
  | { ok: true; invites: { code: string; link: string }[] }
  | { ok: false; error: string };

export async function createInviteBatchAction(input: {
  count: number;
  campaign?: string;
}): Promise<CreateInviteBatchResult> {
  await requireAgent(); // role gate FIRST — employer → neutral notFound().

  const parsedCount = countSchema.safeParse(input.count);
  if (!parsedCount.success) return { ok: false, error: COUNT_FAILURE };

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
    // The body forwarded to the seam is EXACTLY the cardinality shape: a number and an
    // optional scalar tag. No array, no per-invite object, no recipient — ever.
    const batch = await createAgencyInviteBatch({ count: parsedCount.data, campaign });
    // `{ ok: false }` is the SINGLE neutral failure for BOTH the mint cap AND a Redis
    // fail-closed (identical 429, no leaked reason). Never a fake success.
    if (!batch.ok) return { ok: false, error: NEUTRAL_FAILURE };
    // A mid-batch backend failure returns the successfully minted SUBSET (rows and events
    // stay coupled server-side) — that is an honest partial success and we surface exactly
    // what came back. ZERO invites is NOT a success: it would render an empty "created" list.
    if (batch.invites.length === 0) return { ok: false, error: NEUTRAL_FAILURE };
    return { ok: true, invites: batch.invites };
  } catch {
    // Any other transient failure is neutralized too (no reason leaked, no partial claim).
    return { ok: false, error: NEUTRAL_FAILURE };
  }
}
