"use server";

import { preferenceToDisplayTheme, type ThemePreference } from "@badabhai/theme-web";
import { saveDisplayPrefs } from "../../lib/display-prefs";

/**
 * Persist the admin's theme through the server (#2821). Called only when the server-saved choice
 * is open; the closed case never renders the toggle, so no write can happen.
 */
export async function saveAdminTheme(pref: ThemePreference): Promise<void> {
  await saveDisplayPrefs(preferenceToDisplayTheme(pref));
}
