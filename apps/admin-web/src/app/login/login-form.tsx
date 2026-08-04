"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { requestCodeAction, verifyCodeAction, verifyMfaAction } from "./actions";

/**
 * The three-step admin sign-in: address → emailed code → authenticator code.
 *
 * The steps are separate SCREENS rather than one long form because each is a different
 * question and an operator should only ever be answering one of them. The email is
 * carried forward in component state (never a hidden input the browser might autofill
 * wrongly) and every network call goes through a Server Action, so no token, secret or
 * API origin is ever present in this bundle.
 *
 * Enrolment is folded into step 3 rather than made a fourth step: an admin who needs to
 * enrol still has to produce a valid TOTP immediately afterwards, so splitting them would
 * add a screen without adding a decision.
 */

type Step = "email" | "code" | "mfa";
type Enrollment = { secret: string; otpauthUri: string };

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [pending, startTransition] = useTransition();

  // Move focus to the new step's first field so the keyboard path never breaks, and so a
  // screen-reader user is told where they are instead of silently landing on <body>.
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    stepHeadingRef.current?.focus();
  }, [step]);

  // Resend cooldown. Purely a UX affordance — the SERVER owns the actual rate limit, and
  // a user who edits this counter still gets refused by it.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await requestCodeAction({ email });
      if (!res.ok) return setError(res.error);
      setResendIn(res.resendInSeconds);
      setCode("");
      setStep("code");
    });
  }

  function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await verifyCodeAction({ email, code });
      if (!res.ok) return setError(res.error);
      // No session exists yet — this only tells us which MFA screen to show.
      setEnrollment(res.enrollment ?? null);
      setTotp("");
      setStep("mfa");
    });
  }

  function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await verifyMfaAction({ email, code: totp });
      if (!res.ok) return setError(res.error);
      // The cookie is set server-side; refresh so the (portal) layout re-runs its gate.
      router.replace("/");
      router.refresh();
    });
  }

  function resend() {
    if (resendIn > 0 || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await requestCodeAction({ email });
      if (!res.ok) return setError(res.error);
      setResendIn(res.resendInSeconds);
    });
  }

  return (
    <div className="auth-card">
      <div className="auth-card__head">
        <h1
          className="auth-card__title"
          ref={stepHeadingRef}
          tabIndex={-1}
          // -1 so it is focusable programmatically for the step announcement, but never a
          // tab stop competing with the field the operator actually needs.
        >
          {step === "email" && "Admin sign-in"}
          {step === "code" && "Check your email"}
          {step === "mfa" && (enrollment ? "Set up your authenticator" : "Two-factor code")}
        </h1>
        <p className="auth-card__sub">
          {step === "email" && "Internal operations console. Authorised administrators only."}
          {step === "code" && (
            <>
              We sent a one-time code to <strong className="auth-card__email">{email}</strong>.
            </>
          )}
          {step === "mfa" &&
            (enrollment
              ? "Scan this once with your authenticator app, then enter the 6-digit code it shows."
              : "Enter the 6-digit code from your authenticator app.")}
        </p>
      </div>

      {/* One live region for the whole card: a step change and an error both announce
          here, so assistive tech never has to poll two places. */}
      <div className="auth-card__status" role="status" aria-live="polite">
        {error ? <span className="auth-error">{error}</span> : null}
      </div>

      {step === "email" && (
        <form className="auth-form" onSubmit={submitEmail} noValidate>
          <label className="field">
            <span className="field__label">Work email</span>
            <input
              className="field__input"
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={error ? true : undefined}
              placeholder="you@company.com"
            />
          </label>
          <button className="btn btn--primary" type="submit" disabled={pending || !email}>
            {pending ? "Sending…" : "Continue"}
          </button>
        </form>
      )}

      {step === "code" && (
        <form className="auth-form" onSubmit={submitCode} noValidate>
          <label className="field">
            <span className="field__label">One-time code</span>
            <input
              className="field__input field__input--code"
              // `text` + numeric inputMode, not `number`: a number input strips leading
              // zeros and offers a spinner, both wrong for a fixed-width code.
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{4,8}"
              maxLength={8}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              aria-invalid={error ? true : undefined}
              aria-describedby="code-help"
            />
          </label>
          <p className="field__help" id="code-help">
            The code expires shortly. It is only ever sent to your mailbox.
          </p>
          <button className="btn btn--primary" type="submit" disabled={pending || code.length < 4}>
            {pending ? "Verifying…" : "Verify"}
          </button>
          <div className="auth-form__row">
            <button className="btn btn--ghost" type="button" onClick={resend} disabled={resendIn > 0 || pending}>
              {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
            </button>
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => {
                setStep("email");
                setError(null);
              }}
              disabled={pending}
            >
              Use a different address
            </button>
          </div>
        </form>
      )}

      {step === "mfa" && (
        <form className="auth-form" onSubmit={submitMfa} noValidate>
          {enrollment && (
            <div className="enroll">
              <div className="enroll__qr">
                <QRCodeSVG value={enrollment.otpauthUri} size={168} level="M" />
              </div>
              <details className="enroll__manual">
                <summary>Can&apos;t scan? Enter the key manually</summary>
                <code className="enroll__secret">{enrollment.secret}</code>
                <p className="field__help">
                  This key is shown once and is not recoverable. If you lose your device,
                  another super admin must reset your second factor.
                </p>
              </details>
            </div>
          )}
          <label className="field">
            <span className="field__label">Authenticator code</span>
            <input
              className="field__input field__input--code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
              aria-invalid={error ? true : undefined}
            />
          </label>
          <button className="btn btn--primary" type="submit" disabled={pending || totp.length !== 6}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}
    </div>
  );
}
