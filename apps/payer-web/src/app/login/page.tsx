import { redirect } from "next/navigation";
import { payerAuth } from "../../lib/auth";
import { BadaBhaiLogo, ThemeToggle } from "../../components/ds";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

/**
 * Payer login (ADR-0019 Phase 1 — REAL-OTP only, B-R1 OPEN) — DS1.1 re-skin onto the
 * design system, elevated to an enterprise-grade two-column auth shell (AUTH-1).
 *
 * On ≥1024px the screen is a two-pane split: a restrained left BRAND/VALUE panel + the
 * right form card. Below 1024px the brand panel collapses and the card centres — the
 * SAME single-card experience as before. The value panel uses ONLY the product's real,
 * truthful positioning (verified CNC/VMC talent · real applicants · masked-until-unlocked
 * trust) — no invented testimonials, customer logos, or stats.
 *
 * Login is the backend payer-auth OTP flow ONLY; there is NO mock/dev sign-in and NO
 * code convenience on this surface. The code is delivered to the payer's email and typed
 * in — never displayed, pre-filled, or one-click skipped. A third-party IdP / MFA is a
 * separate human gate (B-R1).
 */

/** Truthful, on-brand value props for the left panel (no invented metrics/logos). */
const VALUE_PROPS: ReadonlyArray<{ icon: string; title: string; body: string }> = [
  {
    icon: "seal-check",
    title: "Verified CNC/VMC talent",
    body: "Profiled, consent-gated applicants for industrial manufacturing roles.",
  },
  {
    icon: "eye-slash",
    title: "Masked until you unlock",
    body: "Every applicant is faceless first — you decide who to reveal and contact.",
  },
  {
    icon: "lightning",
    title: "Your hiring desk, self-serve",
    body: "Post a role, review real applicants, and move fast — no sales call to start.",
  },
];

export default async function LoginPage() {
  const existing = await payerAuth().currentSession();
  if (existing) redirect("/dashboard");

  return (
    <div className="login-wrap">
      {/* Pre-auth theme control — the preference is available before sign-in too. */}
      <div className="login-theme">
        <ThemeToggle />
      </div>

      <div className="login-shell">
        {/* LEFT — brand / value panel (≥1024px only; aria-hidden so SR users on the form
            aren't read a decorative marketing column twice). Truthful copy only. */}
        <aside className="login-aside" aria-hidden="true">
          <div className="login-aside__inner">
            <div className="login-aside__brand">
              <BadaBhaiLogo size={40} theme="ink" />
            </div>
            <p className="login-aside__eyebrow">For employers &amp; agencies</p>
            <h2 className="login-aside__headline">
              Hire verified manufacturing talent — applicants you can trust.
            </h2>
            <ul className="login-aside__points">
              {VALUE_PROPS.map((vp) => (
                <li key={vp.title} className="login-aside__point">
                  <span className="login-aside__point-icon">
                    <i className={`ph-fill ph-${vp.icon}`} aria-hidden="true" />
                  </span>
                  <span className="login-aside__point-text">
                    <span className="login-aside__point-title">{vp.title}</span>
                    <span className="login-aside__point-body">{vp.body}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="login-aside__foot">
              Worker identities are masked and consent-gated until you unlock them.
            </p>
          </div>
        </aside>

        {/* RIGHT — the auth card (the single centred card below 1024px). */}
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
    </div>
  );
}
