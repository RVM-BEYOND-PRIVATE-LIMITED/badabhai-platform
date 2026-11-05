import { redirect } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { payerAuth } from "../../lib/auth";
import { BadaBhaiLogo, ThemeToggle } from "../../components/ds";
import { NavPendingStatus } from "../../components/nav-pending";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Payer login (ADR-0019 Phase 1 — REAL-OTP only, B-R1 OPEN) — designr5 split auth desk.
 *
 * ONE shell at every width: a slim brand bar, the auth card, and a trust footer. Above the
 * card's breakpoint the card is the designr5 split — the form on paper, the hiring-engine
 * proof panel on Shift Blue; below it the proof panel drops under the form so the control
 * that matters stays first.
 *
 * PRESENTATION ONLY. The auth path is unchanged: REAL OTP only, no mock/dev sign-in and no
 * code convenience on this surface. The code is delivered to the payer's email and typed in —
 * never displayed, pre-filled, or one-click skipped. A third-party IdP / MFA is a separate
 * human gate (B-R1).
 *
 * The aside's claims are the design's own marketing copy. It carries no live read and no
 * payer/worker data; the form remains the only interactive surface it describes. No invented
 * figures (worker/company counts, credit offers, testimonials) and no text styled as a link that
 * goes nowhere (#2581) — real numbers may return later from a real read.
 */
export default async function LoginPage() {
  const existing = await payerAuth().currentSession();
  if (existing) redirect("/dashboard");

  return (
    <div className="login-wrap login-wrap--auth">
      {/* The navigation cue's bar and polite status line — this page has no portal shell to
          render them, and a verified code navigates to the dashboard (components/nav-pending.tsx). */}
      <NavPendingStatus />
      {/* Pre-auth theme control — the preference is available before sign-in too. */}
      <div className="login-theme">
        <ThemeToggle />
      </div>

      <div className="login-shell">
        <header className="login-topbar">
          <BadaBhaiLogo size={30} />
          <div className="login-topbar__right">
            <span className="login-topbar__status">
              <span className="login-topbar__dot" aria-hidden="true" />
              Direct verified applicant network
            </span>
          </div>
        </header>

        <div className="login-split">
          <main className="login-card">
            <div className="login-intro">
              <span className="login-eyebrow">
                <Icon name="list-bullets" />
                BadaBhai Employer Portal
              </span>
              <h1 className="login-card__title">Your hiring desk</h1>
            </div>

            <LoginForm />
          </main>

          <aside className="login-aside" aria-label="Why hire with BadaBhai">
            <p className="login-aside__eyebrow">
              India&rsquo;s leading blue &amp; grey collar hiring engine
            </p>
            <h2 className="login-aside__title">Hire workers directly. No middleman delays.</h2>
            <p className="login-aside__lead">
              Access thousands of pre-screened delivery executives, warehouse staff, drivers, and
              frontline operators in minutes.
            </p>

            <ul className="login-aside__features">
              <li>
                <span className="login-aside__icon">
                  <Icon name="whatsapp-logo" />
                </span>
                <div>
                  <strong>Instant WhatsApp Connect</strong>
                  <p>Contact candidates directly via WhatsApp and direct call routing.</p>
                </div>
              </li>
            </ul>
          </aside>
        </div>

        <footer className="login-foot">
          <span>© 2026 BadaBhai Technologies Private Limited. All rights reserved.</span>
        </footer>
      </div>
    </div>
  );
}
