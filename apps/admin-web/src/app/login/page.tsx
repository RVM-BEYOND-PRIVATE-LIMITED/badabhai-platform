import { redirect } from "next/navigation";
import { BrandLockup } from "../../components/brand-lockup";
import { currentSession } from "../../lib/auth";
import { LoginForm } from "./login-form";

// Always server-rendered: the session check must run per request, never at build time.
export const dynamic = "force-dynamic";

export const metadata = {
  // The root layout's template appends " · BadaBhai Admin"; carrying it here as well printed
  // the suffix twice in the tab ("Sign in · BadaBhai Admin · BadaBhai Admin").
  title: "Sign in",
  // The portal must never be indexed even if it is ever reachable from the internet.
  robots: { index: false, follow: false },
};

/**
 * Admin sign-in.
 *
 * Deliberately austere compared with the payer portal's marketing-flavoured login: this is
 * an internal control surface, and a value-proposition panel on it would be noise for the
 * only people who ever see it. The restraint IS the enterprise signal.
 *
 * Nothing on this page hints at whether an address is a real admin — see `messages.ts`.
 */
export default async function LoginPage() {
  // An already-signed-in operator hitting /login should land in the portal, not be asked
  // to authenticate a second time.
  if (await currentSession()) redirect("/");

  return (
    <main className="auth-wrap">
      <div className="auth-shell">
        <header className="auth-brand">
          <BrandLockup />
        </header>

        <LoginForm />

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
