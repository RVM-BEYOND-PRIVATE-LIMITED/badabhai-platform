import "server-only";

/**
 * SERVER-ONLY configuration for the payer portal (ADR-0019 Phase 1).
 *
 * This module imports `server-only`, so any accidental import from a Client
 * Component is a BUILD ERROR — the values here (API base URL, the agency-supply
 * flag) never reach the browser bundle.
 *
 * REAL PAYMENTS (Razorpay): `PAYMENTS_ENABLE_REAL` is now a READ flag, not a boot
 * assertion. It previously THREW here, which made the gate physically un-flippable —
 * setting the var (the API and the portal share an env) crashed the portal. The gate
 * itself is unchanged and still fails closed: unset/garbage ⇒ FALSE ⇒ the mock top-up
 * path, exactly as before. Flipping it on remains a human-gated, staging-first decision
 * (CLAUDE.md §7), and the API enforces its own fail-closed boot check
 * (`assertPaymentsConfig` — all three Razorpay secrets or it refuses to start).
 *
 * NO SECRET LIVES IN THIS APP. Only the `rzp_*` KEY ID reaches the browser, and it
 * arrives on the order RESPONSE from the API — never from a `NEXT_PUBLIC_*` value and
 * never from a build-time constant. The key secret and webhook secret are API-only.
 *
 * NOTE on the interim InternalServiceGuard token: the data seam (`payer-http.ts`)
 * sends a payer JWT as `Authorization: Bearer <jwt>` ONLY. It NEVER sends an
 * internal-service token. The dead `INTERNAL_SERVICE_TOKEN` config was removed (D1):
 * a server-to-server internal token must never leave this app via the payer seam.
 */

export interface PayerServerConfig {
  /** API base URL used SERVER-SIDE only (route handlers / server actions). */
  apiBaseUrl: string;
  /**
   * Whether the REAL Razorpay checkout is enabled. Fail-closed: only an explicit "true"
   * turns it on; unset / "false" / garbage all keep the MOCK top-up path (the default).
   */
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

  // Fail-closed: ONLY an explicit "true" enables the real checkout; anything else (unset,
  // "false", "TRUE ", garbage) keeps the MOCK path. Same parse shape as every other gate
  // in this file — one convention, no special cases for money.
  const paymentsEnableReal =
    (process.env.PAYMENTS_ENABLE_REAL ?? "false").trim().toLowerCase() === "true";

  // Fail-closed: ONLY an explicit "true" enables agency supply; anything else (unset,
  // "false", garbage) keeps it OFF. Supply is CEO-gated Phase-2 (D2).
  const agencySupplyEnabled =
    (process.env.AGENCY_SUPPLY_ENABLED ?? "false").trim().toLowerCase() === "true";

  cached = {
    apiBaseUrl: process.env.PAYER_API_URL ?? "http://localhost:3001",
    paymentsEnableReal,
    agencySupplyEnabled,
  };
  return cached;
}
