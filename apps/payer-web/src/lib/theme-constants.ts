/**
 * THEME-1 — pure theme constants + types (NO imports, NO side effects).
 *
 * Shared by BOTH the server resolver (`config.ts`) and the client helpers (`theme.ts`) so the
 * client theme module never has to import `config.ts`. That decoupling matters: several tests
 * fully replace `lib/config` with a partial mock — pulling the cookie constants from here keeps
 * the DS barrel (which re-exports the ThemeToggle) independent of that mock.
 */

/** The persisted theme PREFERENCE (the explicit user choice, or `system`). */
export type ThemePreference = "paper" | "ink" | "system";

/** The RESOLVED theme actually applied to the `<html>` root (no `system` — it's resolved). */
export type ResolvedTheme = "paper" | "ink";

/** The SSR-readable theme cookie. NOT httpOnly (the client toggle reads it); no PII. */
export const THEME_COOKIE_NAME = "bb_theme";

/** ~1 year, in seconds — a durable preference that survives reload + navigation. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Coerce an arbitrary cookie string into a known preference (fail-soft → undefined). */
export function parseThemePreference(raw: string | undefined | null): ThemePreference | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "paper" || v === "ink" || v === "system" ? v : undefined;
}
