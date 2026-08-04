import "server-only";
import { cookies } from "next/headers";

/**
 * Admin-session cookie helpers (server-only).
 *
 * The backend-issued ADMIN JWT lives under {@link ADMIN_TOKEN_COOKIE_NAME}, httpOnly and
 * server-side, so it NEVER reaches the browser bundle. This is the 4th principal in the
 * platform (ADR-0025) and by far the most privileged, so the cookie is stricter than the
 * payer one in two ways:
 *
 *  - **SameSite=strict**, not `lax`. The payer portal has legitimate inbound links from
 *    email (an invite, a magic link) that must arrive authenticated; the admin portal has
 *    none — an operator always navigates to it directly. `strict` removes cross-site
 *    request forgery as a category rather than mitigating it.
 *  - **A distinct cookie name** from the payer token, so a shared parent domain can never
 *    let one principal's cookie be read where the other is expected.
 */

export const ADMIN_TOKEN_COOKIE_NAME = "bb_admin_token";

/**
 * Should the session cookie be `Secure` (HTTPS-only)? True in production AND on any
 * https/staging deployment. Local http dev stays non-secure so the cookie works at all.
 *
 * The API URL is deliberately NOT a signal: it is a different host and could be https
 * while the portal itself is served over local http — a false positive that would silently
 * drop the cookie and make login appear broken.
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

/** Cookie options for the admin session. httpOnly + SameSite=strict (see above). */
export function adminCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true as const,
    sameSite: "strict" as const,
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Read the backend admin JWT, or null when unauthenticated. Server-only. */
export async function readAdminToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ADMIN_TOKEN_COOKIE_NAME)?.value ?? null;
}

/** Persist a freshly minted admin JWT. */
export async function writeAdminToken(token: string, maxAgeSeconds: number): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_TOKEN_COOKIE_NAME, token, adminCookieOptions(maxAgeSeconds));
}

/**
 * Drop the admin session cookie.
 *
 * Called on logout AND whenever the server tells us a token is dead (401). Clearing it
 * locally is never sufficient on its own — the backend `POST /admin/logout` is what
 * actually revokes the session — but leaving a known-dead cookie in place would make every
 * subsequent page render attempt a doomed request and show an error instead of the login.
 */
export async function clearAdminToken(): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_TOKEN_COOKIE_NAME, "", adminCookieOptions(0));
}
