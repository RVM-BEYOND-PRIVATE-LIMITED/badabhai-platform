"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestCodeAction, verifyCodeAction } from "./actions";

/**
 * Client login form — TWO-STEP OTP (email → code). Calls the Server Actions; it never
 * sees a secret or a session token (the seam sets an httpOnly cookie server-side). A
 * failed verify shows ONE neutral error (no enumeration oracle, XB-H). In dev/test the
 * mock/api channel may echo a `devOtp` to prefill the code so a harness can finish.
 *
 * HARDENING (C5): client email-format + code-shape checks render INLINE per-field errors
 * before any round-trip; the resend code is on a cooldown driven by the server's
 * `resendInSeconds`; the info/error region is aria-live so assistive tech is notified.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{4,8}$/;

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
        setCooldown(res.resendInSeconds);
        if (res.devOtp) {
          setCode(res.devOtp);
          setInfo(`Dev code prefilled: ${res.devOtp}`);
        } else {
          setInfo("A login code has been sent. Enter it below.");
        }
      } else {
        setError(res.error);
      }
    });
  }

  function onRequest(e: React.FormEvent) {
    e.preventDefault();
    sendCode();
  }

  function onResend() {
    if (cooldown > 0 || pending) return;
    sendCode();
  }

  function onVerify(e: React.FormEvent) {
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

  if (step === "code") {
    return (
      <form className="form" onSubmit={onVerify}>
        <div className="field">
          <label htmlFor="code">
            Login code<span className="req">*</span>
          </label>
          <input
            id="code"
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={codeError ? "code-error" : undefined}
            onChange={(ev) => {
              setCode(ev.target.value);
              if (codeError) setCodeError(null);
            }}
          />
          {codeError ? (
            <p className="error-text" id="code-error">
              {codeError}
            </p>
          ) : null}
        </div>
        <div className="btn-row">
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Verifying…" : "Verify & sign in"}
          </button>
          <button
            className="btn secondary"
            type="button"
            disabled={pending || cooldown > 0}
            onClick={onResend}
          >
            {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
          </button>
          <button
            className="btn secondary"
            type="button"
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
          </button>
        </div>
        <div aria-live="polite">
          {info ? <p className="note">{info}</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
        </div>
      </form>
    );
  }

  return (
    <form className="form" onSubmit={onRequest}>
      <div className="field">
        <label htmlFor="email">
          Email<span className="req">*</span>
        </label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="username"
          value={email}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? "email-error" : undefined}
          onChange={(ev) => {
            setEmail(ev.target.value);
            if (emailError) setEmailError(null);
          }}
        />
        {emailError ? (
          <p className="error-text" id="email-error">
            {emailError}
          </p>
        ) : null}
      </div>
      <div className="btn-row">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Sending code…" : "Send login code"}
        </button>
      </div>
      <div aria-live="polite">
        {info ? <p className="note">{info}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </form>
  );
}
