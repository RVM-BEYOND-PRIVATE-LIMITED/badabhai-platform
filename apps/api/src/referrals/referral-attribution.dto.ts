import { z } from "zod";

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
});
export type AttributeReferralDto = z.infer<typeof AttributeReferralSchema>;
