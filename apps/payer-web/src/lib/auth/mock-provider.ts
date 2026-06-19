import "server-only";
import { cookies } from "next/headers";
import type { LoginResult, PayerAuthProvider, PayerSession } from "./types";
import { matchMockAccount } from "./fixtures";
import { decodeSession, encodeSession } from "./session-token";

/**
 * MOCK PayerAuth provider (ADR-0019 Phase 1 — staging-only, B-R1 OPEN).
 *
 * Implements the {@link PayerAuthProvider} seam with an HMAC-signed, httpOnly,
 * SameSite=Lax session cookie (codec in `session-token.ts`). A real IdP (Supabase
 * Auth / bespoke) will replace THIS FILE only — nothing else in the app changes.
 *
 * SECURITY (XB-H — external auth hardening):
 *  - httpOnly + secure (prod) + SameSite=Lax cookie → no JS access, CSRF-resistant.
 *  - HMAC-signed payload → the client cannot forge/tamper a session (key server-only).
 *  - login() returns ONE neutral error for any failure → no user-enumeration oracle.
 *  - the cookie carries ONLY the opaque payerId + a non-PII label — never email/phone.
 */

const COOKIE_NAME = "bb_payer_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8h staging session.

/** The single neutral login error — no enumeration oracle (XB-H). */
const NEUTRAL_LOGIN_ERROR = "Invalid email or password.";

export const mockPayerAuthProvider: PayerAuthProvider = {
  async login({ email, password }): Promise<LoginResult> {
    const account = matchMockAccount(email, password);
    if (!account) {
      // No-oracle: identical error whether the email is unknown or the password
      // is wrong (XB-H). Nothing about the attempt is logged.
      return { ok: false, error: NEUTRAL_LOGIN_ERROR };
    }
    const store = await cookies();
    store.set(COOKIE_NAME, encodeSession(account.session), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return { ok: true, session: account.session };
  },

  async currentSession(): Promise<PayerSession | null> {
    const store = await cookies();
    const raw = store.get(COOKIE_NAME)?.value;
    if (!raw) return null;
    return decodeSession(raw);
  },

  async logout(): Promise<void> {
    const store = await cookies();
    store.delete(COOKIE_NAME);
  },
};

/** Exposed for the no-oracle copy assertion. */
export const NEUTRAL_LOGIN_ERROR_MESSAGE = NEUTRAL_LOGIN_ERROR;
