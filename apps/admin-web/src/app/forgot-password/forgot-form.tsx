"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { requestResetCodeAction, resetPasswordAction } from "./actions";
import { NewPasswordFields } from "../../components/new-password-fields";
import { FieldError, FormSummary, useFormValidation } from "../../components/form-feedback";
import { looksLikeAdminEmail } from "../../lib/email-shape";
import { newPasswordPairReady } from "../../lib/password-policy";

/**
 * Reset a forgotten password: email → code + new password → done.
 *
 * The "code sent" screen is CONDITIONAL in its wording ("if this address belongs to an active
 * admin account…"), because the API answers identically whether it does or not; a confident
 * "we sent you a code" would turn this page into the enumeration oracle the API removed.
 *
 * The finish screen sends the operator to sign in — a reset never signs anyone in (ADR-0060 A4).
 */
type Step = "email" | "reset" | "done";

export function ForgotPasswordForm() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [pending, startTransition] = useTransition();
  const ids = useId();

  const validation = useFormValidation({
    order: step === "email" ? (["email"] as const) : step === "reset" ? (["code"] as const) : [],
    fieldId: (field) => `${ids}-${field}`,
    focus: (field) => {
      if (typeof document !== "undefined") document.getElementById(`${ids}-${field}`)?.focus();
    },
    validate: () => {
      const errors: Partial<Record<"email" | "code", string>> = {};
      if (step === "email") {
        if (email.trim() === "") errors.email = "Enter your work email.";
        else if (!looksLikeAdminEmail(email)) errors.email = "Enter a valid email address.";
      }
      if (step === "reset" && code.length < 4)
        errors.code = "Enter the code from your email.";
      return errors;
    },
  });

  // Announce each new step by moving focus to its heading — not on first render, where the
  // email field's own autofocus is where the operator starts.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  // UX only — the server owns the real resend limit.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  function sendCode(onSent: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await requestResetCodeAction({ email });
      if (!res.ok) return setError(res.error);
      setResendIn(res.resendInSeconds);
      onSent();
    });
  }

  function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    if (validation.submit() !== null) return;
    sendCode(() => {
      setCode("");
      setNewPassword("");
      setConfirmPassword("");
      validation.reset();
      setStep("reset");
    });
  }

  function resend() {
    if (resendIn > 0 || pending) return;
    sendCode(() => undefined);
  }

  function submitReset(e: React.FormEvent) {
    e.preventDefault();
    if (validation.submit() !== null) return;
    if (!newPasswordPairReady(newPassword, confirmPassword)) return;
    setError(null);
    startTransition(async () => {
      const res = await resetPasswordAction({ email, code, newPassword });
      if (!res.ok) return setError(res.error);
      // Nothing of the new password stays in memory once it is set.
      setCode("");
      setNewPassword("");
      setConfirmPassword("");
      validation.reset();
      setStep("done");
    });
  }


  return (
    <div className="auth-card">
      <div className="auth-card__head">
        <h1 className="auth-card__title" ref={headingRef} tabIndex={-1}>
          {step === "email" && "Reset your password"}
          {step === "reset" && "Check your email"}
          {step === "done" && "Password reset"}
        </h1>
        <p className="auth-card__sub">
          {step === "email" &&
            "Enter your work email. If it belongs to an active admin account, we'll email it a code to set a new password."}
          {step === "reset" && (
            <>
              If <strong className="auth-card__email">{email}</strong> belongs to an active admin
              account, a code is on its way to it. Enter it below with your new password.
            </>
          )}
          {step === "done" &&
            "Your new password is set, and every session on your account has been signed out. Sign in with it now."}
        </p>
      </div>

      <div className="auth-card__status" role="status" aria-live="polite">
        {error ? <span className="auth-error">{error}</span> : null}
      </div>

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
            {pending ? "Sending…" : "Send reset code"}
          </button>
          <div className="auth-form__row">
            <Link className="btn btn--ghost" href="/login">
              <Icon name={ACTION_ICON.back} />
              Back to sign in
            </Link>
          </div>
        </form>
      )}

      {step === "reset" && (
        <form className={validation.shaking ? "auth-form form--shake" : "auth-form"} onSubmit={submitReset} noValidate>
          <FormSummary errors={validation.visible} />
          {/* For password managers: the account the new password belongs to. */}
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
          <label className="field">
            <span className="field__label">Reset code</span>
            <input
              id={`${ids}-code`}
              className="field__input field__input--code"
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
            The code expires shortly. It only resets your password — it does not sign you in.
          </p>
          <NewPasswordFields
            value={newPassword}
            confirm={confirmPassword}
            onChange={setNewPassword}
            onConfirmChange={setConfirmPassword}
            disabled={pending}
          />
          <button className="btn btn--primary" type="submit" disabled={pending}>
            <Icon name={ACTION_ICON.approve} />
            {pending ? "Saving…" : "Set new password"}
          </button>
          <div className="auth-form__row">
            <button
              className="btn btn--ghost"
              type="button"
              onClick={resend}
              disabled={resendIn > 0 || pending}
            >
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

      {step === "done" && (
        <div className="auth-form">
          <Link className="btn btn--primary" href="/login">
            <Icon name="sign-in" />
            Go to sign in
          </Link>
        </div>
      )}
    </div>
  );
}
