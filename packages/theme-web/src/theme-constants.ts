/**
 * Shared theme constants + types (NO imports, NO side effects).
 *
 * Kept free of any runtime dependency so the server resolver and the client helpers can both
 * import it without pulling in React or a Next runtime. The default cookie name is payer-web's
 * proven `bb_theme`; a portal that shares a parent domain (admin-web) passes its own name.
 */

/** The persisted theme PREFERENCE (the explicit user choice, or `system`). */
export type ThemePreference = "paper" | "ink" | "system";

/** The RESOLVED theme actually applied to the `<html>` root (no `system` — it's resolved). */
export type ResolvedTheme = "paper" | "ink";

/** The default SSR-readable theme cookie (payer-web). NOT httpOnly; no PII. */
export const THEME_COOKIE_NAME = "bb_theme";

/** Admin-web's own cookie, so the two portals never fight on a shared domain. */
export const ADMIN_THEME_COOKIE_NAME = "bb_admin_theme";

/** ~1 year, in seconds — a durable preference that survives reload + navigation. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Coerce an arbitrary cookie string into a known preference (fail-soft → undefined). */
export function parseThemePreference(raw: string | undefined | null): ThemePreference | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "paper" || v === "ink" || v === "system" ? v : undefined;
}

/** The display-prefs wire values (`light`/`dark`/`system`) the API uses. */
export type DisplayTheme = "light" | "dark" | "system";

/** Map the server's `theme` value onto this module's preference. Unknown → undefined. */
export function displayThemeToPreference(theme: unknown): ThemePreference | undefined {
  if (theme === "light") return "paper";
  if (theme === "dark") return "ink";
  if (theme === "system") return "system";
  return undefined;
}

/** Map a preference onto the server's `theme` value. */
export function preferenceToDisplayTheme(pref: ThemePreference): DisplayTheme {
  return pref === "paper" ? "light" : pref === "ink" ? "dark" : "system";
}
