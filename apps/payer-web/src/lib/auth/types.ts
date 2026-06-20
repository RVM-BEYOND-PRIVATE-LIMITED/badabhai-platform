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
 * The seam. A real provider swaps this whole module out; the app never branches
 * on the provider. All methods run SERVER-SIDE only (cookies + secrets).
 */
export interface PayerAuthProvider {
  /** Establish a session from a credential. Mock: a known demo account. */
  login(input: { email: string; password: string }): Promise<LoginResult>;
  /** The current session from the request cookies, or null if unauthenticated. */
  currentSession(): Promise<PayerSession | null>;
  /** Clear the session (logout). Best-effort. */
  logout(): Promise<void>;
}
