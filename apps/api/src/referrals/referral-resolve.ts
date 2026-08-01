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
   *  - "masked_page" the landing page, explicitly in desktop/QR mode.
   */
  leg: "app_link" | "masked_page";
}

/**
 * THE BRANCH TABLE. One rule, stated once:
 *
 *   android  → the App Link (`<base>/i/<code>`)
 *   anything → the masked landing page in desktop mode (`<base>/i/<code>?v=desktop`)
 *
 * WHY BOTH LEGS POINT AT THE SAME ROUTE. `<base>/i/<code>` is simultaneously (a) the URL
 * the worker app's manifest claims as a verified App Link and (b) a real, rendered web
 * page. On Android with verification live, the OS intercepts it and the app opens — the
 * page is never fetched. Without verification (the P0-6 dependency, which is NOT met yet),
 * the identical URL renders the page, which carries the `intent://` attempt and the Play
 * Store button with the `referrer` payload attached.
 *
 * That is what makes the fallback chain STRUCTURAL rather than a sequence of hops that can
 * each fail: App Link → intent:// → Play Store (+referrer) → masked page, with no step able
 * to dead-end, because the last step is the page that hosts the earlier ones.
 *
 * `v=desktop` is a RENDER HINT only — never an attribution input. The page must render
 * something correct for any value or none.
 */
export function resolveTarget(input: {
  base: string;
  code: string;
  platform: ReferralClickPlatform;
}): ResolveTarget {
  const base = input.base.replace(/\/+$/, "");
  const path = `${base}/i/${encodeURIComponent(input.code)}`;
  if (input.platform === "android") return { url: path, leg: "app_link" };
  return { url: `${path}?v=desktop`, leg: "masked_page" };
}

/**
 * Where an UNRESOLVABLE code goes. A malformed or unknown code must still land somewhere
 * sensible — "a shared link should never dead-end". It gets the masked page with NO code,
 * so the visitor can still install the app; they simply arrive unattributed.
 *
 * This is also what keeps the endpoint from being an existence ORACLE: a valid code and a
 * garbage one both 302 to a page, and neither response body says which it was.
 */
export function fallbackTarget(base: string): string {
  return `${base.replace(/\/+$/, "")}/i/unknown?v=desktop`;
}
