import { redirect } from "next/navigation";
import { payerAuth } from "../../lib/auth";
import { BadaBhaiLogo } from "../../components/ds";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Payer login (ADR-0019 Phase 1 — MOCK seam, B-R1 OPEN) — DS1.1 re-skin onto the
 * design system: BadaBhaiLogo lockup, an --app-max centered card, crisp operational copy.
 *
 * The mock provider is the ONLY authorized login in Phase 1; a real IdP is a separate
 * human gate. There is NO mock-code convenience on this surface: the code is delivered
 * to the payer's email and typed in — never displayed, pre-filled, or one-click skipped.
 */
export default async function LoginPage() {
  const existing = await payerAuth().currentSession();
  if (existing) redirect("/dashboard");

  const showDemo = process.env.NODE_ENV !== "production";

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-card__brand">
          <BadaBhaiLogo size={34} />
        </div>
        <h1 className="login-card__title">Sign in to your hiring desk</h1>
        <p className="login-card__sub">
          Post jobs, see verified applicants, unlock contacts. Staging preview — mock
          sign-in, no real money.
        </p>

        <LoginForm />

        {showDemo ? (
          <div className="login-demo">
            <strong>Staging sign-in (email + code)</strong>
            <p>
              Enter your registered payer email, then the 6-digit code sent to that inbox.
              Live auth is the backend payer-auth OTP routes.
            </p>
            <p>A third-party IdP / MFA is a separate human gate (ADR-0019 B-R1).</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
