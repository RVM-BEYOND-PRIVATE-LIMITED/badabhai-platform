import "server-only";

/**
 * SERVER-ONLY configuration for the payer portal (ADR-0019 Phase 1).
 *
 * This module imports `server-only`, so any accidental import from a Client
 * Component is a BUILD ERROR — the values here (API base URL, the interim
 * internal-service token, the payer-auth mode) never reach the browser bundle.
 *
 * ADR-0019 Decision D / §7: NO real payments. `PAYMENTS_ENABLE_REAL` is read
 * here ONLY to assert it is false at boot — a real-payment path is a HARD human
 * gate (E-R2 / TD34). The portal has no Razorpay code.
 */

export type PayerAuthMode = "mock";

export interface PayerServerConfig {
  /** The payer-auth seam mode. Phase 1 authorizes ONLY "mock" (B-R1 is OPEN). */
  authMode: PayerAuthMode;
  /** API base URL used SERVER-SIDE only (route handlers / server actions). */
  apiBaseUrl: string;
  /**
   * Interim shared secret for the API's `InternalServiceGuard` (TD33). The
   * backend has NOT yet bound `PayerAuthGuard` to the payer-facing endpoints, so
   * server-side calls ride the interim guard with the payer_id resolved from the
   * SERVER-HELD session — never client-supplied. Undefined ⇒ those calls fail
   * closed and the UI renders an honest error.
   */
  internalServiceToken: string | undefined;
  /** Asserted false in Phase 1 — real payments are a HARD human gate. */
  paymentsEnableReal: boolean;
}

let cached: PayerServerConfig | null = null;

/** Load + validate the server-only payer config (fail-closed on a real-payment flag). */
export function payerServerConfig(): PayerServerConfig {
  if (cached) return cached;

  const rawMode = (process.env.PAYER_AUTH_MODE ?? "mock").trim().toLowerCase();
  if (rawMode !== "mock") {
    // B-R1 is OPEN: a real IdP is not authorized in Phase 1. Fail closed.
    throw new Error(
      `PAYER_AUTH_MODE="${rawMode}" is not authorized in Phase 1 (ADR-0019 B-R1 is OPEN). Only "mock" is allowed; a real IdP is a separate human gate.`,
    );
  }

  const paymentsEnableReal =
    (process.env.PAYMENTS_ENABLE_REAL ?? "false").trim().toLowerCase() === "true";
  if (paymentsEnableReal) {
    // ADR-0019 Decision D / §7 hard stop — the portal has no real-payment code.
    throw new Error(
      "PAYMENTS_ENABLE_REAL=true is a HARD human gate (ADR-0019 E-R2 / TD34). The payer portal ships MOCK-only; refusing to boot.",
    );
  }

  cached = {
    authMode: "mock",
    apiBaseUrl: process.env.PAYER_API_URL ?? "http://localhost:3001",
    internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN,
    paymentsEnableReal: false,
  };
  return cached;
}
