import { redirect } from "next/navigation";
import { payerAuth } from "../../lib/auth";
import { BadaBhaiLogo } from "../../components/ds";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Payer login (ADR-0019 Phase 1 — REAL-OTP only, B-R1 OPEN) — DS1.1 re-skin onto the
 * design system: BadaBhaiLogo lockup, an --app-max centered card, crisp operational copy.
 *
 * Login is the backend payer-auth OTP flow ONLY; there is NO mock/dev sign-in and NO
 * code convenience on this surface. The code is delivered to the payer's email and typed
 * in — never displayed, pre-filled, or one-click skipped. A third-party IdP / MFA is a
 * separate human gate (B-R1).
 */
export default async function LoginPage() {
  const existing = await payerAuth().currentSession();
  if (existing) redirect("/dashboard");

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-card__brand">
          <BadaBhaiLogo size={34} />
        </div>
        <h1 className="login-card__title">Sign in to your hiring desk</h1>
        <p className="login-card__sub">
          Post jobs, see verified applicants, unlock contacts. Staging preview — no real
          money. A third-party IdP / MFA is a separate human gate (ADR-0019 B-R1).
        </p>

        <LoginForm />
      </div>
    </div>
  );
}
