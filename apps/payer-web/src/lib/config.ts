/**
 * Browser-safe config for the self-serve payer web app.
 *
 * SECURITY: this app is a PUBLIC-ORIGIN SPA/SSR client. It reads ONLY a
 * `NEXT_PUBLIC_*` value — the API base URL — and NEVER imports a server secret
 * (no JWT_SECRET, no service-role key, no API secret). The only credential it
 * ever holds is the authenticated payer's OWN Bearer session token, kept
 * client-side (see `session.ts`).
 *
 * `NEXT_PUBLIC_API_BASE_URL` is inlined at build time by Next; the localhost
 * default lets the app run with zero config in local dev.
 */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001"
).replace(/\/+$/, "");

/** Shown in the footer so it is obvious which API origin a build points at. */
export const ENVIRONMENT = process.env.NEXT_PUBLIC_ENVIRONMENT ?? "development";
