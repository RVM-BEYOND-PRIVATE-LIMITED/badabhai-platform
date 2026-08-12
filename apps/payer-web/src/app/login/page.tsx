import { redirect } from "next/navigation";
import { payerAuth } from "../../lib/auth";
import { BadaBhaiLogo, ThemeToggle } from "../../components/ds";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Payer login (ADR-0019 Phase 1 — REAL-OTP only, B-R1 OPEN) — DS1.1 re-skin onto the
 * design system.
 *
 * ONE centred card at every width. A two-column split with a left brand/value panel was
 * tried and removed: this screen is reached by someone who has already decided to sign in,
 * so a marketing column beside the form is a second thing to read before the one control
 * that matters. Nothing was lost with it — the panel carried no state, no affordance and
 * no copy the form needs — and the card is now identical from a phone to an ultrawide
 * rather than being two different screens at 1023px and 1024px.
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
      {/* Pre-auth theme control — the preference is available before sign-in too. */}
      <div className="login-theme">
        <ThemeToggle />
      </div>

      <main className="login-card">
        <div className="login-card__brand">
          <BadaBhaiLogo size={34} />
        </div>
        <h1 className="login-card__title">Your hiring desk</h1>
        <p className="login-card__sub">
          Sign in, or create a Company or Agency account. We email you a one-time code.
        </p>

        <LoginForm />
      </main>
    </div>
  );
}
