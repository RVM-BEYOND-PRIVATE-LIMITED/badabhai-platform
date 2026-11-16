import "server-only";
import { cache } from "react";
import type { DisplayPrefsResponse, DisplayTheme } from "@badabhai/types";
import { displayPrefsResponseSchema } from "@badabhai/validators";
import { adminFetch } from "./admin-http";
import { readAdminToken } from "./auth/session-cookie";

/**
 * Server-saved display preferences for an admin login (#2821).
 *
 * The call is made through `adminFetch` — the one server-only transport that reads the admin
 * token.
 *
 * Failure is ALWAYS the closed case: no token, a missing route, a 5xx or a network fault return
 * `null`, which callers treat as `theme_open: false` → admin stays Light and ignores the cookie.
 */
export async function getDisplayPrefs(): Promise<DisplayPrefsResponse | null> {
  try {
    if (!(await readAdminToken())) return null;
    return await adminFetch("/admin/me/display-prefs", {
      schema: displayPrefsResponseSchema,
    });
  } catch {
    return null;
  }
}

/**
 * Persist a theme for the signed-in admin. A 404 means the switch closed meanwhile; like a lost
 * network it returns `null`, and the caller keeps the local choice.
 */
/** Request-scoped memo: the root layout and the portal layout share one GET. */
export const getDisplayPrefsCached = cache(getDisplayPrefs);

export async function saveDisplayPrefs(
  theme: DisplayTheme,
): Promise<DisplayPrefsResponse | null> {
  try {
    return await adminFetch("/admin/me/display-prefs", {
      method: "PATCH",
      body: { theme },
      schema: displayPrefsResponseSchema,
    });
  } catch {
    return null;
  }
}
