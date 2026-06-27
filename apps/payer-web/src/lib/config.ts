import { z } from "zod";
import { loadPublicConfig } from "@badabhai/config/public";
import {
  THEME_COOKIE_NAME,
  THEME_COOKIE_MAX_AGE,
  parseThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme-constants";

// Re-export the shared theme constants/types so existing consumers + tests can keep importing
// them from `lib/config` (the server-facing theme surface).
export {
  THEME_COOKIE_NAME,
  THEME_COOKIE_MAX_AGE,
  parseThemePreference,
  type ResolvedTheme,
  type ThemePreference,
};

/**
 * Browser-safe config for the external payer portal.
 *
 * SECURITY: uses ONLY the public (`NEXT_PUBLIC_*`) entry point, so the client
 * bundle never depends on a backend secret. Server-only config (the payer-auth
 * mode flag, the API base URL used server-side, the interim internal-service
 * token) is read straight from `process.env` inside Server Components / Route
 * Handlers / Server Actions — NEVER from this module.
 *
 * XB self-check: no server secret is exported here; the payer-auth seam config
 * (`server-config.ts`) is the only place `process.env` server-only keys are read.
 */
export const publicConfig = loadPublicConfig();

/**
 * AGENCY-PORTAL public feature flags (ADR-0019 DEMAND extension).
 *
 * These are PUBLIC, `NEXT_PUBLIC_*` booleans only — NO secret ever lives here, so
 * they are safe in the client bundle. Every gate-flag is FAIL-CLOSED: only the
 * literal string "true" enables it; unset / "false" / anything else keeps it OFF.
 *
 * Scope (HARD LOCKS, CLAUDE.md §2 / §8 + the agency ADRs):
 *  - `agencyPortalEnabled` gates the agency DEMAND shell (dashboard). Default ON.
 *  - `agencySupplyEnabled`, `agencyKycEnabled`, `agencyPayoutsEnabled`,
 *    `agencyBulkUploadEnabled`, `agencyOutcomeTrackingEnabled` are ALL default
 *    OFF and there is NO code path that builds those flows. They drive the
 *    PARKED-module LABELS only — flipping any one of them on ships NOTHING by
 *    itself. KYC / payouts / bulk-upload / outcome-tracking are CEO/legal-gated.
 *
 * Read these via {@link agencyFlags} (validated, cached) — never `process.env`
 * directly in a component.
 */
const agencyFlagsSchema = z.object({
  /** Agency DEMAND shell (dashboard) gate. Default ON. Off → routes notFound(). */
  agencyPortalEnabled: z.boolean(),
  /** SUPPLY (referral funnel). PARKED Phase-2 (CEO-gated). Default OFF. */
  agencySupplyEnabled: z.boolean(),
  /** KYC (HIGH-sensitivity PII). PARKED — legal/DPDP sign-off required. Default OFF. */
  agencyKycEnabled: z.boolean(),
  /** Payouts (real money out). PARKED — TD34 + product-ratified params. Default OFF. */
  agencyPayoutsEnabled: z.boolean(),
  /** Bulk raw-phone/CSV invite upload. DEAD — consent violation. Default OFF. */
  agencyBulkUploadEnabled: z.boolean(),
  /** Matching / hire-outcome tracking. DEFERRED by product lock. Default OFF. */
  agencyOutcomeTrackingEnabled: z.boolean(),
});

export type AgencyFlags = z.infer<typeof agencyFlagsSchema>;

/** Fail-closed boolean: ONLY the literal "true" is on; anything else is off. */
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

let cachedAgencyFlags: AgencyFlags | null = null;

/**
 * Resolve the (cached, validated) agency public flags. Safe in client and server
 * components — every value is a `NEXT_PUBLIC_*` boolean, never a secret.
 */
export function agencyFlags(): AgencyFlags {
  if (cachedAgencyFlags) return cachedAgencyFlags;
  cachedAgencyFlags = agencyFlagsSchema.parse({
    // DEMAND shell defaults ON (the only built-now agency surface).
    agencyPortalEnabled: flag(process.env.NEXT_PUBLIC_ENABLE_AGENCY_PORTAL, true),
    // Everything below is PARKED/DEAD/DEFERRED — default OFF, no code path behind it.
    agencySupplyEnabled: flag(process.env.NEXT_PUBLIC_ENABLE_AGENCY_SUPPLY, false),
    agencyKycEnabled: flag(process.env.NEXT_PUBLIC_ENABLE_AGENCY_KYC, false),
    agencyPayoutsEnabled: flag(process.env.NEXT_PUBLIC_ENABLE_AGENCY_PAYOUTS, false),
    agencyBulkUploadEnabled: flag(process.env.NEXT_PUBLIC_ENABLE_AGENCY_BULK_UPLOAD, false),
    agencyOutcomeTrackingEnabled: flag(
      process.env.NEXT_PUBLIC_ENABLE_AGENCY_OUTCOME_TRACKING,
      false,
    ),
  });
  return cachedAgencyFlags;
}

/** Test-only: clear the memoized flags so a test can re-read changed env. */
export function __resetAgencyFlagsForTest(): void {
  cachedAgencyFlags = null;
}

/**
 * PORTAL THEME (THEME-1) — the light⇄dark (paper/ink) selector.
 *
 * The whole portal is token-driven, and `src/styles/tokens.css` defines a full
 * `[data-theme="ink"]` block that flips the semantic surface/text tokens. Setting
 * `data-theme="ink"` on the portal shell (the <html> root) therefore re-themes the
 * entire app with zero per-screen changes.
 *
 * THREE preference values flow through the app:
 *  - the persisted user CHOICE — the SSR-readable `bb_theme` cookie ∈ paper|ink|system
 *    (NOT httpOnly so the client toggle reads/writes it; carries NO PII);
 *  - the env DEFAULT — `PAYER_THEME` / `NEXT_PUBLIC_PAYER_THEME` (back-compat seam);
 *  - the OS preference — only knowable in the browser (`prefers-color-scheme`), so the
 *    server resolves `system` to a stable default and the inline no-FOUC script in the
 *    root <head> corrects it before first paint.
 *
 * `resolvePayerTheme()` is a PURE function of the (already-read) cookie value so it stays
 * unit-testable in the node env without `next/headers`. The server layout reads the cookie
 * with {@link readThemeCookie} and passes it in. No secret is read here.
 */

/** The env DEFAULT (back-compat): `PAYER_THEME=ink` / `NEXT_PUBLIC_PAYER_THEME=ink`. */
function envThemeDefault(): ResolvedTheme | "system" {
  const raw = (process.env.PAYER_THEME ?? process.env.NEXT_PUBLIC_PAYER_THEME ?? "")
    .trim()
    .toLowerCase();
  return raw === "ink" ? "ink" : raw === "paper" ? "paper" : "system";
}

/**
 * Resolve the theme to render server-side, given the (already-read) `bb_theme` cookie value.
 *
 * Precedence: explicit cookie (`paper`/`ink`) → env `PAYER_THEME` (back-compat) →
 * `system`/`paper`. For `system` (cookie says system, or no cookie + no env default) the
 * server CANNOT know the OS preference, so it resolves to the stable `paper` default and the
 * inline script corrects it before paint. Returns one of `"paper" | "ink"`.
 */
export function resolvePayerTheme(cookieValue?: string | null): ResolvedTheme {
  const pref = parseThemePreference(cookieValue);
  if (pref === "ink" || pref === "paper") return pref; // explicit user choice wins
  if (pref === "system") return systemFallback(); // user asked to follow OS → stable default
  // No (valid) cookie → fall back to the env default, then to the system/paper baseline.
  const env = envThemeDefault();
  if (env === "ink" || env === "paper") return env;
  return systemFallback();
}

/**
 * Server-side fallback for `system`: the server can't read `prefers-color-scheme`, so it
 * renders the stable `paper` baseline. The inline no-FOUC script flips it to ink before the
 * first paint when the OS prefers dark — and the SSR/client `data-theme` only ever diverge on
 * this no-explicit-cookie path (the script runs before React hydrates), so there is no
 * hydration mismatch on the cookie path.
 */
function systemFallback(): ResolvedTheme {
  return "paper";
}
