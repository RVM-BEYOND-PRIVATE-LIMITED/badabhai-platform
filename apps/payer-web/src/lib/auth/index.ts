import "server-only";
import { redirect } from "next/navigation";
import { payerServerConfig } from "../server-config";
import type { PayerAuthProvider, PayerSession } from "./types";
import { mockPayerAuthProvider } from "./mock-provider";

/**
 * PayerAuth seam entry point (ADR-0019 Decision B).
 *
 * The rest of the app imports {@link payerAuth} / {@link requirePayer} and never
 * touches a concrete provider. Phase 1 resolves ONLY the mock provider (B-R1 is
 * OPEN); `payerServerConfig()` fails closed if `PAYER_AUTH_MODE` is anything else.
 * Swapping in a real IdP is: implement {@link PayerAuthProvider}, add a branch
 * here behind a new authorized mode — nothing else changes.
 */
export function payerAuth(): PayerAuthProvider {
  const { authMode } = payerServerConfig();
  switch (authMode) {
    case "mock":
      return mockPayerAuthProvider;
    default:
      // Unreachable: payerServerConfig() already fail-closes on a non-mock mode.
      throw new Error(`Unsupported PAYER_AUTH_MODE: ${authMode as string}`);
  }
}

/**
 * Resolve the current payer or redirect to /login. The returned `payerId` is the
 * ONLY tenant token any data call may use — it comes from the SERVER-HELD session,
 * never from a client param (XB-A: every payer action is bound to the caller's own
 * payer_id; a client cannot supply another payer's id).
 */
export async function requirePayer(): Promise<PayerSession> {
  const session = await payerAuth().currentSession();
  if (!session) redirect("/login");
  return session;
}

export type { PayerSession, PayerAuthProvider } from "./types";
