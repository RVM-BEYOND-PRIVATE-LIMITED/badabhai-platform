import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * The signed-in admin's OWN sign-in settings, for the Account page (ADR-0060 A2/A5).
 *
 * Read from `GET /admin/me` — the same session-only route `currentSession()` uses — rather than
 * folded into `AdminSession`: that type is deliberately id + role + capabilities, every page
 * carries it, and only this one page needs to know how its reader signs in.
 *
 * EVERY FIELD IS OPTIONAL ON THE WIRE, and an absent one is `null`, never a guessed `false`.
 * `has_password`, `must_change_password` and `mfa_enabled` are additive fields (ADR-0060); an
 * API build that predates them must not make the page claim "you have no password" or "two-step
 * verification is off" — it renders an honest "could not be read" for that panel instead.
 */
export interface AccountSecurity {
  /** Whether a password is set. null = the server did not say. */
  hasPassword: boolean | null;
  /** The password is a temporary one an admin set at creation and must be replaced. */
  mustChangePassword: boolean;
  /** Whether two-step verification (MFA) is on for this account. null = the server did not say. */
  mfaEnabled: boolean | null;
}

/** Exported so tests parse a response through the real schema, not around it. */
export const meSecuritySchema = z.object({
  has_password: z.boolean().optional(),
  must_change_password: z.boolean().optional(),
  mfa_enabled: z.boolean().optional(),
});

export function toAccountSecurity(raw: z.infer<typeof meSecuritySchema>): AccountSecurity {
  return {
    hasPassword: raw.has_password ?? null,
    mustChangePassword: raw.must_change_password === true,
    mfaEnabled: raw.mfa_enabled ?? null,
  };
}

export async function readAccountSecurity(): Promise<AccountSecurity> {
  const raw = await adminFetch("/admin/me", { schema: meSecuritySchema });
  return toAccountSecurity(raw);
}
