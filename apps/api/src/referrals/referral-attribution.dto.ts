import { z } from "zod";
import { InviteInstallSource } from "@badabhai/event-schema";

/**
 * The opaque referral code carried by a shared `/i/<code>` deep-link. BOTH the
 * worker→worker `invites` (ADR-0020) and the agency `agency_invites` (ADR-0022) mint a
 * 12-char lowercase-hex code (`randomUUID().replace(/-/g,"").slice(0,12)`). We validate
 * the SHAPE only — resolution + the no-oracle neutral response happen in the service (an
 * unknown/expired/foreign code is a silent no-op, never a distinguishable error).
 */
export const AttributeReferralSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{12}$/, "invalid referral code"),
  /**
   * B4 — which leg of the post-Dynamic-Links chain carried the code across the Play Store
   * round-trip (Firebase Dynamic Links died 2025-08-25; the replacement is the self-hosted
   * `/i/<code>` resolver + Play Install Referrer). Recorded on `invite.install` so a broken
   * leg is VISIBLE instead of silently costing attributions.
   *
   * OPTIONAL by design (invariant #8): every already-shipped client posts `{code}` only and
   * keeps working unchanged — the service defaults a missing/omitted value to "unknown".
   * A CLOSED enum, so no client-supplied free text can ever reach the event spine.
   */
  source: InviteInstallSource.optional(),
});
export type AttributeReferralDto = z.infer<typeof AttributeReferralSchema>;
