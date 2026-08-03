/**
 * Config + link building for the PUBLIC `/i/<code>` referral landing page (blocker B4).
 *
 * WHY THIS EXISTS. A shared referral link is `https://app.badabhai.in/i/<code>` — that is
 * literally `kInviteLinkBase` in the worker app — but no such route existed, so every share
 * to somebody who does not have the app yet hit a 404 and the referral died there. With
 * Firebase Dynamic Links shut down (2025-08-25), this page plus Play Install Referrer IS
 * the attribution chain.
 *
 * NOT server-only on purpose: this module holds no secret (a package name and a public API
 * base), and keeping it free of `server-only` lets it be unit-tested and, if ever needed,
 * rendered on either side. Nothing here reads a credential.
 */

/** Fail-closed-ish env read: trims, and treats blank as unset. */
function env(name: string): string | undefined {
  const raw = process.env[name];
  const value = raw?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * The worker app's Play Store application id. Config, never a literal, because the store
 * listing id differs between the internal-test track and production, and a wrong id sends
 * every referred worker to a "not found" page on the Play Store.
 */
export function workerAppId(): string {
  return env("NEXT_PUBLIC_WORKER_APP_ID") ?? "in.badabhai.worker";
}

/**
 * Build the Play Store URL with the referral payload attached.
 *
 * `referrer` is the ONLY thing that survives the install: Play hands it back to the app on
 * first run via the Install Referrer API, which is how a fresh install gets attributed at
 * all. It is a single URL-encoded `bb_code=<code>` pair — deliberately not a JSON blob, so
 * there is exactly one thing to parse and nothing PII-shaped can be smuggled into it.
 */
export function playStoreUrl(code: string): string {
  const referrer = encodeURIComponent(`bb_code=${code}`);
  return `https://play.google.com/store/apps/details?id=${workerAppId()}&referrer=${referrer}`;
}

/**
 * The bare Play Store listing, carrying NO referrer payload.
 *
 * The destination for the resolver's fallback leg (`/i/unknown`), and for ANY visit whose
 * code fails the 12-hex shape check, where there is no usable code to attribute. Attaching
 * `referrer=bb_code=unknown` there would post a junk code into the Install Referrer path on
 * first run and burn a claim attempt on a code that resolves to nothing — an unattributed
 * install is the honest outcome, so it carries nothing.
 */
export function playStoreBrowseUrl(): string {
  return `https://play.google.com/store/apps/details?id=${workerAppId()}`;
}

/**
 * The BRANDED SHORT-LINK origin — the base of `/r/<code>`, the resolver every agent code,
 * worker share, campaign URL and QR now goes through (B4).
 *
 * Defaults to the app-link host the worker app's manifest already claims, so B4 adds NO new
 * required deployment variable. Pointing it at a real short domain is a DNS/deploy action
 * (P0-6), never a code change.
 */
export function shortLinkOrigin(): string {
  return (env("NEXT_PUBLIC_SHORT_LINK_BASE") ?? "https://app.badabhai.in").replace(/\/+$/, "");
}

/** The shareable short link for a code — what a QR encodes and what gets forwarded. */
export function shortLinkUrl(code: string): string {
  return `${shortLinkOrigin()}/r/${encodeURIComponent(code)}`;
}

/**
 * THE `intent://` FALLBACK — leg 2 of the chain, and the one that does the most work.
 *
 * A single Android intent URL that means: "open the app if it is installed; otherwise go
 * where `S.browser_fallback_url` says". That fallback is the Play Store URL WITH the
 * `referrer=bb_code=<code>` payload attached, so a worker who does not have the app installs
 * it and the code still survives the round-trip via the Install Referrer API.
 *
 * WHY IT MATTERS EVEN THOUGH THE APP LINK EXISTS. The verified App Link (leg 1) only fires
 * once `assetlinks.json` is served for the domain — a separate, owner-executed workstream
 * (P0-6). Until then EVERY shared link falls to this leg, and without it a worker without
 * the app would land on a page whose only action was a bare Play Store link carrying nothing.
 * It also stays useful afterwards, because App Link verification legitimately fails on some
 * OEM browsers and on a first boot with no network.
 *
 * `S.browser_fallback_url` must be percent-encoded — it is a URL nested inside a URL, and an
 * unencoded `&` in the Play query string would terminate the intent's own parameter list.
 */
export function intentUrl(code: string): string {
  const fallback = encodeURIComponent(playStoreUrl(code));
  return (
    `intent://i/${encodeURIComponent(code)}#Intent;scheme=badabhai;` +
    `package=${workerAppId()};S.browser_fallback_url=${fallback};end`
  );
}

/**
 * API base for the SERVER-SIDE click ping. Reuses the payer portal's existing
 * `PAYER_API_URL` (the same API this app already talks to) so B4 introduces no new
 * deployment variable; `NEXT_PUBLIC_API_URL` is honoured as a fallback.
 */
export function inviteApiBaseUrl(): string {
  return env("PAYER_API_URL") ?? env("NEXT_PUBLIC_API_URL") ?? "http://localhost:3001";
}

/** The shape a referral code may take: 12 lowercase hex, both funnels (worker + agency). */
const CODE_RE = /^[a-f0-9]{12}$/;

/**
 * Is this a well-formed code? Used ONLY to decide whether the server-side click ping is
 * worth making. It must NOT change what the page renders: a malformed code, an unknown
 * code, an expired code and a used code all render the IDENTICAL page (see the route).
 */
export function isWellFormedInviteCode(code: string): boolean {
  return CODE_RE.test(code);
}

/**
 * Fire the PUBLIC click endpoint, best-effort. NEVER blocks or fails the render:
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
    await fetch(`${inviteApiBaseUrl()}/invites/${code}/click`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    // Swallowed by design (timeout, DNS, 5xx — all irrelevant to what the worker sees).
  } finally {
    clearTimeout(timer);
  }
}
