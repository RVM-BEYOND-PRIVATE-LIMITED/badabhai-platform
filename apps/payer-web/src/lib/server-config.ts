import "server-only";

/**
 * SERVER-ONLY configuration for the payer portal (ADR-0019 Phase 1).
 *
 * This module imports `server-only`, so any accidental import from a Client
 * Component is a BUILD ERROR — the values here (API base URL, the agency-supply
 * flag) never reach the browser bundle.
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

export interface PayerServerConfig {
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
    apiBaseUrl: process.env.PAYER_API_URL ?? "http://localhost:3001",
    paymentsEnableReal: false,
    agencySupplyEnabled,
  };
  return cached;
}
