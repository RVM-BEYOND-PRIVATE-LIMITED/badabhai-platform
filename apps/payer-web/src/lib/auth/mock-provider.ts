import "server-only";
import { cookies } from "next/headers";
import type {
  LoginResult,
  PayerAuthProvider,
  PayerSession,
  RequestCodeResult,
} from "./types";
import { matchMockAccountByEmail } from "./fixtures";
import { decodeSession, encodeSession } from "./session-token";
import { MOCK_COOKIE_NAME, sessionCookieOptions } from "./session-cookie";

/**
 * MOCK PayerAuth provider (ADR-0019 Phase 1 — staging/local fallback, B-R1 OPEN).
 *
 * Implements the {@link PayerAuthProvider} two-step OTP seam with an HMAC-signed,
 * httpOnly, SameSite=Lax session cookie (codec in `session-token.ts`). This is the
 * LOCAL/test fallback when `PAYER_AUTH_MODE=mock`; the LIVE staging mode is `api`
 * (the real backend payer-auth routes via `http-provider.ts`).
 *
 * SECURITY (XB-H — external auth hardening):
 *  - httpOnly + secure (prod) + SameSite=Lax cookie → no JS access, CSRF-resistant.
 *  - HMAC-signed payload → the client cannot forge/tamper a session (key server-only).
 *  - verifyCode() returns ONE neutral error for any failure → no enumeration oracle.
 *  - the cookie carries ONLY the opaque payerId + a non-PII label — never email/phone.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8h staging session.

/** A fixed dev code accepted for ANY known mock account (echoed back, dev-only). */
const MOCK_DEV_OTP = "000000";

/** The single neutral verify error — no enumeration oracle (XB-H). */
const NEUTRAL_LOGIN_ERROR = "Invalid or expired code.";

export const mockPayerAuthProvider: PayerAuthProvider = {
  async requestCode({ email }): Promise<RequestCodeResult> {
    // NO-ENUMERATION: identical response whether the email is known or not (XB-H).
    // Only known accounts will later verify; the request step never reveals which.
    void email;
    return { ok: true, resendInSeconds: 30, devOtp: MOCK_DEV_OTP };
  },

  async verifyCode({ email, code }): Promise<LoginResult> {
    const account = matchMockAccountByEmail(email);
    if (!account || code !== MOCK_DEV_OTP) {
      // No-oracle: identical error whether the email is unknown or the code is wrong.
      return { ok: false, error: NEUTRAL_LOGIN_ERROR };
    }
    const store = await cookies();
    store.set(
      MOCK_COOKIE_NAME,
      encodeSession(account.session),
      sessionCookieOptions(SESSION_TTL_SECONDS),
    );
    return { ok: true, session: account.session };
  },

  async currentSession(): Promise<PayerSession | null> {
    const store = await cookies();
    const raw = store.get(MOCK_COOKIE_NAME)?.value;
    if (!raw) return null;
    return decodeSession(raw);
  },

  async logout(): Promise<void> {
    const store = await cookies();
    store.delete(MOCK_COOKIE_NAME);
  },
};

/** Exposed for the no-oracle copy assertion. */
export const NEUTRAL_LOGIN_ERROR_MESSAGE = NEUTRAL_LOGIN_ERROR;
