import { redirect } from "next/navigation";
import { BrandLockup } from "../../components/brand-lockup";
import { currentSession } from "../../lib/auth";
import { ForgotPasswordForm } from "./forgot-form";

// Per request, never at build time: the session check must run on every visit.
export const dynamic = "force-dynamic";

export const metadata = {
  // The root template appends the suffix — see login/page.tsx.
  title: "Reset your password",
  robots: { index: false, follow: false },
};

/**
 * Forgot password (ADR-0060 A4).
 *
 * OUTSIDE `(portal)`, beside `/login` and `/invite/accept`: the person here cannot sign in, which
 * is the whole reason they came. A signed-in admin changes their password on the Account page
 * instead, so one who lands here is sent there rather than through an email round trip.
 *
 * Nothing on this page says whether an address is a real admin — see `messages.ts`.
 */
export default async function ForgotPasswordPage() {
  if (await currentSession()) redirect("/account");

  return (
    <main className="auth-wrap">
      <div className="auth-shell">
        <header className="auth-brand">
          <BrandLockup />
        </header>

        <ForgotPasswordForm />

        <footer className="auth-foot">
          <p>
            Access is logged. Every privileged action is recorded against your admin
            identity.
          </p>
        </footer>
      </div>
    </main>
  );
}
