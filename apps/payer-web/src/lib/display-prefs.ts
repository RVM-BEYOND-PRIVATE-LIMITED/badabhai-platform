import "server-only";
import { cache } from "react";
import type { DisplayPrefsResponse, DisplayTheme } from "@badabhai/types";
import { displayPrefsResponseSchema } from "@badabhai/validators";
import { payerFetch } from "./payer-http";
import { readApiToken } from "./auth/session-cookie";

/**
 * Server-saved display preferences for a company/agency login (#2822).
 *
 * The call is made through `payerFetch` — the ONE place payer-web reaches the API — so it carries
 * the session token and the visitor IP like every other read.
 *
 * Failure is ALWAYS the closed case, never an error page: no token, an old server without the
 * route (404), a 5xx or a network fault all return `null`, which callers treat as
 * `theme_open: false` (today's cookie-only behaviour for payer-web).
 */
export async function getDisplayPrefs(): Promise<DisplayPrefsResponse | null> {
  try {
    if (!(await readApiToken())) return null;
    return await payerFetch("/payer/me/display-prefs", {
      schema: displayPrefsResponseSchema,
    });
  } catch {
    return null;
  }
}

/**
 * Persist a theme for the signed-in company/agency login. A 404 means the switch closed
 * meanwhile; like a lost network it returns `null`, and the caller keeps the local choice.
 */
/** Request-scoped memo: the root layout and the portal layout share one GET. */
export const getDisplayPrefsCached = cache(getDisplayPrefs);

export async function saveDisplayPrefs(
  theme: DisplayTheme,
): Promise<DisplayPrefsResponse | null> {
  try {
    return await payerFetch("/payer/me/display-prefs", {
      method: "PATCH",
      body: { theme },
      schema: displayPrefsResponseSchema,
    });
  } catch {
    return null;
  }
}
