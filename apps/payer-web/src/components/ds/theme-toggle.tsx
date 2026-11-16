"use client";

/**
 * Payer-web ThemeToggle — the shared control, bound to this portal's proven `bb_theme` cookie
 * and its historical `lib/theme` helper module (which several tests mock).
 *
 * Behaviour is unchanged. When the server-saved choice is open, the portal passes
 * `initialPreference` and `onPersist` as props; when it is closed it passes neither and the
 * toggle is exactly THEME-1 (cookie only).
 */

import { createThemeToggle } from "@badabhai/theme-web";
import {
  applyResolvedTheme,
  readThemeCookieClient,
  resolvePreferenceClient,
  syncThemeColorMeta,
  writeThemeCookie,
} from "../../lib/theme";

export { THEME_ANIM_CLASS, THEME_ANIM_SETTLE_MS, cssTimeMs } from "@badabhai/theme-web";
export type { ThemeToggleProps } from "@badabhai/theme-web";

export const ThemeToggle = createThemeToggle({
  helpers: {
    applyResolvedTheme,
    readThemeCookieClient,
    resolvePreferenceClient,
    syncThemeColorMeta,
    writeThemeCookie,
  },
});
