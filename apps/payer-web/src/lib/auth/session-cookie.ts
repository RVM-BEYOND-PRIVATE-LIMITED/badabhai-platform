import "server-only";
import { cookies } from "next/headers";
// Frontend-SAFE subpath: `@badabhai/config/shared` carries only the env helpers (zod-only, no
// secrets) — NEVER the secret-bearing root (`@badabhai/config`), per the server/public split.
import { shouldUseSecureCookie } from "@badabhai/config/shared";

/**
 * Payer-session cookie helpers (server-only).
 *
 * The REAL (api) provider stores the backend-issued payer JWT under
 * {@link API_TOKEN_COOKIE_NAME} — the ONLY tenant credential, kept httpOnly +
 * server-side so it NEVER reaches the browser bundle (invariant: no secret/token
 * in the client). The data layer reads it via {@link readApiToken} to call the
 * payer-authed endpoints with `Authorization: Bearer <jwt>`.
 */

export const API_TOKEN_COOKIE_NAME = "bb_payer_token";

/** Standard cookie options for any payer session cookie (httpOnly, SameSite=Lax). */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Read the backend payer JWT (real mode), or null if unauthenticated. Server-only. */
export async function readApiToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(API_TOKEN_COOKIE_NAME)?.value ?? null;
}
