import type { ReferralClickPlatform } from "@badabhai/db";

/**
 * PURE resolution logic for `GET /r/:code` (B4). No DB, no config object, no Nest — so the
 * branch table and the fallback chain can be tested exhaustively without a request.
 */

/** The shape a referral code may take: 12 lowercase hex. Both legacy funnels use it. */
const CODE_RE = /^[a-f0-9]{12}$/;

export function isWellFormedReferralCode(code: string): boolean {
  return CODE_RE.test(code);
}

/**
 * Coarse device class from the User-Agent. Deliberately crude: this picks a REDIRECT, and
 * being wrong costs a worker one extra tap on a page that still works. It is never used
 * for identity, and nothing is persisted but the three-value enum.
 */
export function platformFromUserAgent(userAgent: string | undefined): ReferralClickPlatform {
  const ua = (userAgent ?? "").toLowerCase();
  if (ua.includes("android")) return "android";
  // iOS is out of scope (Android-first) — it lands in the masked-page branch with desktop,
  // which is the correct destination for it anyway: there is no iOS app to open.
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) return "other";
  if (
    ua.includes("windows") ||
    ua.includes("macintosh") ||
    ua.includes("x11") ||
    ua.includes("linux")
  ) {
    return "desktop";
  }
  return "other";
}

/**
 * Link-preview crawlers and bots. WHY THIS MATTERS BEYOND TIDINESS: WhatsApp fetches a
 * shared URL to build its preview card, and this URL's whole job is to be shared on
 * WhatsApp. Counting that fetch as a click would inflate the funnel — and worse, a crawler
 * prefetch would create the click row that a real worker's install then claims as its
 * "first touch", attributing an install to a robot's timestamp instead of the human's.
 *
 * Conservative by design: a missing/blank UA is treated as a BOT (no click logged). A
 * dropped click costs one funnel statistic; a fabricated one corrupts attribution, which
 * is the thing this whole workstream exists to make trustworthy.
 */
export function isLikelyBot(userAgent: string | undefined): boolean {
  const ua = (userAgent ?? "").trim().toLowerCase();
  if (ua.length === 0) return true;
  return [
    "whatsapp",
    "facebookexternalhit",
    "facebot",
    "telegrambot",
    "twitterbot",
    "slackbot",
    "linkedinbot",
    "discordbot",
    "skypeuripreview",
    "embedly",
    "quora link preview",
    "pinterest",
    "redditbot",
    "applebot",
    "googlebot",
    "bingbot",
    "yandexbot",
    "duckduckbot",
    "baiduspider",
    "petalbot",
    "curl/",
    "wget/",
    "python-requests",
    "axios/",
    "go-http-client",
    "node-fetch",
    "headlesschrome",
    "bot",
    "crawler",
    "spider",
    "preview",
  ].some((needle) => ua.includes(needle));
}

/** Where `GET /r/:code` sends a visitor, and why. */
export interface ResolveTarget {
  url: string;
  /**
   * Which leg of the chain this is. Diagnostics + tests; never surfaced to the visitor.
   *  - "app_link"    the https App Link. Android opens the APP if verification has landed
   *                  (P0-6); if not, the same URL renders the masked page, which then
   *                  offers `intent://` → Play Store. One URL, whole chain, no dead end.
   *  - "masked_page" the DESKTOP landing page — a QR to scan with a phone.
   */
  leg: "app_link" | "masked_page";
}

/**
 * THE BRANCH TABLE. One rule, stated once:
 *
 *   android            → the App Link            `<base>/i/<code>`
 *   desktop            → the QR page             `<base>/i/<code>/desktop`
 *   other (iOS/unknown)→ the App Link route      `<base>/i/<code>`
 *
 * WHY ANDROID AND "OTHER" SHARE A DESTINATION. `<base>/i/<code>` is simultaneously (a) the
 * URL the worker app's manifest claims as a verified App Link and (b) a real, rendered web
 * page. On Android with verification live, the OS intercepts it and the app opens — the page
 * is never fetched. Without verification (the P0-6 dependency, NOT met yet), the identical
 * URL renders the page, which carries the `intent://` attempt and the Play Store button with
 * the `referrer` payload attached. iOS/unknown gets the same page, which is honest: there is
 * no iOS app, and the page's Play Store CTA is the truthful thing to show.
 *
 * That is what makes the fallback chain STRUCTURAL rather than a sequence of hops that can
 * each fail: App Link → intent:// → Play Store (+referrer) → masked page, with no step able
 * to dead-end, because the last step is the page that hosts the earlier ones.
 *
 * DESKTOP GETS ITS OWN ROUTE, not a query flag. A QR needs a JS encoder, which needs a
 * client component; putting it on the shared route would ship that bundle to the ₹7k-phone
 * mobile path too, breaking that page's deliberate zero-client-JS guarantee. A separate
 * segment keeps the cost where the capability is used.
 */
export function resolveTarget(input: {
  base: string;
  code: string;
  platform: ReferralClickPlatform;
}): ResolveTarget {
  const base = input.base.replace(/\/+$/, "");
  const path = `${base}/i/${encodeURIComponent(input.code)}`;
  if (input.platform === "desktop") return { url: `${path}/desktop`, leg: "masked_page" };
  return { url: path, leg: "app_link" };
}

/**
 * Where an UNRESOLVABLE code goes. A malformed or unknown code must still land somewhere
 * sensible — "a shared link should never dead-end". It gets the landing page with a
 * placeholder code, so the visitor can still install the app; they simply arrive
 * unattributed. (`unknown` fails the 12-hex shape check, so the page's own click ping
 * correctly declines to fire for it.)
 *
 * This is also what keeps the endpoint from being an existence ORACLE: a valid code and a
 * garbage one both 302 to a page, and neither response body says which it was.
 */
export function fallbackTarget(base: string): string {
  return `${base.replace(/\/+$/, "")}/i/unknown`;
}
