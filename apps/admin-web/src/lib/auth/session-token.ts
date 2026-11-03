import { z } from "zod";

/**
 * The admin session the API mints — on sign-in (`/admin/login/password`, `/admin/login/verify`,
 * `/admin/mfa/verify`) and on a password change (`/admin/me/password` returns a FRESH session,
 * because the change invalidates every session issued before it, the caller's included).
 *
 * One schema for every minting route, so a Server Action that writes the session cookie always
 * reads the same fields. `access_token` goes straight into the httpOnly cookie; nothing here is
 * ever returned to a client component.
 */
export const adminSessionTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in_seconds: z.number().int().positive(),
  admin_id: z.string().min(1),
  role: z.string().min(1),
});
