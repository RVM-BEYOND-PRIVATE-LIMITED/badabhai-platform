"use server";

import { preferenceToDisplayTheme, type ThemePreference } from "@badabhai/theme-web";
import { saveDisplayPrefs } from "../../lib/display-prefs";

/**
 * Persist the payer's theme through the server (#2822). Called only when the server-saved choice
 * is open; the closed case never renders a `onPersist` prop, so no write happens.
 *
 * The action is deliberately tiny: the token decides whose row is written, and a closed switch
 * (404) is swallowed by `saveDisplayPrefs`, leaving the local cookie choice in force.
 */
export async function savePayerTheme(pref: ThemePreference): Promise<void> {
  await saveDisplayPrefs(preferenceToDisplayTheme(pref));
}
