import "server-only";
import { cookies } from "next/headers";

/**
 * SHARED payer-session cookie helpers (server-only).
 *
 * Two providers write a session cookie:
 *  - the MOCK provider stores an HMAC-signed, self-contained {@link PayerSession}
 *    under {@link MOCK_COOKIE_NAME} (no backend involved);
 *  - the REAL (api) provider stores the backend-issued payer JWT under
 *    {@link API_TOKEN_COOKIE_NAME} — the ONLY tenant credential, kept httpOnly +
 *    server-side so it NEVER reaches the browser bundle (invariant: no secret/token
 *    in the client). The data layer reads it via {@link readApiToken} to call the
 *    payer-authed endpoints with `Authorization: Bearer <jwt>`.
 */

export const MOCK_COOKIE_NAME = "bb_payer_session";
export const API_TOKEN_COOKIE_NAME = "bb_payer_token";

/** Standard cookie options for any payer session cookie (httpOnly, SameSite=Lax). */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Read the backend payer JWT (real mode), or null if unauthenticated. Server-only. */
export async function readApiToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(API_TOKEN_COOKIE_NAME)?.value ?? null;
}
