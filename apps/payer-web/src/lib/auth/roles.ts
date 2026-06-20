import "server-only";
import { notFound } from "next/navigation";
import { requirePayer } from "./index";
import type { PayerRole, PayerSession } from "./types";

/**
 * SERVER-ENFORCED role authorization for the payer portal (agency DEMAND extension).
 *
 * The DEMAND loop (post → browse masked → unlock → reveal → credits) is SHARED by
 * both roles — `employer` and `agent` use the SAME pages/seam. A small set of
 * role-SPECIFIC sections exist (e.g. the agency-only "Referrals & payouts (parked)"
 * note). Those sections MUST be gated by the SERVER-HELD signed session role, never
 * a client flag/param.
 *
 * SECURITY (XB-A / XT3 — horizontal & role authz):
 *  - the role is read from {@link requirePayer} → the HMAC-signed session cookie
 *    (`session-token.ts`), which a client cannot forge or tamper;
 *  - on a role mismatch we return a NEUTRAL `notFound()` (404) — never a "forbidden"
 *    oracle and never a client-side hide. An `employer` cannot even learn that an
 *    `agent`-only route exists, and vice-versa.
 *
 * `PayerSession.role` on the client is for LABELS/affordances only; it is NEVER the
 * authorization decision. The decision happens here, server-side, off the session.
 */

/** Resolve the session and assert it carries the required role, or 404 neutrally. */
async function requireRole(role: PayerRole): Promise<PayerSession> {
  const session = await requirePayer();
  if (session.role !== role) {
    // Neutral not-found: no "forbidden" oracle, no leak that the section exists.
    notFound();
  }
  return session;
}

/** Gate an AGENCY-only section. An `employer` session gets a neutral 404. */
export async function requireAgent(): Promise<PayerSession> {
  return requireRole("agent");
}

/** Gate a COMPANY-only section. An `agent` session gets a neutral 404. */
export async function requireEmployer(): Promise<PayerSession> {
  return requireRole("employer");
}
