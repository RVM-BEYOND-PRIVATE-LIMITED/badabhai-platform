"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestCodeAction, verifyCodeAction } from "./actions";

/**
 * Client login form — TWO-STEP OTP (email → code). Calls the Server Actions; it never
 * sees a secret or a session token (the seam sets an httpOnly cookie server-side). A
 * failed verify shows ONE neutral error (no enumeration oracle, XB-H). In dev/test the
 * mock/api channel may echo a `devOtp` to prefill the code so a harness can finish.
 */
export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await requestCodeAction({ email });
      if (res.ok) {
        setStep("code");
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

  function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await verifyCodeAction({ email, code });
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
            onChange={(ev) => setCode(ev.target.value)}
          />
        </div>
        <div className="btn-row">
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Verifying…" : "Verify & sign in"}
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
            }}
          >
            Use a different email
          </button>
        </div>
        {info ? <p className="note">{info}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
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
          onChange={(ev) => setEmail(ev.target.value)}
        />
      </div>
      <div className="btn-row">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Sending code…" : "Send login code"}
        </button>
      </div>
      {info ? <p className="note">{info}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
    </form>
  );
}
