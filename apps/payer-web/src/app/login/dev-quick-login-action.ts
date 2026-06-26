"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { payerFetch } from "../../lib/payer-http";
import { httpPayerAuthProvider } from "../../lib/auth/http-provider";
import type { PayerRole } from "../../lib/auth/types";
import { devQuickLoginEnabled } from "./dev-quick-login-flag";

/**
 * DEV-ONLY quick login (additive; gated by {@link devQuickLoginEnabled}).
 *
 * Skips the manual OTP entry but yields a REAL backend session: it drives the backend's
 * OWN dev login (console SMS echoes `dev_otp`) instead of forging a cookie, so the real
 * `bb_payer_token` is minted by `/payer/login/verify` and every already-working REAL
 * data page keeps working against the local backend. The real login form, the http
 * provider, and the auth seam are UNCHANGED — this only RE-USES them.
 *
 * SECURITY / isolation:
 *  - Re-asserts the gate server-side (defense-in-depth): if `DEV_QUICK_LOGIN` is not
 *    "true" it throws BEFORE any backend call, so the action is inert in staging/prod
 *    even if it were somehow invoked.
 *  - Uses a FIXED synthetic dev identity per role — no real PII, and no secret reaches
 *    the client bundle (this is a server action).
 *  - Requires the LOCAL backend in console-OTP mode (it echoes `dev_otp`); if the code
 *    is absent (a real channel) it throws a clear, actionable error rather than failing
 *    opaquely.
 */

/** Fixed, synthetic dev identities — create-or-get on the backend. No real PII. */
const DEV_IDENTITY: Record<PayerRole, { email: string; orgName: string; phone: string }> = {
  employer: {
    email: "dev-employer@badabhai.local",
    orgName: "Dev Co (quick-login)",
    phone: "+919000000001",
  },
  agent: {
    email: "dev-agency@badabhai.local",
    orgName: "Dev Agency (quick-login)",
    phone: "+919000000002",
  },
};

/**
 * POST /payer/signup response — mirrors the backend's no-enumeration code shape
 * (`PayerAuthCodeResponse` / http-provider `requestCodeWireSchema`). `dev_otp` is present
 * only when the backend is on a console/mock OTP channel.
 */
const signupWireSchema = z.object({
  status: z.literal("code_sent"),
  resend_in_seconds: z.number(),
  dev_otp: z.string().optional(),
});

export async function devQuickLogin(role: PayerRole): Promise<void> {
  // (1) Defense-in-depth: the page only renders the panel when enabled, but the action
  // must independently refuse to run when the gate is off.
  if (!devQuickLoginEnabled()) {
    throw new Error("DEV_QUICK_LOGIN is not enabled; dev quick login is unavailable.");
  }

  const identity = DEV_IDENTITY[role];

  // (2) Create-or-get the dev account AND issue a login code in one public call.
  // `/payer/signup` is idempotent (a repeat returns the same neutral `code_sent` shape)
  // and, unlike `/payer/login/request` (no-enumeration, won't create), it guarantees the
  // account exists so the verify below can mint a session.
  const signup = await payerFetch("/payer/signup", {
    method: "POST",
    public: true,
    body: {
      role,
      email: identity.email,
      org_name: identity.orgName,
      phone: identity.phone,
    },
    schema: signupWireSchema,
  });

  // (3) We need the echoed dev code; its absence ⇒ the backend isn't in console-OTP mode.
  if (!signup.dev_otp) {
    throw new Error(
      "No dev_otp returned — run the local backend with console OTP (SMS_PROVIDER=console) to use dev quick login.",
    );
  }

  // (4) Re-use the EXISTING real verify: it POSTs /payer/login/verify and sets the real
  // httpOnly `bb_payer_token` cookie. (The provider is imported, never modified.)
  const result = await httpPayerAuthProvider.verifyCode({
    email: identity.email,
    code: signup.dev_otp,
  });
  if (!result.ok) {
    throw new Error("Dev quick login could not establish a session.");
  }

  // (5) Land where the real login lands.
  redirect("/dashboard");
}
