import type { ConfirmReason } from "../../../lib/confirm-tiers";
import { REVEAL_ERRORS, REVEAL_FAILED, type RevealPhoneOutcome } from "./reveal-messages";

/**
 * The drawer's phone reveal, from the browser (A7, #2577) — pure, so it is tested without a DOM.
 * The same-origin route (`[id]/phone/route.ts`) makes the reveal server-side; this asks it with a
 * plain fetch (never a server action, which a Back or Forward would discard — the route says why)
 * and narrows what it answers.
 */

/** The same-origin reveal route (`[id]/phone/route.ts`). */
export function phoneHref(workerId: string): string {
  return `/candidates/${encodeURIComponent(workerId)}/phone`;
}

/**
 * The route's body, narrowed: the phone, or one of the reveal's own sentences. Anything else — an
 * HTML error page from a proxy, a truncated body, a sentence this build does not know — is the
 * honest `REVEAL_FAILED`, so no text the route did not write reaches the screen.
 */
export function narrowRevealOutcome(body: unknown): RevealPhoneOutcome {
  if (typeof body !== "object" || body === null) return { ok: false, error: REVEAL_FAILED };
  const { ok, phone, error } = body as { ok?: unknown; phone?: unknown; error?: unknown };
  if (ok === true && typeof phone === "string" && phone.length > 0) return { ok: true, phone };
  if (ok === false && typeof error === "string" && REVEAL_ERRORS.has(error)) {
    return { ok: false, error };
  }
  return { ok: false, error: REVEAL_FAILED };
}

/**
 * Reveal ONE worker's phone: the closed reason code and the explanation, as JSON, to the route.
 * Never throws — every failure is one of the reveal's sentences. The actor is the session cookie
 * the browser sends with it; the worker is the path. No body field names either.
 */
export async function requestPhoneReveal(
  workerId: string,
  reason: ConfirmReason,
  fetchImpl: typeof fetch = fetch,
): Promise<RevealPhoneOutcome> {
  try {
    const res = await fetchImpl(phoneHref(workerId), {
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ reason_code: reason.category, note: reason.text }),
    });
    return narrowRevealOutcome(await res.json());
  } catch {
    return { ok: false, error: REVEAL_FAILED };
  }
}
