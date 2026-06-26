import "server-only";
import { cookies } from "next/headers";

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

/**
 * Should the session cookie be `Secure` (HTTPS-only)? True in production AND on any
 * https/staging deployment (D1). Local http dev stays non-secure so the cookie works.
 *
 * Signals (any ⇒ secure): NODE_ENV=production; a staging/production environment label;
 * or the deployment's OWN site URL being https. (The API URL is deliberately NOT used —
 * it is a different host and could be https even in local http dev, a false positive.)
 */
function shouldUseSecureCookie(): boolean {
  if (process.env.NODE_ENV === "production") return true;

  const env = (process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").trim().toLowerCase();
  if (env === "staging" || env === "production") return true;

  const siteUrls = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
  ];
  return siteUrls.some(
    (u) => typeof u === "string" && u.trim().toLowerCase().startsWith("https://"),
  );
}

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
