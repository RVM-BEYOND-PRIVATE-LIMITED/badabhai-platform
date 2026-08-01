/**
 * THEME-1 — shared theme primitives (NO server-only, NO React).
 *
 * Safe in both the server layout AND the client toggle/error boundary: it only deals in
 * the `bb_theme` cookie name + the no-FOUC inline-script string + the runtime helpers the
 * client toggle uses (read the cookie, apply `data-theme`, sync `<meta name="theme-color">`).
 * Every COLOR comes from the resolved DS token `--surface-page` read off the live document —
 * NEVER a raw hex literal — so the adherence gate (no raw hex/px in UI source) stays green
 * and the theme-color always tracks whatever the token layer flips to.
 */

import {
  THEME_COOKIE_NAME,
  THEME_COOKIE_MAX_AGE,
  parseThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme-constants";

export { THEME_COOKIE_NAME, THEME_COOKIE_MAX_AGE };
export type { ResolvedTheme, ThemePreference };

/**
 * The synchronous, dependency-free, CSP/nonce-safe no-FOUC script.
 *
 * Injected into the root `<head>` via `dangerouslySetInnerHTML`. It runs BEFORE first paint
 * and BEFORE React hydrates. When there is an explicit `paper`/`ink` cookie the SSR already
 * rendered the right `data-theme`, so this is a no-op. Only on the `system`/first-visit path
 * (no explicit cookie) does it read `prefers-color-scheme` and set `data-theme` — which is
 * why the SSR and client `data-theme` never diverge on the cookie path (no hydration mismatch).
 *
 * It is a plain string literal (no external dependency, no `\d+px`/hex tokens) so it survives
 * the adherence lint and any strict CSP that allows inline scripts by nonce/hash.
 */
export const THEME_NO_FOUC_SCRIPT = `(function(){try{
var n="${THEME_COOKIE_NAME}";
var m=document.cookie.match(new RegExp("(?:^|; )"+n+"=([^;]*)"));
var v=m?decodeURIComponent(m[1]):"";
var d=document.documentElement;
if(v!=="paper"&&v!=="ink"){
var dark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
if(dark){d.dataset.theme="ink";}else{d.removeAttribute("data-theme");}
}
var s=getComputedStyle(d).getPropertyValue("--surface-page").trim();
if(s){var mt=document.querySelector('meta[name="theme-color"]');if(mt){mt.setAttribute("content",s);}}
}catch(e){}})();`;

/**
 * The CROSS-ORIGIN stylesheets the shell wants but must not BLOCK first paint on:
 * Google Fonts (Baloo 2 + Mukta) and the three Phosphor icon sheets.
 *
 * Measured on the public `/i/<code>` install page (`next start`, production build): these
 * four sheets were 4 of 6 render-blocking stylesheets, 250,748 B of CSS from two extra
 * origins — on a page that uses ZERO icons. Every one of them cost a DNS + TLS + request
 * round trip before a worker on a congested 3G tower saw anything. That page exists to
 * convert an agent's QR scan into an install, so a blocking third-party round trip is the
 * single most expensive thing on it.
 *
 * WHY NOT A SECOND ROOT LAYOUT (the better fix): giving the public route its own root
 * layout means moving every portal route under a route group — measured at 101 files and
 * 244 relative imports rewritten, on a shared integration branch. Recorded, not attempted.
 */
export const ASYNC_STYLESHEETS: readonly string[] = [
  "https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;500;600;700;800&family=Mukta:wght@300;400;500;600;700;800&display=swap",
  "https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css",
  "https://unpkg.com/@phosphor-icons/web@2.1.1/src/bold/style.css",
  "https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css",
];

/**
 * Load {@link ASYNC_STYLESHEETS} WITHOUT blocking first paint.
 *
 * Injected as an inline `<head>` script exactly like {@link THEME_NO_FOUC_SCRIPT} above —
 * this layout already establishes that pattern, so it needs no client component and no
 * hydration. It appends each `<link rel=stylesheet>` at runtime, which by definition cannot
 * block the initial render. The `<noscript>` twins in the layout keep the sheets working
 * with JS disabled.
 *
 * The typography degrades gracefully in the gap: the Google Fonts URL already carries
 * `display=swap`, so text paints immediately in the fallback face and upgrades. Icons
 * (`ph ph-*`) appear a beat later on portal screens — the DS pairs every icon with a text
 * label precisely so the label carries the meaning, so nothing is unreadable meanwhile.
 *
 * Plain string literal, no external dependency, no hex/px tokens — survives the adherence
 * lint and a nonce/hash CSP, same as the no-FOUC script.
 */
export const ASYNC_CSS_SCRIPT = `(function(){try{
var u=${JSON.stringify(ASYNC_STYLESHEETS)};
for(var i=0;i<u.length;i++){
var l=document.createElement("link");l.rel="stylesheet";l.href=u[i];l.crossOrigin="anonymous";
document.head.appendChild(l);
}
}catch(e){}})();`;

/**
 * Read the persisted theme preference from `document.cookie` (client only). Returns the raw
 * preference (`paper`/`ink`/`system`) or `undefined` when unset/unknown. SSR-safe: returns
 * `undefined` when there is no `document`.
 */
export function readThemeCookieClient(): ThemePreference | undefined {
  if (typeof document === "undefined") return undefined;
  const m = document.cookie.match(new RegExp("(?:^|; )" + THEME_COOKIE_NAME + "=([^;]*)"));
  return parseThemePreference(m ? decodeURIComponent(m[1]!) : undefined);
}

/** Persist the theme preference to the SSR-readable cookie (client only). No PII; not httpOnly. */
export function writeThemeCookie(pref: ThemePreference): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    THEME_COOKIE_NAME +
    "=" +
    pref +
    "; Path=/; Max-Age=" +
    String(THEME_COOKIE_MAX_AGE) +
    "; SameSite=Lax" +
    secure;
}

/**
 * Resolve a preference into the theme to actually apply on the client, honouring the OS for
 * `system`. (The server uses the `paper` baseline for `system`; the client knows the OS.)
 */
export function resolvePreferenceClient(pref: ThemePreference): ResolvedTheme {
  if (pref === "ink" || pref === "paper") return pref;
  const dark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark ? "ink" : "paper";
}

/** Apply a resolved theme to `<html>` immediately (optimistic, no reload/flash). */
export function applyResolvedTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const d = document.documentElement;
  if (theme === "ink") d.dataset.theme = "ink";
  else d.removeAttribute("data-theme");
  syncThemeColorMeta();
}

/**
 * Sync `<meta name="theme-color">` to the resolved page surface so mobile browser chrome
 * matches the theme. The value is the COMPUTED `--surface-page` DS token off the live root —
 * no hex literal in source, and it tracks whatever the token layer resolves to per theme.
 */
export function syncThemeColorMeta(): void {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const surface = getComputedStyle(document.documentElement)
    .getPropertyValue("--surface-page")
    .trim();
  if (!surface) return;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", surface);
}
