/**
 * The PayerAuth SEAM contract (ADR-0019 Decision B / B-R1).
 *
 * This is the SINGLE interface a real IdP (Supabase Auth or bespoke) will
 * implement later. Phase 1 ships ONLY the `mock` provider (B-R1 is OPEN — a real
 * login provider is a separate human gate). Nothing outside `auth/` knows which
 * provider is wired; the rest of the app depends on this contract alone.
 *
 * SECURITY: the session carries ONLY the opaque `payerId` (+ an org display label
 * for the header). No raw payer PII (email/phone) ever lives in the session token
 * or reaches the client — `payer_id` is the only token, per invariant #2 / B-R2.
 */

/**
 * Payer role — mirrors the backend `PayerRole` (`payers.role`): an `employer` is a
 * company; an `agent` is an agency. SUPPLY (referral payouts) is PARKED — `agent`
 * in Phase 1 means an agency using the SAME DEMAND loop as a company.
 */
export type PayerRole = "employer" | "agent";

/** A logged-in payer principal, as the seam exposes it to the app. */
export interface PayerSession {
  /** The opaque payer id — the ONLY tenant token the rest of the app may use. */
  readonly payerId: string;
  /** Non-PII display label for the header (e.g. "Acme Tools (mock)"). */
  readonly displayLabel: string;
  /** Role, for UI affordances only — never an authz decision on the client. */
  readonly role: PayerRole;
}

/** Result of a login attempt. NO-ORACLE on failure (XB-H): a single neutral error. */
export type LoginResult =
  | { ok: true; session: PayerSession }
  | { ok: false; error: string };

/**
 * Result of requesting a login code (real OTP flow). NO-ENUMERATION (XB-H): the
 * shape is account-state-independent — a caller cannot tell a new/known/unknown
 * email apart. `devOtp` is populated ONLY in dev/test on the mock channel so a
 * harness can finish login; never in staging/prod.
 */
export type RequestCodeResult =
  | { ok: true; resendInSeconds: number; devOtp?: string }
  | { ok: false; error: string };

/**
 * The seam. A real provider swaps this whole module out; the app never branches
 * on the provider. All methods run SERVER-SIDE only (cookies + secrets).
 *
 * Phase 1 LIVE login is a TWO-STEP OTP flow against the backend payer-auth routes
 * (`/payer/login/request` → `/payer/login/verify`). The mock provider implements
 * the same two methods (echoing a fixed dev code) so the UI is provider-agnostic.
 */
export interface PayerAuthProvider {
  /** Step 1: request a login code for an email. NO-ENUMERATION on the result. */
  requestCode(input: { email: string }): Promise<RequestCodeResult>;
  /** Step 2: verify the code and establish a session. NO-ORACLE on failure. */
  verifyCode(input: { email: string; code: string }): Promise<LoginResult>;
  /** The current session from the request cookies, or null if unauthenticated. */
  currentSession(): Promise<PayerSession | null>;
  /** Clear the session (logout). Best-effort. */
  logout(): Promise<void>;
}
