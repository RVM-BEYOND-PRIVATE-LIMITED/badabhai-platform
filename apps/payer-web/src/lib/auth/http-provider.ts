import "server-only";
import { z } from "zod";
import { cookies } from "next/headers";
import type {
  LoginResult,
  NewPasswordRefusal,
  PasswordLoginResult,
  PayerAuthProvider,
  PayerSession,
  RequestCodeResult,
} from "./types";
import { payerFetch, isPayerUnauthorized } from "../payer-http";
import { isPayerStatus, isPayerValidationError } from "../payer-errors";
import { payerMeWireSchema } from "../contracts";
import { API_TOKEN_COOKIE_NAME, sessionCookieOptions } from "./session-cookie";
import { rawOrgRoleOf, reportUnexpectedOrgRole } from "./org-role-drift";

/**
 * REAL (api) PayerAuth provider — the LIVE Phase-1 login (ADR-0019 LC-1 / R16).
 *
 * Drives the backend payer-auth routes:
 *   POST /payer/login/request  → issues a login code (NO-ENUMERATION response)
 *   POST /payer/login/verify   → mints a payer JWT (Bearer)
 *   POST /payer/login/password → mints the same JWT from a password (#2587), or answers
 *                                `password_change_required` (a temporary password, #2628)
 *   GET  /payer/me             → resolves the current session from that JWT
 *
 * SECURITY:
 *  - The minted payer JWT is stored in an httpOnly server cookie ({@link
 *    API_TOKEN_COOKIE_NAME}); it NEVER reaches the browser bundle.
 *  - `currentSession()` validates the token by calling `GET /payer/me` server-side;
 *    a 401 → null (fail closed). The session carries ONLY the opaque payerId + role
 *    + the payer's own org label — no email/phone (invariant #2 / B-R2).
 *  - ORG ROLE (#2079): the session's `orgRole` is `GET /payer/me` `orgRole` from THIS read —
 *    the backend's per-request DB answer. The JWT's `org_role` claim is NEVER decoded here:
 *    payer-web cannot verify its signature (it holds no signing key), so reading it would mean
 *    trusting a cookie the browser can rewrite — and it would add nothing, because this read
 *    already happens on every `requirePayer()` and is fresher than any claim. A value outside
 *    the mirrored enum reads as least privilege (the wire schema degrades it to null) and is
 *    LOGGED once as a contract drift (org-role-drift.ts) — the one place the raw value exists.
 *  - login failure returns ONE neutral error (no enumeration oracle, XB-H).
 */

const NEUTRAL_LOGIN_ERROR = "Invalid or expired code.";

/** POST /payer/login/request response (no-enumeration; the code is emailed, never returned). */
const requestCodeWireSchema = z.object({
  status: z.literal("code_sent"),
  resend_in_seconds: z.number(),
});

/**
 * POST /payer/login/verify and POST /payer/login/password response — the minted Bearer session
 * (one shape for both doors). FAIL CLOSED (#2587): a body without a non-empty `access_token` is
 * not a session, so it never reaches the cookie.
 */
const verifyWireSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in_seconds: z.number(),
  payer_id: z.string().uuid(),
  role: z.enum(["employer", "agent"]),
  is_new_payer: z.boolean(),
});
type SessionWire = z.infer<typeof verifyWireSchema>;

/**
 * POST /payer/login/password for a TEMPORARY password sent without `new_password` (#2628): the
 * password was right, and NO session exists. Checked BEFORE the session shape, so a body naming
 * this status is never read as a session — even one that also carries a token.
 */
const passwordChangeRequiredWireSchema = z.object({
  status: z.literal("password_change_required"),
});

/**
 * The API's password-policy refusals for `new_password` (the shared `PasswordPolicySchema`
 * messages, #2628) → the rule that was refused. Only the RULE leaves the seam; the copy the payer
 * reads is the app's own (app/login/password-rules.ts). An unknown message is `other`.
 */
const NEW_PASSWORD_REFUSALS: ReadonlyArray<readonly [RegExp, NewPasswordRefusal]> = [
  [/at least \d+ characters/i, "too_short"],
  [/at most \d+ characters/i, "too_long"],
  [/letter and one digit/i, "letter_and_digit"],
];

type PasswordLoginFailureResult = Exclude<PasswordLoginResult, { ok: true }>;

export const httpPayerAuthProvider: PayerAuthProvider = {
  async requestCode({ email }): Promise<RequestCodeResult> {
    try {
      const res = await payerFetch("/payer/login/request", {
        method: "POST",
        public: true,
        body: { email },
        schema: requestCodeWireSchema,
      });
      return {
        ok: true,
        resendInSeconds: res.resend_in_seconds,
      };
    } catch {
      // Honest service error (NOT an enumeration signal — request never reveals state).
      return { ok: false, error: "Could not send a login code right now. Please retry." };
    }
  },

  async signup({ role, orgName, email, phone }): Promise<RequestCodeResult> {
    try {
      // The signup response is DELIBERATELY IDENTICAL to /payer/login/request's
      // (account-state-independent, no-enumeration / XB-H): same `{ status, resend_in_seconds }`
      // shape, the OTP is emailed and NEVER returned. So we reuse the same wire schema and
      // funnel the caller into the SAME shared OTP `code` step the login uses.
      const res = await payerFetch("/payer/signup", {
        method: "POST",
        public: true,
        body: {
          role,
          org_name: orgName,
          email,
          // Omit `phone` entirely when not provided (optional E.164 field).
          ...(phone ? { phone } : {}),
        },
        schema: requestCodeWireSchema,
      });
      return {
        ok: true,
        resendInSeconds: res.resend_in_seconds,
      };
    } catch {
      // Honest service error (NOT an enumeration signal — signup never reveals account state).
      return { ok: false, error: "Could not start signup right now. Please retry." };
    }
  },

  async verifyCode({ email, code }): Promise<LoginResult> {
    let res: SessionWire;
    try {
      res = await payerFetch("/payer/login/verify", {
        method: "POST",
        public: true,
        body: { email, code },
        schema: verifyWireSchema,
      });
    } catch (err) {
      // #2587 / #2628 — the code was right, but the account holds a TEMPORARY password: no
      // session until the payer sets their own through the password door. Read from the status
      // alone; the API sends no other 409 on this route, and an API without #2628 sends none.
      if (isPayerStatus(err, 409)) {
        return { ok: false, error: NEUTRAL_LOGIN_ERROR, reason: "password_change_required" };
      }
      // No-oracle: any failure (bad code, unknown email, service error) → one error.
      return { ok: false, error: NEUTRAL_LOGIN_ERROR };
    }

    return openSession(res);
  },

  async loginWithPassword({ identifier, password, newPassword }): Promise<PasswordLoginResult> {
    const changing = newPassword !== undefined;
    let body: unknown;
    try {
      body = await payerFetch("/payer/login/password", {
        method: "POST",
        public: true,
        // `new_password` rides ONLY the forced-change resend; a first attempt never carries it.
        body: changing
          ? { identifier, password, new_password: newPassword }
          : { identifier, password },
        // Read raw, then classified below: the change request must be ruled out BEFORE the body
        // is read as a session.
        schema: z.unknown(),
      });
    } catch (err) {
      return passwordLoginFailure(err, changing);
    }

    // FAIL CLOSED: a change request is never a session — no cookie, whatever else rides along.
    if (passwordChangeRequiredWireSchema.safeParse(body).success) {
      return { ok: false, reason: "password_change_required" };
    }
    const session = verifyWireSchema.safeParse(body);
    if (!session.success) return { ok: false, reason: "unavailable" };
    return openSession(session.data);
  },

  async currentSession(): Promise<PayerSession | null> {
    try {
      // Read the body raw, then parse it here: the wire schema degrades an unknown `orgRole` to
      // null, so the raw body is the only place a contract drift is visible. Same failures as
      // before — a non-2xx throws in the transport, a malformed body throws in the parse.
      const body = await payerFetch("/payer/me", { schema: z.unknown() });
      const session = sessionFromMe(payerMeWireSchema.parse(body));
      reportUnexpectedOrgRole(rawOrgRoleOf(body));
      return session;
    } catch (err) {
      if (isPayerUnauthorized(err)) return null;
      // A transient API error should not masquerade as "logged out" silently here;
      // but the seam contract is null-or-session, so fail closed to /login.
      return null;
    }
  },

  async logout(): Promise<void> {
    // Best-effort backend revoke, then always clear the local cookie.
    try {
      await payerFetch("/payer/logout", { method: "POST", schema: z.unknown() });
    } catch {
      // ignore — local clear below is authoritative for the browser session.
    }
    const store = await cookies();
    store.delete(API_TOKEN_COOKIE_NAME);
  },
};

/**
 * Open the session a sign-in minted: store the payer JWT in the httpOnly cookie and build the
 * principal. The ONE place a session starts, so the code door and the password door (#2587)
 * cannot drift — same cookie, same options, same principal.
 */
async function openSession(
  res: SessionWire,
): Promise<{ ok: true; session: PayerSession; isNewPayer: boolean }> {
  const store = await cookies();
  store.set(API_TOKEN_COOKIE_NAME, res.access_token, sessionCookieOptions(res.expires_in_seconds));

  return {
    ok: true,
    isNewPayer: res.is_new_payer,
    session: sessionFromMe({
      id: res.payer_id,
      role: res.role,
      status: "active",
      orgName: "",
    }),
  };
}

/**
 * A refused `POST /payer/login/password`, read from the status (no body text leaves the seam):
 * 401 → the neutral credential miss; 403 → suspended; 429 → rate limited; 400 → on a first
 * attempt a credential outside the DTO's bounds (it cannot be anyone's password, so the same
 * neutral miss), on the change resend the refused `new_password` rule; anything else (5xx, a
 * network failure) → unavailable.
 */
function passwordLoginFailure(err: unknown, changing: boolean): PasswordLoginFailureResult {
  if (isPayerUnauthorized(err)) return { ok: false, reason: "invalid_credentials" };
  if (isPayerStatus(err, 403)) return { ok: false, reason: "suspended" };
  if (isPayerStatus(err, 429)) return { ok: false, reason: "rate_limited" };
  if (isPayerStatus(err, 400)) {
    return changing ? changeResendRefusal(err) : { ok: false, reason: "invalid_credentials" };
  }
  return { ok: false, reason: "unavailable" };
}

/**
 * The change resend's 400 (#2628). The validation pipe names the field: a `new_password` issue is
 * a policy refusal; an issue on any other field means the temporary credential itself is out of
 * bounds (the neutral miss). A 400 with no field issues is the route's one other refusal — the new
 * password equals the temporary one.
 */
function changeResendRefusal(err: unknown): PasswordLoginFailureResult {
  if (!isPayerValidationError(err)) {
    return { ok: false, reason: "new_password_rejected", refusal: "same_as_temporary" };
  }
  const issue = err.issues.find((i) => i.path === "new_password");
  if (!issue) return { ok: false, reason: "invalid_credentials" };
  const match = NEW_PASSWORD_REFUSALS.find(([pattern]) => pattern.test(issue.message));
  return { ok: false, reason: "new_password_rejected", refusal: match ? match[1] : "other" };
}

/** Build the session principal from GET /payer/me — the payer's OWN data only. */
function sessionFromMe(me: z.infer<typeof payerMeWireSchema>): PayerSession {
  return {
    payerId: me.id,
    // The payer's OWN org label (their own data) — never logged/eventized. Falls
    // back to a neutral label if absent (e.g. right after verify).
    displayLabel: me.orgName.trim() || (me.role === "agent" ? "Your agency" : "Your company"),
    role: me.role,
    // The payer's OWN account fields (their email / masked phone / state) — shown back
    // to them in the account menu + /account only; never logged/eventized (invariant #2).
    // `email` stays undefined on a verify-step session (no /payer/me yet) — that is fine,
    // the field is optional. `phoneLast4` normalizes a missing value to null.
    email: me.email,
    phoneLast4: me.phoneLast4 ?? null,
    status: me.status,
    // #2079 — the CURRENT org role (per-request DB read on the API). Absent (older API, or the
    // verify-step session built from /payer/login/verify) normalizes to null = least privilege.
    orgRole: me.orgRole ?? null,
  };
}
