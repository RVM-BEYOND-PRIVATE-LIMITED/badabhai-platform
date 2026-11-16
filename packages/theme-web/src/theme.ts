/**
 * Shared theme primitives (NO server-only, NO React).
 *
 * Safe in both the server layout AND the client toggle/error boundary: cookie helpers, the
 * no-FOUC inline-script string, the runtime helpers the client toggle uses (read the cookie,
 * apply `data-theme`, sync `<meta name="theme-color">`) and the server/client resolution rules.
 * Every COLOR comes from the resolved DS token `--surface-page` read off the live document —
 * NEVER a raw hex literal — so the theme-color always tracks whatever the token layer flips to.
 */

import {
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_NAME,
  parseThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme-constants";

export {
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_NAME,
  displayThemeToPreference,
  parseThemePreference,
  preferenceToDisplayTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme-constants";

/**
 * Build the synchronous, dependency-free, CSP/nonce-safe no-FOUC script for one cookie name.
 *
 * It runs BEFORE first paint and BEFORE React hydrates. When there is an explicit `paper`/`ink`
 * cookie the SSR already rendered the right `data-theme`, so this is a no-op. Only on the
 * `system`/first-visit path (no explicit cookie) does it read `prefers-color-scheme` and set
 * `data-theme` — which is why the SSR and client `data-theme` never diverge on the cookie path.
 */
export function createThemeNoFoucScript(
  cookieName: string = THEME_COOKIE_NAME,
  serverPreference?: ThemePreference,
): string {
  // When the server has an authoritative value (the saved choice is open), the cookie must not
  // override it. Explicit paper/ink is already the SSR `data-theme`; `system` follows the OS.
  const choose =
    serverPreference === undefined
      ? `if(v!=="paper"&&v!=="ink"){
var dark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
if(dark){d.dataset.theme="ink";}else{d.removeAttribute("data-theme");}
}`
      : serverPreference === "system"
        ? `var dark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
if(dark){d.dataset.theme="ink";}else{d.removeAttribute("data-theme");}`
        : "";
  return `(function(){try{
var n=${JSON.stringify(cookieName)};
var m=document.cookie.match(new RegExp("(?:^|; )"+n+"=([^;]*)"));
var v=m?decodeURIComponent(m[1]):"";
var d=document.documentElement;
${choose}
var s=getComputedStyle(d).getPropertyValue("--surface-page").trim();
if(s){var mt=document.querySelector('meta[name="theme-color"]');if(mt){mt.setAttribute("content",s);}}
}catch(e){}})();`;
}

/** The payer-web no-FOUC script (the default `bb_theme` cookie). */
export const THEME_NO_FOUC_SCRIPT = createThemeNoFoucScript();

/**
 * Read the persisted theme preference from `document.cookie` (client only). Returns the raw
 * preference (`paper`/`ink`/`system`) or `undefined` when unset/unknown. SSR-safe: returns
 * `undefined` when there is no `document`.
 */
export function readThemeCookieClient(
  cookieName: string = THEME_COOKIE_NAME,
): ThemePreference | undefined {
  if (typeof document === "undefined") return undefined;
  const m = document.cookie.match(new RegExp("(?:^|; )" + cookieName + "=([^;]*)"));
  return parseThemePreference(m ? decodeURIComponent(m[1]!) : undefined);
}

/** Persist the theme preference to the SSR-readable cookie (client only). No PII; not httpOnly. */
export function writeThemeCookie(
  pref: ThemePreference,
  cookieName: string = THEME_COOKIE_NAME,
): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    cookieName +
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

/**
 * Pick the preference a toggle starts from after hydration. An authoritative server value (the
 * saved choice, when the switch is open) wins over the cookie cache; with neither, follow the OS.
 */
export function resolveStartPreference(
  initialPreference?: ThemePreference,
  cookiePreference?: ThemePreference,
): ThemePreference {
  return initialPreference ?? cookiePreference ?? "system";
}

/**
 * Resolve the theme to render server-side from an already-read cookie value.
 *
 * Precedence: explicit cookie (`paper`/`ink`) → env default (`PAYER_THEME`, back-compat) →
 * `system`/`paper`. For `system` (or no cookie + no env default) the server CANNOT know the OS,
 * so it resolves to the stable `paper` baseline and the no-FOUC script corrects it before paint.
 */
export function resolveServerTheme(
  cookieValue?: string | null,
  envDefault?: ThemePreference | null,
): ResolvedTheme {
  const pref = parseThemePreference(cookieValue);
  if (pref === "ink" || pref === "paper") return pref; // explicit user choice wins
  if (pref === "system") return "paper"; // user asked to follow OS → stable server baseline
  const env = parseThemePreference(envDefault);
  if (env === "ink" || env === "paper") return env;
  return "paper";
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

/** The client helpers a rendered ThemeToggle needs, bound to one cookie name. */
export interface ThemeRuntime {
  applyResolvedTheme: (theme: ResolvedTheme) => void;
  readThemeCookieClient: () => ThemePreference | undefined;
  resolvePreferenceClient: (pref: ThemePreference) => ResolvedTheme;
  syncThemeColorMeta: () => void;
  writeThemeCookie: (pref: ThemePreference) => void;
}

/** Bind the shared helpers to one cookie name (the default is payer-web's `bb_theme`). */
export function themeRuntimeFor(cookieName: string = THEME_COOKIE_NAME): ThemeRuntime {
  return {
    applyResolvedTheme,
    readThemeCookieClient: () => readThemeCookieClient(cookieName),
    resolvePreferenceClient,
    syncThemeColorMeta,
    writeThemeCookie: (pref) => writeThemeCookie(pref, cookieName),
  };
}
