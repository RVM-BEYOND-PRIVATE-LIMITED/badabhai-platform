"use client";

import { useEffect, useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, OtpInput, Toast } from "../../components/ds";
import { requestCodeAction, verifyCodeAction } from "./actions";
import { SEND_CONFIRMATION } from "./messages";

/**
 * Client login form (DS1.1 — re-skinned onto the design system) — TWO-STEP OTP
 * (email → 6-digit code). Calls the Server Actions; it never sees a secret or a session
 * token (the seam sets an httpOnly cookie server-side).
 *
 * THE CODE IS NEVER DISPLAYED OR AUTO-FILLED — login is REAL-OTP only; the payer reads the
 * 6-digit code from their real email and types it into the OtpInput. The resend control
 * re-uses the SERVER cooldown (`resendInSeconds`) and is disabled while it counts down.
 *
 * NO-ORACLE (XB-H): both the send step and a failed verify show ONE neutral error in a
 * Toast — identical copy whether the email is unknown, a limit was hit, or the code is
 * wrong — so the UI is never an enumeration oracle.
 *
 * Payer login is EMAIL-based (the backend payer-auth contract); the 6-cell OtpInput is
 * the design-system affordance for the numeric code.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{4,8}$/;
const OTP_LENGTH = 6;

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [pending, startTransition] = useTransition();

  // Tick the resend cooldown down to zero (disables the resend button until elapsed).
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function sendCode() {
    setError(null);
    setInfo(null);
    if (!EMAIL_RE.test(email.trim())) {
      setEmailError("Enter a valid email address.");
      return;
    }
    setEmailError(null);
    startTransition(async () => {
      const res = await requestCodeAction({ email: email.trim() });
      if (res.ok) {
        setStep("code");
        // Resend countdown is driven by the SERVER cooldown — never a hard-coded number.
        setCooldown(res.resendInSeconds);
        // Neutral, account-state-independent confirmation. The code is NEVER echoed —
        // the payer reads it from their email.
        setInfo(SEND_CONFIRMATION);
      } else {
        setError(res.error);
      }
    });
  }

  function onRequest(e: FormEvent) {
    e.preventDefault();
    sendCode();
  }

  function onResend() {
    if (cooldown > 0 || pending) return;
    sendCode();
  }

  function onVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!CODE_RE.test(code.trim())) {
      setCodeError("Enter the numeric code (4–8 digits).");
      return;
    }
    setCodeError(null);
    startTransition(async () => {
      const res = await verifyCodeAction({ email: email.trim(), code: code.trim() });
      if (res.ok) {
        router.replace("/dashboard");
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  const statusRegion = (
    <div aria-live="polite" className="login-status">
      {info ? (
        <Toast tone="brand" title="Login code">
          {info}
        </Toast>
      ) : null}
      {error ? (
        <Toast tone="danger" title="Couldn’t sign in">
          {error}
        </Toast>
      ) : null}
    </div>
  );

  if (step === "code") {
    return (
      <form className="login-form" onSubmit={onVerify}>
        <div className="login-otp">
          <span className="login-otp__label">Enter the {OTP_LENGTH}-digit login code</span>
          <OtpInput
            length={OTP_LENGTH}
            value={code}
            autoFocus
            onChange={(v) => {
              setCode(v);
              if (codeError) setCodeError(null);
            }}
          />
          {codeError ? (
            <span className="bb-field__error" role="alert">
              {codeError}
            </span>
          ) : null}
        </div>
        <Button type="submit" variant="primary" block loading={pending} iconLeft="sign-in">
          {pending ? "Verifying…" : "Verify & sign in"}
        </Button>
        <div className="login-actions__row">
          <Button
            type="button"
            variant="secondary"
            disabled={pending || cooldown > 0}
            onClick={onResend}
          >
            {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
              setInfo(null);
              setCodeError(null);
              setCooldown(0);
            }}
          >
            Use a different email
          </Button>
        </div>
        {statusRegion}
      </form>
    );
  }

  return (
    <form className="login-form" onSubmit={onRequest}>
      <Input
        label="Email"
        type="email"
        iconLeft="envelope"
        autoComplete="username"
        placeholder="you@company.example"
        value={email}
        error={emailError ?? undefined}
        aria-invalid={emailError ? true : undefined}
        onChange={(ev) => {
          setEmail(ev.target.value);
          if (emailError) setEmailError(null);
        }}
      />
      <Button type="submit" variant="primary" block loading={pending} iconLeft="paper-plane-right">
        {pending ? "Sending code…" : "Send login code"}
      </Button>
      {statusRegion}
    </form>
  );
}
