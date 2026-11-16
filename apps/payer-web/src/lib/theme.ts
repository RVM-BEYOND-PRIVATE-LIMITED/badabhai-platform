/**
 * Payer-web theme surface — now a thin re-export of the shared `@badabhai/theme-web` package.
 *
 * The proven THEME-1 code (cookie helpers, no-FOUC script, theme-color sync, client resolution)
 * lives in `packages/theme-web`. This module keeps the historical import path (`lib/theme`) for
 * the portal and its tests, and keeps the two non-theme stylesheet helpers that belong to this
 * app's shell rather than to the shared theme layer.
 */

export {
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_NAME,
  THEME_NO_FOUC_SCRIPT,
  applyResolvedTheme,
  readThemeCookieClient,
  resolvePreferenceClient,
  resolveServerTheme,
  syncThemeColorMeta,
  writeThemeCookie,
  type ResolvedTheme,
  type ThemePreference,
} from "@badabhai/theme-web";

/**
 * The CROSS-ORIGIN stylesheet the shell wants but must not BLOCK first paint on: Google Fonts
 * (Anek + Inter + Roboto).
 *
 * THE ICON SHEET IS NO LONGER HERE. Phosphor FILL used to be appended from unpkg.com by this
 * loader — a third-party runtime dependency that no package manifest declared, and an icon face
 * that could not load if that CDN was down or blocked. It is now SELF-HOSTED: `globals.css`
 * imports `@badabhai/icons/icons.css`, the bundler emits the font under `/_next/static/media`, and
 * the browser fetches it from this app's own origin, only on a page that paints a glyph.
 *
 * Plain string literal, no external dependency, no hex/px tokens — survives the adherence
 * lint and a nonce/hash CSP, same as the no-FOUC script.
 */
export const ASYNC_STYLESHEETS: readonly string[] = [
  // UI-1 — Inter joins as the Latin UI face (--font-sans). Roboto STAYS in this URL and is
  // not optional: it is the Devanagari half of the --font-sans chain, and font fallback is
  // resolved per glyph, so dropping it would silently re-render every Hindi/Hinglish run in
  // a system face. Anek keeps the brand voice (wordmark, headings, buttons).
  // Google Fonts splits each family by unicode-range, so the Devanagari bytes are only
  // fetched by a page that actually paints a Devanagari glyph.
  "https://fonts.googleapis.com/css2?family=Anek+Latin:wght@400;500;600;700;800&family=Anek+Devanagari:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&family=Roboto:wght@300;400;500;700&display=swap",
];

/**
 * Load {@link ASYNC_STYLESHEETS} WITHOUT blocking first paint.
 *
 * Injected as an inline `<head>` script exactly like the no-FOUC script — this layout already
 * establishes that pattern, so it needs no client component and no hydration. It appends each
 * `<link rel=stylesheet>` at runtime, which by definition cannot block the initial render. The
 * `<noscript>` twins in the layout keep the sheets working with JS disabled.
 */
export const ASYNC_CSS_SCRIPT = `(function(){try{
var u=${JSON.stringify(ASYNC_STYLESHEETS)};
for(var i=0;i<u.length;i++){
var l=document.createElement("link");l.rel="stylesheet";l.href=u[i];l.crossOrigin="anonymous";
document.head.appendChild(l);
}
}catch(e){}})();`;
