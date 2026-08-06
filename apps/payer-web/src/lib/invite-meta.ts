import { z } from "zod";
import { looksLikeActionContextPii } from "@badabhai/validators";

/**
 * The W1 INVITE METADATA rules, mirrored once for the portal.
 *
 * The backend `agency.dto.ts` stays the AUTHORITY — every value here is re-validated there,
 * and a mismatch surfaces as a 400 rather than as a silently-accepted write. What this
 * module buys is an INLINE rejection before the round-trip, and, more importantly, ONE
 * definition shared by the single-invite panel, the batch panel and both of their Server
 * Actions. The campaign tag already taught this lesson: three copies of its regex drifted
 * across those same files until they were collapsed onto the shared
 * `looksLikeActionContextPii` helper. Metadata arrives with two more fields, so it starts
 * shared rather than ending up that way.
 *
 * WHY THE SHAPE IS CLOSED. `context` is written to `agency_invites.payload` (jsonb) by an
 * agency-facing endpoint. A free-shape object there would be the widest PII surface that
 * table has ever had — an agency could park `{name, phone, notes}` per invite and rebuild
 * the dead bulk-upload one row at a time. Exactly two keys, both optional, both slugs.
 */

/** Parity with `CONTEXT_SLUG_MAX` in `apps/api/src/agency/agency.dto.ts`. */
export const INVITE_CONTEXT_SLUG_MAX = 48;

/** Parity with `agency_invites_medium_chk` and `referral_links.medium`. */
export const inviteMediumSchema = z.enum(["organic", "paid"]);
export type InviteMedium = z.infer<typeof inviteMediumSchema>;

/**
 * One deep-link context value: a bounded LOWERCASE SLUG (`welder`, `pune`, `pune-west`).
 *
 * The character class is doing security work, not tidiness. `looksLikeActionContextPii`
 * catches name/address/phone/email SHAPES, but it is a heuristic; the slug pattern is the
 * structural half that does not depend on a heuristic being clever enough. No spaces means
 * no "Ramesh Kumar"; no `@` means no email.
 */
export const inviteContextSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(INVITE_CONTEXT_SLUG_MAX)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase slug (a-z, 0-9, hyphen)")
  .refine((s) => !looksLikeActionContextPii(s), { message: "must be a non-PII slug" });

/** `.strict()` — an attempted `{phone}`/`{name}`/`{notes}` key is a loud failure. */
export const inviteContextSchema = z
  .object({
    role: inviteContextSlugSchema.optional(),
    city: inviteContextSlugSchema.optional(),
  })
  .strict();
export type InviteContext = z.infer<typeof inviteContextSchema>;

/** Either the validated metadata to send, or ONE human message naming what was wrong. */
export type ParsedInviteMeta =
  | { ok: true; medium?: InviteMedium; context?: InviteContext }
  | { ok: false; error: string };

/**
 * Validate the metadata a mint Server Action received.
 *
 * A Server Action is INDEPENDENTLY INVOCABLE — anyone who can reach the endpoint can call
 * it with any body, so the panel's inline screen is a courtesy and this is the boundary the
 * portal actually enforces. (The backend DTO enforces it a third time; that one is the
 * authority.)
 *
 * Empty strings are treated as ABSENT, not as invalid: an untouched optional input posts
 * `""` and must behave exactly like a mint from before W1 existed.
 */
export function parseInviteMeta(input: {
  medium?: string;
  context?: { role?: string; city?: string };
}): ParsedInviteMeta {
  let medium: InviteMedium | undefined;
  const rawMedium = input.medium?.trim();
  if (rawMedium) {
    const parsed = inviteMediumSchema.safeParse(rawMedium);
    // The value comes from a closed <select>; anything else was hand-crafted, so the
    // message stays generic rather than echoing what was sent.
    if (!parsed.success) return { ok: false, error: "Choose a valid link type." };
    medium = parsed.data;
  }

  // EVERY key the caller sent is carried into the strict parse, not just role/city.
  // Cherry-picking the two known keys would SILENTLY DROP a `{name, phone}` bag, and a
  // silently-stripped key is the failure mode W1's backend schema exists to prevent: the
  // caller believes they stored something, nobody is told otherwise, and an attempted
  // misuse leaves no trace. `.strict()` turns it into a loud, reviewable refusal instead.
  const rawContext: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.context ?? {})) {
    if (typeof value === "string") {
      // An untouched optional input posts "" — absent, not invalid.
      const trimmed = value.trim();
      if (trimmed) rawContext[key] = trimmed;
    } else if (value !== undefined) {
      // Not a string at all: keep it so the schema rejects it rather than this loop.
      rawContext[key] = value;
    }
  }

  let context: InviteContext | undefined;
  if (Object.keys(rawContext).length > 0) {
    const parsed = inviteContextSchema.safeParse(rawContext);
    if (!parsed.success) {
      if (parsed.error.issues.some((i) => i.code === "unrecognized_keys")) {
        return {
          ok: false,
          error:
            "An invite can carry only a role and a city — nothing about a specific person.",
        };
      }
      // Name the FIELD, never the offending content — the reason a value is rejected here
      // is precisely that it might be somebody's name.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path[0]).filter(Boolean))];
      const named = fields.length > 0 ? fields.join(" and ") : "context";
      return {
        ok: false,
        error: `The ${named} must be a lowercase, non-PII slug — like welder or pune-west.`,
      };
    }
    context = parsed.data;
  }

  return { ok: true, medium, context };
}

/**
 * INLINE screen for one context field, for the panels.
 *
 * Returns a human message or null. It NAMES the field and never echoes the offending
 * content — the same no-echo rule the campaign tag follows, because the whole reason a
 * value is rejected here is that it might be somebody's name.
 *
 * `label` is the field's own word ("role", "city") so one function serves both inputs
 * without the caller assembling the sentence.
 */
export function inviteContextSlugError(label: string, raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null; // optional — empty is the normal case.
  if (value.length > INVITE_CONTEXT_SLUG_MAX) return `The ${label} slug is too long.`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value))
    return `The ${label} must be a lowercase slug — letters, numbers and hyphens only, like welder or pune-west.`;
  if (looksLikeActionContextPii(value))
    return `The ${label} must be a non-PII slug — never a person's name, phone, or email.`;
  return null;
}
