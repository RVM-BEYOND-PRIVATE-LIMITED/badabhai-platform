import "server-only";
import { cookies } from "next/headers";
// Frontend-SAFE subpath: `@badabhai/config/shared` carries only the env helpers (zod-only, no
// secrets) — NEVER the secret-bearing root (`@badabhai/config`), per the server/public split.
import { shouldUseSecureCookie } from "@badabhai/config/shared";

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

/**
 * The TRUSTED-DEVICE cookie (ADR-0060 A3, "Trust this device for 30 days").
 *
 * The value is a BEARER SECRET: with the password, it replaces the authenticator code on this
 * browser. So it is held exactly like the session — httpOnly, SameSite=strict, Secure per
 * {@link shouldUseSecureCookie} — and it is written and read ONLY in server actions. It never
 * reaches a client component, a log line or an analytics call.
 *
 * Its own name, so it outlives the session: signing out clears `bb_admin_token` and leaves this
 * one, which is the whole point of "trust this device". Its lifetime is the server's
 * `device_expires_in_seconds`; the server also forgets the device on any password change,
 * authenticator reset or re-enrolment, after which this cookie is simply ignored and the
 * operator sees the authenticator step again — nothing on this side breaks.
 */
export const ADMIN_DEVICE_COOKIE_NAME = "bb_admin_device";

/**
 * The shape the API accepts back as `device_token` (`string 20..128`). The server issues 32
 * random bytes as base64url; anything else in the cookie (a hand-edited value, a truncated one)
 * is not sent, because a malformed `device_token` would fail the whole sign-in request's
 * validation rather than just being "not trusted".
 */
const DEVICE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

export function isDeviceTokenShape(value: string): boolean {
  return DEVICE_TOKEN_SHAPE.test(value);
}

/** The trusted-device token, or null when there is none (or it is not a well-formed one). */
export async function readAdminDeviceToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(ADMIN_DEVICE_COOKIE_NAME)?.value;
  return value && isDeviceTokenShape(value) ? value : null;
}

/** Persist a freshly issued trusted-device token for the server's stated lifetime. */
export async function writeAdminDeviceToken(token: string, maxAgeSeconds: number): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_DEVICE_COOKIE_NAME, token, adminCookieOptions(maxAgeSeconds));
}
