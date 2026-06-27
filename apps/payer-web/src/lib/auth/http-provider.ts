import "server-only";
import { z } from "zod";
import { cookies } from "next/headers";
import type {
  LoginResult,
  PayerAuthProvider,
  PayerSession,
  RequestCodeResult,
} from "./types";
import { payerFetch, isPayerUnauthorized } from "../payer-http";
import { payerMeWireSchema } from "../contracts";
import { API_TOKEN_COOKIE_NAME, sessionCookieOptions } from "./session-cookie";

/**
 * REAL (api) PayerAuth provider — the LIVE Phase-1 login (ADR-0019 LC-1 / R16).
 *
 * Drives the backend payer-auth routes:
 *   POST /payer/login/request  → issues a login code (NO-ENUMERATION response)
 *   POST /payer/login/verify   → mints a payer JWT (Bearer)
 *   GET  /payer/me             → resolves the current session from that JWT
 *
 * SECURITY:
 *  - The minted payer JWT is stored in an httpOnly server cookie ({@link
 *    API_TOKEN_COOKIE_NAME}); it NEVER reaches the browser bundle.
 *  - `currentSession()` validates the token by calling `GET /payer/me` server-side;
 *    a 401 → null (fail closed). The session carries ONLY the opaque payerId + role
 *    + the payer's own org label — no email/phone (invariant #2 / B-R2).
 *  - login failure returns ONE neutral error (no enumeration oracle, XB-H).
 */

const NEUTRAL_LOGIN_ERROR = "Invalid or expired code.";

/** POST /payer/login/request response (no-enumeration; the code is emailed, never returned). */
const requestCodeWireSchema = z.object({
  status: z.literal("code_sent"),
  resend_in_seconds: z.number(),
});

/** POST /payer/login/verify response — the minted Bearer session. */
const verifyWireSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in_seconds: z.number(),
  payer_id: z.string().uuid(),
  role: z.enum(["employer", "agent"]),
  is_new_payer: z.boolean(),
});

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
    let res: z.infer<typeof verifyWireSchema>;
    try {
      res = await payerFetch("/payer/login/verify", {
        method: "POST",
        public: true,
        body: { email, code },
        schema: verifyWireSchema,
      });
    } catch {
      // No-oracle: any failure (bad code, unknown email, service error) → one error.
      return { ok: false, error: NEUTRAL_LOGIN_ERROR };
    }

    const store = await cookies();
    store.set(
      API_TOKEN_COOKIE_NAME,
      res.access_token,
      sessionCookieOptions(res.expires_in_seconds),
    );

    return {
      ok: true,
      session: sessionFromMe({
        id: res.payer_id,
        role: res.role,
        status: "active",
        orgName: "",
      }),
    };
  },

  async currentSession(): Promise<PayerSession | null> {
    try {
      const me = await payerFetch("/payer/me", { schema: payerMeWireSchema });
      return sessionFromMe(me);
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
  };
}
