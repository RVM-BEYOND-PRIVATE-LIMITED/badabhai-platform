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
 * ORG-member role — mirrors the backend `OrgRole` (`payer_members.org_role`, ADR-0027). A SECOND
 * dimension on top of {@link PayerRole}: what this member may do INSIDE their org (org-roles.ts).
 */
export type OrgRole = "owner" | "recruiter";

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
  /**
   * The payer's OWN account email — shown back to them only; never logged/eventized.
   * `null` ⇔ a phone-only account (#2497/#2499); `undefined` ⇔ this session has no
   * `/payer/me` read yet (e.g. the verify step). Both mean "no email to render".
   */
  readonly email?: string | null;
  /** Last 4 of the payer's OWN phone (masked), or null if not set; never logged/eventized. */
  readonly phoneLast4?: string | null;
  /** The payer's OWN account status — drives the identity badge, not an authz decision. */
  readonly status: "pending" | "active" | "suspended" | "archived";
  /**
   * #2079 — the member's CURRENT org role, from `GET /payer/me` `orgRole` on THIS request (the
   * backend reads `payer_members` per call, never the token). `null`/absent = no active
   * membership, an older API without the field, or a verify-step session — all least privilege.
   * Never branch on this directly: go through `getOrgRole()` / `requireOwner()` (org-roles.ts),
   * which fail closed on anything but an explicit `"owner"`.
   */
  readonly orgRole?: OrgRole | null;
}

/**
 * Result of a login attempt. NO-ORACLE on failure (XB-H): a single neutral error.
 *
 * `reason: "password_change_required"` (#2587, backend #2628) — the code verified, but the
 * account holds a TEMPORARY password an admin issued, so no session was opened (the API's 409).
 * The caller already proved the mailbox, so this is not an enumeration signal; it is the only
 * way to tell the payer to sign in with that password and set their own. Absent on every
 * other failure, and on every answer from an API without #2628.
 */
export type LoginResult =
  | { ok: true; session: PayerSession; isNewPayer: boolean }
  | { ok: false; error: string; reason?: "password_change_required" };

/**
 * Why a password sign-in opened no session (#2587). Read from the HTTP status only — the API's
 * own text is never surfaced, and the four credential misses the API makes indistinguishable
 * (unknown login, wrong / revoked password, OTP-only account, lockout) stay one neutral reason.
 */
export type PasswordLoginFailure =
  /** 401 — unknown login, wrong or revoked password, lockout: indistinguishable on purpose. */
  | "invalid_credentials"
  /** 403 — a proven credential on a suspended account (the API's only distinct refusal). */
  | "suspended"
  /** 429 — the per-IP auth cap. */
  | "rate_limited"
  /** 5xx, a network failure, or a body that is neither a session nor a change request. */
  | "unavailable";

/**
 * Which rule the API refused a NEW password for (#2628: the shared password policy, or the
 * "must differ from the temporary one" check). Never carries the password itself.
 */
export type NewPasswordRefusal =
  | "too_short"
  | "too_long"
  | "letter_and_digit"
  | "same_as_temporary"
  | "other";

/**
 * Result of `POST /payer/login/password` (#2587). FAIL CLOSED: only `ok: true` means a session
 * cookie was set, and only a body carrying a non-empty `access_token` produces it. A
 * `{ status: "password_change_required" }` answer is NOT a session — the temporary password was
 * right, and the caller must resend it with a `new_password` before any session exists.
 */
export type PasswordLoginResult =
  | { ok: true; session: PayerSession; isNewPayer: boolean }
  | { ok: false; reason: "password_change_required" }
  | { ok: false; reason: "new_password_rejected"; refusal: NewPasswordRefusal }
  | { ok: false; reason: PasswordLoginFailure };

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
 * payer's real email — it is never echoed to the client. Beside it, `/payer/login/password`
 * signs in with a password (#2587), including the forced first change of a temporary one.
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
  /**
   * Password sign-in (#2587): `identifier` is an email, an E.164 phone or the exact org name.
   * With `newPassword` it is the forced first change of a temporary password (#2628): the
   * temporary password goes in `password`, its replacement in `newPassword`. A session cookie is
   * set ONLY on a real session response — never on `password_change_required`.
   */
  loginWithPassword(input: {
    identifier: string;
    password: string;
    newPassword?: string;
  }): Promise<PasswordLoginResult>;
  /** The current session from the request cookies, or null if unauthenticated. */
  currentSession(): Promise<PayerSession | null>;
  /** Clear the session (logout). Best-effort. */
  logout(): Promise<void>;
}
