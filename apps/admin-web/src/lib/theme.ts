import type { ResolvedTheme, ThemePreference } from "@badabhai/theme-web";
import {
  ADMIN_THEME_COOKIE_NAME,
  displayThemeToPreference,
  resolveServerTheme,
  THEME_COOKIE_MAX_AGE,
} from "@badabhai/theme-web";

/**
 * Admin-web theme surface.
 *
 * `bb_admin_theme` is the ONLY cookie this portal reads or writes. While the server-saved choice
 * is closed, the portal never reads it for paint and never writes it — admin-web is Light, exactly
 * as today. `displayThemeToPreference` maps the API's `light`/`dark`/`system` onto the shared
 * `paper`/`ink`/`system` preference.
 */
export { ADMIN_THEME_COOKIE_NAME, THEME_COOKIE_MAX_AGE };

/** The cookie admin-web uses (never `bb_theme`). */
export const THEME_COOKIE_NAME = ADMIN_THEME_COOKIE_NAME;

/** Resolve the server's display-prefs theme for the root `<html>` first paint. */
export function resolveAdminTheme(theme: unknown): ResolvedTheme {
  return resolveServerTheme(displayThemeToPreference(theme));
}

/**
 * The first-paint theme for the admin root. `undefined` when the choice is closed — the root then
 * sets NO `data-theme`, so `bb_admin_theme` is ignored and admin-web is Light exactly as today.
 */
export function adminRootTheme(
  prefs: { theme_open: boolean; theme: unknown } | null,
): ResolvedTheme | undefined {
  return prefs?.theme_open ? resolveAdminTheme(prefs.theme) : undefined;
}

/** The preference stored in the admin cookie. */
export function adminThemePreference(theme: unknown): ThemePreference | undefined {
  return displayThemeToPreference(theme);
}
