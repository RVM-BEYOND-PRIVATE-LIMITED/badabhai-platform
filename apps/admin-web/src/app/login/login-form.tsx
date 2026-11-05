"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import {
  passwordLoginAction,
  requestCodeAction,
  verifyCodeAction,
  verifyMfaAction,
  type Enrollment,
  type FirstFactorResult,
} from "./actions";
import { PasswordInput } from "../../components/password-input";
import { NewPasswordFields } from "../../components/new-password-fields";
import { AuthenticatorEnrollment } from "../../components/authenticator-enrollment";
import { FieldError, FormSummary, useFormValidation } from "../../components/form-feedback";
import { looksLikeAdminEmail } from "../../lib/email-shape";
import { newPasswordPairReady } from "../../lib/password-policy";

/**
 * Admin sign-in (ADR-0060). Two doors, one optional second step:
 *
 *   password (default)  email + password → [set a new password, if it was temporary] → [MFA]
 *   code                email → emailed code → [MFA]
 *
 * The bracketed MFA step appears only when the SERVER asks for it: an admin who turned two-step
 * verification on, on a browser that is not trusted. Everyone else is signed in straight after
 * the first factor — that is the default, and the form never assumes either way.
 *
 * Each step is its own SCREEN, because each is a different question and an operator should only
 * ever be answering one of them. The email (and, until the password is accepted, the password)
 * is carried forward in component state — never a hidden input the browser might autofill
 * wrongly — and every network call is a Server Action, so no token, secret or API origin is ever
 * present in this bundle.
 *
 * Enrolment is folded into the MFA step rather than made a step of its own: an admin who needs to
 * enrol still has to produce a valid code immediately afterwards, so splitting them would add a
 * screen without adding a decision.
 */

export type LoginMethod = "password" | "code";
type Step = "credentials" | "change" | "email" | "code" | "mfa";

const FIRST_STEP: Record<LoginMethod, Step> = { password: "credentials", code: "email" };

export function LoginForm({ method }: { method: LoginMethod }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(FIRST_STEP[method]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [pending, startTransition] = useTransition();
  const ids = useId();

  const fieldsByStep: Record<Step, readonly ("email" | "password" | "code" | "totp")[]> = {
    credentials: ["email", "password"],
    change: [],
    email: ["email"],
    code: ["code"],
    mfa: ["totp"],
  };
  const validation = useFormValidation({
    order: fieldsByStep[step],
    fieldId: (field) => `${ids}-${field}`,
    focus: (field) => {
      if (typeof document !== "undefined") document.getElementById(`${ids}-${field}`)?.focus();
    },
    validate: () => {
      const errors: Partial<Record<"email" | "password" | "code" | "totp", string>> = {};
      if (step === "credentials" || step === "email") {
        if (email.trim() === "") errors.email = "Enter your work email.";
        else if (!looksLikeAdminEmail(email)) errors.email = "Enter a valid email address.";
      }
      if (step === "credentials" && password === "")
        errors.password = "Enter your password.";
      if (step === "code" && code.length < 4)
        errors.code = "Enter the code from your email.";
      if (step === "mfa" && totp.length !== 6)
        errors.totp = "Enter the 6-digit code from your authenticator app.";
      return errors;
    },
  });

  // Move focus to the new step's heading so the keyboard path never breaks, and so a
  // screen-reader user is told where they are instead of silently landing on <body>. Not on the
  // first render: there the first field's own autofocus is where the operator starts.
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepHeadingRef.current?.focus();
  }, [step]);

  // Resend cooldown. Purely a UX affordance — the SERVER owns the actual rate limit, and
  // a user who edits this counter still gets refused by it.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  function signedIn() {
    // The cookie is set server-side; refresh so the (portal) layout re-runs its gate.
    router.replace("/");
    router.refresh();
  }

  /** Follow a first factor's answer: straight in, or on to the MFA step. */
  function follow(res: Exclude<FirstFactorResult, { ok: false }>) {
    if (res.next === "signed_in") return signedIn();
    setEnrollment(res.enrollment ?? null);
    setTotp("");
    validation.reset();
    setStep("mfa");
  }

  function startOver() {
    setPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordChanged(false);
    setCode("");
    setTotp("");
    setTrustDevice(false);
    setEnrollment(null);
    setError(null);
    validation.reset();
    setStep(FIRST_STEP[method]);
  }

  function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (validation.submit() !== null) return;
    setError(null);
    startTransition(async () => {
      const res = await passwordLoginAction({ email, password });
      if (!res.ok) return setError(res.error);
      if (res.next === "change_password") {
        setNewPassword("");
        setConfirmPassword("");
        validation.reset();
        return setStep("change");
      }
      follow(res);
    });
  }

  function submitNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!newPasswordPairReady(newPassword, confirmPassword)) return;
    setError(null);
    startTransition(async () => {
      const res = await passwordLoginAction({ email, password, newPassword });
      if (!res.ok) return setError(res.error);
      if (res.next === "change_password") return; // unreachable: the action maps it to an error
      // The temporary password is spent. Keep nothing of either in memory past this point.
      setPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordChanged(true);
      follow(res);
    });
  }

  function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    if (validation.submit() !== null) return;
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
    if (validation.submit() !== null) return;
    setError(null);
    startTransition(async () => {
      const res = await verifyCodeAction({ email, code });
      if (!res.ok) return setError(res.error);
      follow(res);
    });
  }

  function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    if (validation.submit() !== null) return;
    setError(null);
    startTransition(async () => {
      const res = await verifyMfaAction({ email, code: totp, trustDevice });
      if (!res.ok) return setError(res.error);
      signedIn();
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

  const startOverButton = (
    <button className="btn btn--ghost" type="button" onClick={startOver} disabled={pending}>
      <Icon name={ACTION_ICON.back} />
      Start over
    </button>
  );

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
          {step === "credentials" && "Admin sign-in"}
          {step === "change" && "Set a new password"}
          {step === "email" && "Sign in with an email code"}
          {step === "code" && "Check your email"}
          {step === "mfa" && (enrollment ? "Set up your authenticator" : "MFA code")}
        </h1>
        <p className="auth-card__sub">
          {(step === "credentials" || step === "email") &&
            "Internal operations console. Authorised administrators only."}
          {step === "change" &&
            "You signed in with a temporary password. Choose your own to continue."}
          {step === "code" && (
            <>
              We sent a one-time code to <strong className="auth-card__email">{email}</strong>.
            </>
          )}
          {step === "mfa" &&
            (enrollment
              ? "Two-step verification is on for your account. Scan this once with your authenticator app, then enter the 6-digit code it shows."
              : "Enter the 6-digit code from your authenticator app.")}
        </p>
      </div>

      {/* One live region for the whole card: a step change and an error both announce
          here, so assistive tech never has to poll two places. */}
      <div className="auth-card__status" role="status" aria-live="polite">
        {error ? <span className="auth-error">{error}</span> : null}
        {!error && step === "mfa" && passwordChanged ? (
          <span className="auth-note">Your new password is saved — use it from now on.</span>
        ) : null}
      </div>

      {step === "credentials" && (
        <form className={validation.shaking ? "auth-form form--shake" : "auth-form"} onSubmit={submitCredentials} noValidate>
          <FormSummary errors={validation.visible} />
          <label className="field">
            <span className="field__label">Work email</span>
            <input
              id={`${ids}-email`}
              className="field__input"
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => validation.onBlur("email")}
              aria-invalid={error || validation.errors.email ? true : undefined}
              aria-describedby={
                validation.errors.email ? `${ids}-email-error` : undefined
              }
              placeholder="you@company.com"
            />
            <FieldError id={`${ids}-email-error`}>{validation.errors.email}</FieldError>
          </label>
          <PasswordInput
            id={`${ids}-password`}
            label="Password"
            name="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            onBlur={() => validation.onBlur("password")}
            invalid={Boolean(error || validation.errors.password)}
            describedBy={
              validation.errors.password ? `${ids}-password-error` : undefined
            }
          />
          <FieldError id={`${ids}-password-error`}>{validation.errors.password}</FieldError>
          <button
            className="btn btn--primary"
            type="submit"
            disabled={pending}
          >
            <Icon name="sign-in" />
            {pending ? "Signing in…" : "Sign in"}
          </button>
          <div className="auth-form__row">
            <Link className="btn btn--ghost" href="/forgot-password">
              <Icon name="key" />
              Forgot password?
            </Link>
            <Link className="btn btn--ghost" href="/login?method=code">
              <Icon name="envelope" />
              Sign in with an email code instead
            </Link>
          </div>
        </form>
      )}

      {step === "change" && (
        <form className={validation.shaking ? "auth-form form--shake" : "auth-form"} onSubmit={submitNewPassword} noValidate>
          <FormSummary errors={validation.visible} />
          {/* For password managers: the account this new password belongs to. Read-only and out
              of the tab order — the operator already typed it on the previous screen. */}
          <input
            className="sr-only"
            type="email"
            name="username"
            autoComplete="username"
            value={email}
            readOnly
            tabIndex={-1}
            aria-hidden="true"
          />
          <NewPasswordFields
            value={newPassword}
            confirm={confirmPassword}
            onChange={setNewPassword}
            onConfirmChange={setConfirmPassword}
            autoFocus
            disabled={pending}
          />
          <button
            className="btn btn--primary"
            type="submit"
            disabled={pending}
          >
            <Icon name={ACTION_ICON.approve} />
            {pending ? "Saving…" : "Save and continue"}
          </button>
          <div className="auth-form__row">{startOverButton}</div>
        </form>
      )}

      {step === "email" && (
        <form className={validation.shaking ? "auth-form form--shake" : "auth-form"} onSubmit={submitEmail} noValidate>
          <FormSummary errors={validation.visible} />
          <label className="field">
            <span className="field__label">Work email</span>
            <input
              id={`${ids}-email`}
              className="field__input"
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => validation.onBlur("email")}
              aria-invalid={error || validation.errors.email ? true : undefined}
              aria-describedby={
                validation.errors.email ? `${ids}-email-error` : undefined
              }
              placeholder="you@company.com"
            />
            <FieldError id={`${ids}-email-error`}>{validation.errors.email}</FieldError>
          </label>
          <button className="btn btn--primary" type="submit" disabled={pending}>
            <Icon name={ACTION_ICON.send} />
            {pending ? "Sending…" : "Continue"}
          </button>
          <div className="auth-form__row">
            <Link className="btn btn--ghost" href="/login">
              <Icon name="lock-key" />
              Sign in with a password instead
            </Link>
          </div>
        </form>
      )}

      {step === "code" && (
        <form className={validation.shaking ? "auth-form form--shake" : "auth-form"} onSubmit={submitCode} noValidate>
          <FormSummary errors={validation.visible} />
          <label className="field">
            <span className="field__label">One-time code</span>
            <input
              id={`${ids}-code`}
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
              onBlur={() => validation.onBlur("code")}
              aria-invalid={error || validation.errors.code ? true : undefined}
              aria-describedby={
                validation.errors.code
                  ? `${ids}-code-help ${ids}-code-error`
                  : `${ids}-code-help`
              }
            />
            <FieldError id={`${ids}-code-error`}>{validation.errors.code}</FieldError>
          </label>
          <p className="field__help" id={`${ids}-code-help`}>
            The code expires shortly. It is only ever sent to your mailbox.
          </p>
          <button className="btn btn--primary" type="submit" disabled={pending}>
            <Icon name={ACTION_ICON.approve} />
            {pending ? "Verifying…" : "Verify"}
          </button>
          <div className="auth-form__row">
            <button className="btn btn--ghost" type="button" onClick={resend} disabled={resendIn > 0 || pending}>
              <Icon name={ACTION_ICON.retry} />
              {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
            </button>
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => {
                validation.reset();
                setStep("email");
                setError(null);
              }}
              disabled={pending}
            >
              <Icon name={ACTION_ICON.back} />
              Use a different address
            </button>
          </div>
        </form>
      )}

      {step === "mfa" && (
        <form className={validation.shaking ? "auth-form form--shake" : "auth-form"} onSubmit={submitMfa} noValidate>
          <FormSummary errors={validation.visible} />
          {enrollment && (
            <AuthenticatorEnrollment
              secret={enrollment.secret}
              otpauthUri={enrollment.otpauthUri}
            />
          )}
          <label className="field">
            <span className="field__label">Authenticator code</span>
            <input
              id={`${ids}-totp`}
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
              onBlur={() => validation.onBlur("totp")}
              aria-invalid={error || validation.errors.totp ? true : undefined}
              aria-describedby={
                validation.errors.totp ? `${ids}-totp-error` : undefined
              }
            />
            <FieldError id={`${ids}-totp-error`}>{validation.errors.totp}</FieldError>
          </label>
          {/* The server decides whether to honour it (it can be switched off platform-wide);
              ticking it only ASKS. The device token it returns never reaches this component. */}
          <label className="check-row">
            <input
              type="checkbox"
              name="trust_device"
              checked={trustDevice}
              onChange={(e) => setTrustDevice(e.target.checked)}
              aria-describedby={`${ids}-trust-help`}
            />
            <span>Trust this device for 30 days</span>
          </label>
          <p className="field__help" id={`${ids}-trust-help`}>
            Skips this code on this browser. Don&apos;t tick it on a shared computer.
          </p>
          <button className="btn btn--primary" type="submit" disabled={pending}>
            <Icon name="sign-in" />
            {pending ? "Signing in…" : "Sign in"}
          </button>
          <div className="auth-form__row">{startOverButton}</div>
        </form>
      )}
    </div>
  );
}
