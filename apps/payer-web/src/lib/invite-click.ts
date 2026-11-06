import "server-only";
import { z } from "zod";
import { isWellFormedInviteCode } from "./invite-landing";
import { payerFetch } from "./payer-http";

/**
 * The `/i/<code>` landing's CLICK PING (blocker B4) — SERVER-ONLY, through the ONE API seam.
 *
 * It lived in invite-landing.ts, which is deliberately not server-only and read the API base
 * with a `NEXT_PUBLIC_API_URL` fallback. It now goes through {@link payerFetch}: the server-side
 * `PAYER_API_URL` only, no session token (`public`), and the visitor's IP as `X-Forwarded-For`
 * (#2542) so the API's per-IP invite-click cap counts visitors, not this app.
 */

/**
 * Fire the PUBLIC click endpoint (`POST /invites/:code/click`), best-effort. NEVER blocks or
 * fails the render:
 *  - it is awaited only so the request is actually issued before the response streams
 *    (a fire-and-forget fetch can be torn down with the request context),
 *  - a short timeout bounds it, because a slow API must not delay a worker on 3G,
 *  - every error is swallowed — a funnel signal is never worth a broken landing page.
 *
 * The endpoint's response is deliberately ignored: it is neutral by contract and reveals
 * nothing about the code, which is the property that keeps this page from being an oracle.
 */
export async function pingInviteClick(code: string, timeoutMs = 1200): Promise<void> {
  if (!isWellFormedInviteCode(code)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await payerFetch(`/invites/${code}/click`, {
      method: "POST",
      public: true,
      schema: z.unknown(),
      signal: controller.signal,
    });
  } catch {
    // Swallowed by design (timeout, DNS, 5xx — all irrelevant to what the worker sees).
  } finally {
    clearTimeout(timer);
  }
}
