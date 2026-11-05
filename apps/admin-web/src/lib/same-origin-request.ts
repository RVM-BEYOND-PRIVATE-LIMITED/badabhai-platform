/**
 * What a same-origin route handler that REVEALS or CHANGES something checks before it acts — the
 * candidate drawer's phone reveal (A7, #2577, `(portal)/candidates/[id]/phone/route.ts`). Next
 * makes such checks only for a server action, and that route is deliberately not one (it says why).
 *
 * ── THE PORTAL'S OWN ORIGIN, AND WHERE IT COMES FROM ────────────────────────────────────
 * The portal has no configured origin: `NEXT_PUBLIC_SITE_URL` is read nowhere, and the portal is
 * reached on the box's loopback through a tunnel, never through a proxy (`Dockerfile`,
 * `docker-compose.staging.yml`). Nor is `request.url` its address: Next builds it from the server's
 * own listening address (`http://0.0.0.0:3003/…` in the container), not the one the browser used.
 * So the origin is read off the request, the way the browser addressed it:
 *  - the HOST and port are the `Host` header — the browser sets it to the address it sent the
 *    request to, and a page cannot set it (a forbidden request header);
 *  - the SCHEME is the request's own as Next read it (TLS on the socket, or `X-Forwarded-Proto` —
 *    `http:` on the tunnel).
 * `X-Forwarded-Host` is NEVER read. Next fills it from Host when it is absent, so it adds nothing,
 * and when a request does carry one nothing legitimate set it — any client can. (Next's own
 * server-action check prefers it; this one does not.) If a proxy is ever put in front of the
 * portal, it must pass the browser's Host through, or this check refuses: closed, not open.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────────────────
 *  1. `Sec-Fetch-Site`, when sent, is `same-origin`. `cross-site`, `same-site` (a sibling host)
 *     and `none` (no page made the request: a typed address, a bookmark) are refused. The browser
 *     sets it, and a page cannot.
 *  2. `Origin`, when sent, IS the portal's own origin (above) — `null` (a sandboxed frame, a file),
 *     another host, port or scheme, or no Host to compare it with is refused.
 *  3. The body is `application/json` ({@link isJsonRequest}) — a type no other ORIGIN can send
 *     here: a cross-origin form or `no-cors` fetch can declare only a CORS-safelisted type (a form
 *     encoding or `text/plain`), and a cross-origin `fetch` with JSON needs a CORS preflight that
 *     this portal never grants (it sets no `Access-Control-Allow-Origin` anywhere).
 *
 * ── A HEADER THAT IS NOT SENT: ALLOWED, AND WHY ─────────────────────────────────────────
 * An older browser sends no `Sec-Fetch-Site` (Safari before 16.4, Firefox before 90, Chrome before
 * 76), and some send no `Origin` on a same-origin POST. Neither absence is refused — as Next's own
 * server-action check does not refuse a missing Origin — because what is left still holds:
 *  - the session cookie is SameSite=strict, which withholds it only from another SITE: a request
 *    another site starts carries no session, and the route's `adminFetch` refuses before sending
 *    anything without one. SameSite is per site, not per origin, so a page of the SAME site on
 *    another origin — another `localhost` port (the portal is reached on loopback), a sibling
 *    subdomain if it is ever exposed — DOES carry the cookie;
 *  - that page is stopped by rule 3 (it cannot send JSON here), and by rule 2 whenever its browser
 *    sends Origin. On a browser that sends neither header, rule 3 is ALL that stops it.
 * So rule 3 must not be loosened — no `text/plain` for `sendBeacon`, no form fallback — while an
 * absent header is allowed: that would let a page on another localhost port make an audited,
 * cap-charged reveal with the operator's session. Refusing the absence would lock an operator on an
 * older browser out of the action and close no hole these leave open.
 */

/** Is this request from a page of this portal? Rules 1 and 2 above. */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === ownOrigin(request);
}

/**
 * The portal's origin as the browser addressed this request — the request's scheme and its `Host`,
 * serialized the way a browser writes an `Origin` (letter case and a default port do not make it
 * another one). Null when there is no Host, or it is not one (`a@b`, `host/path`).
 */
function ownOrigin(request: Request): string | null {
  const host = request.headers.get("host");
  if (host === null || host === "") return null;
  let own: URL;
  try {
    own = new URL(`${new URL(request.url).protocol}//${host}`);
  } catch {
    return null;
  }
  const bare =
    own.username === "" &&
    own.password === "" &&
    own.pathname === "/" &&
    own.search === "" &&
    own.hash === "";
  return bare ? own.origin : null;
}

/** Is the body declared JSON (`application/json`, with or without parameters)? Rule 3 above. */
export function isJsonRequest(request: Request): boolean {
  const type = request.headers.get("content-type");
  return type !== null && type.split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

/**
 * The body as text, or null when it is longer than `maxBytes`. Read no further than that, so an
 * oversized body is never held whole — the bound a server action gets from Next
 * (`bodySizeLimit`) and a route handler does not.
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}
