/**
 * Payer-web theme constants — re-exported from the shared package.
 *
 * Kept as a module of its own because several tests fully replace `lib/config` with a partial
 * mock; importing the cookie constants from here keeps the DS barrel independent of that mock.
 */

export {
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_NAME,
  parseThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@badabhai/theme-web";
