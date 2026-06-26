import "server-only";
import { redirect } from "next/navigation";
import type { PayerAuthProvider, PayerSession } from "./types";
import { httpPayerAuthProvider } from "./http-provider";

/**
 * PayerAuth seam entry point (ADR-0019 Decision B).
 *
 * The rest of the app imports {@link payerAuth} / {@link requirePayer} and never
 * touches a concrete provider. Login is REAL-OTP only: the seam always drives the
 * backend payer-auth routes (`/payer/login/request` → `/payer/login/verify` →
 * `/payer/me`, R16/LC-1). There is NO mock/dev fallback — the portal requires the
 * backend on its API URL. A third-party IdP / MFA is a separate human gate (B-R1).
 */
export function payerAuth(): PayerAuthProvider {
  return httpPayerAuthProvider;
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
