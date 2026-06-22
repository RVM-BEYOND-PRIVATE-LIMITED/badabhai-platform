import "server-only";

/**
 * SERVER-ONLY configuration for the payer portal (ADR-0019 Phase 1).
 *
 * This module imports `server-only`, so any accidental import from a Client
 * Component is a BUILD ERROR — the values here (API base URL, the payer-auth mode,
 * the agency-supply flag) never reach the browser bundle.
 *
 * ADR-0019 Decision D / §7: NO real payments. `PAYMENTS_ENABLE_REAL` is read
 * here ONLY to assert it is false at boot — a real-payment path is a HARD human
 * gate (E-R2 / TD34). The portal has no Razorpay code.
 *
 * NOTE on the interim InternalServiceGuard token: the data seam (`payer-http.ts`)
 * sends a payer JWT as `Authorization: Bearer <jwt>` ONLY. It NEVER sends an
 * internal-service token. The dead `INTERNAL_SERVICE_TOKEN` config was removed (D1):
 * a server-to-server internal token must never leave this app via the payer seam.
 */

export type PayerAuthMode = "mock" | "api";

export interface PayerServerConfig {
  /**
   * The payer-auth seam mode (ADR-0019 Decision B):
   *  - "api"  → LIVE staging: the backend payer-auth routes (`/payer/login/*`,
   *    `/payer/me`) issue + validate a real payer JWT (R16/LC-1 landed on main).
   *  - "mock" → local/test fallback: an HMAC-signed self-contained session, no
   *    backend. This is NOT a real IdP — B-R1 (a true external IdP/MFA) stays OPEN
   *    as a separate human gate; "api" here is the backend's own OTP login, which
   *    is the authorized Phase-1 LIVE login.
   */
  authMode: PayerAuthMode;
  /** API base URL used SERVER-SIDE only (route handlers / server actions). */
  apiBaseUrl: string;
  /** Asserted false in Phase 1 — real payments are a HARD human gate. */
  paymentsEnableReal: boolean;
  /**
   * Agency SUPPLY (referrals/payouts/KYC) feature flag — fail-closed boolean, default
   * FALSE (D1/D2). Supply is PARKED to Phase 2 (CEO-gated); the agency referrals page
   * only reads this to LABEL its parked state. Flipping it on builds NOTHING by itself —
   * there is no referral/payout/KYC code behind it.
   */
  agencySupplyEnabled: boolean;
}

let cached: PayerServerConfig | null = null;

/** Load + validate the server-only payer config (fail-closed on a real-payment flag). */
export function payerServerConfig(): PayerServerConfig {
  if (cached) return cached;

  const rawMode = (process.env.PAYER_AUTH_MODE ?? "api").trim().toLowerCase();
  if (rawMode !== "mock" && rawMode !== "api") {
    // Any OTHER mode (a third-party IdP, etc.) is B-R1 — a separate human gate.
    throw new Error(
      `PAYER_AUTH_MODE="${rawMode}" is not authorized in Phase 1 (ADR-0019). Only "api" (backend payer-auth) or "mock" (local fallback) are allowed; a third-party IdP is a separate human gate (B-R1 OPEN).`,
    );
  }
  const authMode: PayerAuthMode = rawMode === "mock" ? "mock" : "api";

  const paymentsEnableReal =
    (process.env.PAYMENTS_ENABLE_REAL ?? "false").trim().toLowerCase() === "true";
  if (paymentsEnableReal) {
    // ADR-0019 Decision D / §7 hard stop — the portal has no real-payment code.
    throw new Error(
      "PAYMENTS_ENABLE_REAL=true is a HARD human gate (ADR-0019 E-R2 / TD34). The payer portal ships MOCK-only; refusing to boot.",
    );
  }

  // Fail-closed: ONLY an explicit "true" enables agency supply; anything else (unset,
  // "false", garbage) keeps it OFF. Supply is CEO-gated Phase-2 (D2).
  const agencySupplyEnabled =
    (process.env.AGENCY_SUPPLY_ENABLED ?? "false").trim().toLowerCase() === "true";

  cached = {
    authMode,
    apiBaseUrl: process.env.PAYER_API_URL ?? "http://localhost:3001",
    paymentsEnableReal: false,
    agencySupplyEnabled,
  };
  return cached;
}
