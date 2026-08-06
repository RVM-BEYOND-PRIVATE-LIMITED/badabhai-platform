/**
 * SHARING an agency invite — the one place that turns the mint's RELATIVE link into
 * something a person can actually receive, and the message that travels with it.
 *
 * WHY THIS MODULE EXISTS. `POST /payer/agency/invites` returns `link: "/i/<code>"` — a
 * relative path (see `agency.service.ts`). That is correct on the wire: the API does not
 * know which host the portal is served from. But every SHARE surface has to absolutise it
 * first, and until now only the printable QR sheet did. The dashboard's "Copy link" and
 * "Copy all links" buttons copied the raw `/i/<code>`, so an agent pasting into WhatsApp
 * sent a path that resolves to nothing outside a browser tab already on the portal.
 *
 * The QR sheet's own copies of these two helpers moved here so all three share surfaces —
 * single invite, batch, printable sheet — absolutise identically instead of drifting.
 *
 * PII: everything here handles an OPAQUE code and our own copy. No invite endpoint accepts
 * a recipient, so an agency has no worker phone or name at mint time and there is nothing
 * here that could leak one.
 */

/**
 * Build the ABSOLUTE url a share/QR must carry, from the RELATIVE link the mint returns
 * ("/i/<code>").
 *
 * A camera cannot resolve a relative path and neither can WhatsApp: sharing "/i/abc"
 * produces a link that scans and taps to nothing. Pure + exported so the "is it absolute?"
 * property is unit-pinned.
 */
export function toAbsoluteInviteUrl(origin: string, link: string): string {
  if (/^https?:\/\//i.test(link)) return link; // already absolute — use as-is.
  const base = origin.replace(/\/+$/, "");
  return `${base}${link.startsWith("/") ? "" : "/"}${link}`;
}

/**
 * Which origin goes into a SHARED link.
 *
 * A shared link outlives the tab it was created in — printed on a poster it is permanent,
 * and forwarded through WhatsApp it can be tapped weeks later. Whatever host it carries is
 * the host workers reach for, and it cannot be corrected afterwards. Using the browsing
 * origin alone meant a staffer on a preview deploy, an IP, or localhost produced links that
 * die the moment that host does.
 *
 * So: prefer the deployment's CANONICAL public site url when one is configured
 * (`NEXT_PUBLIC_SITE_URL` — an EXISTING optional payer-web variable, not a new required
 * one; public by definition and safe in the client bundle), and fall back to the browsing
 * origin when it is unset or unparseable. Only the ORIGIN is taken (`new URL(...).origin`
 * drops any path/query/fragment), and only http(s) is accepted, so a stray value can never
 * turn a shared link into a link to somewhere else.
 *
 * Named `printableInviteOrigin` when it served only the poster; the rule is identical for
 * every share surface, so it is no longer named after one of them.
 */
export function shareableInviteOrigin(
  configured: string | undefined,
  browsingOrigin: string,
): string {
  const raw = configured?.trim();
  if (!raw) return browsingOrigin;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return browsingOrigin;
    return url.origin;
  } catch {
    return browsingOrigin; // not a url at all — the browsing origin is the honest fallback.
  }
}

/** The browser origin, or "" when there is no window (SSR) — callers refuse to share "". */
export function browsingOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * THE call every share surface makes: mint link in, absolute shareable url out.
 *
 * Returns "" when no origin can be established at all (SSR with nothing configured), which
 * callers must treat as "cannot share yet" rather than rendering a broken link — the QR
 * sheet refuses to draw a code, and the panels fall back to showing the raw link so the
 * agent can still see what they got.
 *
 * `configuredSiteUrl` is passed IN rather than read here so the literal
 * `process.env.NEXT_PUBLIC_SITE_URL` member expression stays in the client component, which
 * is the form Next inlines at build time.
 */
export function shareableInviteUrl(link: string, configuredSiteUrl: string | undefined): string {
  const origin = shareableInviteOrigin(configuredSiteUrl, browsingOrigin());
  return origin ? toAbsoluteInviteUrl(origin, link) : "";
}

/**
 * The message wrapped around a shared invite link.
 *
 * Deliberately short: it is pre-filled into someone's WhatsApp compose box and they will
 * edit it. A paragraph gets deleted; a line gets sent.
 *
 * IDENTICAL to `inviteShareText` in the payer app
 * (`apps/payer-app/lib/features/agency/util/whatsapp_share.dart`) so an agent sends the
 * same words whether they share from the app or the portal. Change both together.
 */
export function inviteShareMessage(url: string): string {
  return `Join BadaBhai and find factory jobs — no test, just a conversation. ${url}`;
}

/**
 * Build `https://wa.me/?text=<urlencoded>` — WhatsApp's contact-picker deep link.
 *
 * NO PHONE NUMBER in the path. A number there would open a chat with THAT number; omitting
 * it opens the contact picker, which is what "share this invite" means — the agent chooses
 * the recipient. It also means this needs no WhatsApp Business number and no Meta Cloud API
 * credential: it is a client-side hand-off to whatever WhatsApp the sharer already has.
 * (Platform-SENT WhatsApp is a different mechanism entirely — see
 * `apps/api/src/messaging/meta-whatsapp.provider.ts`, which stays human-gated.)
 *
 * The `https://` form rather than `whatsapp://`: the https link degrades to a web page that
 * offers to open WhatsApp when the app is absent, whereas the custom scheme simply fails to
 * resolve. One URL, no dead end.
 *
 * `encodeURIComponent`, not `encodeURI`: the text contains `&`, `#` and `?` often enough
 * (and the link always contains `/`), and only the component form escapes the separators
 * that would otherwise truncate the message at the first `&`.
 */
export function whatsAppShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/**
 * Filename for a downloaded QR image. The opaque code disambiguates a folder full of
 * downloads — an agency printing ten different posters otherwise gets ten copies of
 * `badabhai-invite.png`. It reveals nothing: a code identifies no worker, and the agent
 * already holds it.
 *
 * The code is constrained to the mint's alphabet before it reaches a filename, so a hostile
 * value can never introduce a path separator or a second extension.
 */
export function qrDownloadFileName(code: string): string {
  const safe = code.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return `badabhai-invite-${safe || "code"}.png`;
}
