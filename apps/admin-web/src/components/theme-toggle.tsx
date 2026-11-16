"use client";

/**
 * Admin-web ThemeToggle — the shared control, bound to admin-web's OWN cookie
 * (`bb_admin_theme`) so the two portals never fight on a shared parent domain.
 *
 * It is rendered by the shell only when the server says `theme_open`; the portal layout supplies
 * the server's authoritative preference and the persistence action as props.
 */

import {
  ADMIN_THEME_COOKIE_NAME,
  createThemeToggle,
  themeRuntimeFor,
} from "@badabhai/theme-web";

export type { ThemeToggleProps } from "@badabhai/theme-web";

export const ThemeToggle = createThemeToggle({
  helpers: themeRuntimeFor(ADMIN_THEME_COOKIE_NAME),
});
