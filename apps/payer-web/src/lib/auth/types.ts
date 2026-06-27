/**
 * The PayerAuth SEAM contract (ADR-0019 Decision B / B-R1).
 *
 * This is the SINGLE interface the auth seam implements. Login is REAL-OTP only —
 * the `api` provider drives the backend payer-auth routes; there is no mock/dev
 * provider. A third-party IdP / MFA is a separate human gate (B-R1 OPEN). Nothing
 * outside `auth/` knows which provider is wired; the rest of the app depends on
 * this contract alone.
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

/**
 * A logged-in payer principal, as the seam exposes it to the app.
 *
 * Every field here is the payer's OWN data (their org label, their own contact, their
 * account state) — shown back to them only. It is NEVER worker PII; it is NEVER logged
 * or eventized (invariant #2 / B-R2). The opaque `payerId` remains the only tenant
 * token any data call may bind to (XB-A). `email` / `phoneLast4` are optional for
 * rollout-safety: a verify-step session (before GET /payer/me) carries neither.
 */
export interface PayerSession {
  /** The opaque payer id — the ONLY tenant token the rest of the app may use. */
  readonly payerId: string;
  /** Non-PII display label for the header (e.g. "Acme Tools (mock)"). */
  readonly displayLabel: string;
  /** Role, for UI affordances only — never an authz decision on the client. */
  readonly role: PayerRole;
  /** The payer's OWN account email — shown back to them only; never logged/eventized. */
  readonly email?: string;
  /** Last 4 of the payer's OWN phone (masked), or null if not set; never logged/eventized. */
  readonly phoneLast4?: string | null;
  /** The payer's OWN account status — drives the identity badge, not an authz decision. */
  readonly status: "pending" | "active" | "suspended";
}

/** Result of a login attempt. NO-ORACLE on failure (XB-H): a single neutral error. */
export type LoginResult =
  | { ok: true; session: PayerSession }
  | { ok: false; error: string };

/**
 * Result of requesting a login code (real OTP flow). NO-ENUMERATION (XB-H): the
 * shape is account-state-independent — a caller cannot tell a new/known/unknown
 * email apart. The code is NEVER returned to the client; the payer reads it from
 * their real email.
 */
export type RequestCodeResult =
  | { ok: true; resendInSeconds: number }
  | { ok: false; error: string };

/**
 * The seam. The app never branches on the provider. All methods run SERVER-SIDE
 * only (cookies + secrets).
 *
 * Login is a TWO-STEP OTP flow against the backend payer-auth routes
 * (`/payer/login/request` → `/payer/login/verify`). The code is delivered to the
 * payer's real email — it is never echoed to the client.
 */
export interface PayerAuthProvider {
  /** Step 1: request a login code for an email. NO-ENUMERATION on the result. */
  requestCode(input: { email: string }): Promise<RequestCodeResult>;
  /**
   * Self-serve signup (AUTH-1). Creates the account with its stored `role` and funnels
   * into the EXACT SAME OTP `code` step the login uses — so the return shape is the same
   * {@link RequestCodeResult} as {@link requestCode}, and is likewise NO-ENUMERATION
   * (account-state-independent; a caller cannot tell a new email from an already-registered
   * one). The code is emailed, NEVER returned. The role is set HERE, at signup; login then
   * stays role-agnostic (the server already knows the role).
   */
  signup(input: {
    role: PayerRole;
    orgName: string;
    email: string;
    phone?: string;
  }): Promise<RequestCodeResult>;
  /** Step 2: verify the code and establish a session. NO-ORACLE on failure. */
  verifyCode(input: { email: string; code: string }): Promise<LoginResult>;
  /** The current session from the request cookies, or null if unauthenticated. */
  currentSession(): Promise<PayerSession | null>;
  /** Clear the session (logout). Best-effort. */
  logout(): Promise<void>;
}
