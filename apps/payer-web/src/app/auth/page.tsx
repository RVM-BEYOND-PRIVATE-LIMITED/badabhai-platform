"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiError, requestLogin, signup, verifyLogin, type PayerRole } from "../../lib/api";
import { setSession } from "../../lib/session";

type Mode = "signup" | "login";
type Step = "identify" | "verify";

/**
 * Role-aware signup + OTP/invite login for BOTH company (employer) and agency (agent).
 * There is NO password — login is a code sent to the account email (mock OTP in Phase 1).
 *
 * Flow:
 *   signup  → POST /payer/signup        (role is chosen here) → code → verify
 *   login   → POST /payer/login/request                       → code → verify
 *   verify  → POST /payer/login/verify  → mint session, store token client-side
 */
function AuthInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initialMode: Mode = params.get("mode") === "login" ? "login" : "signup";

  const [mode, setMode] = useState<Mode>(initialMode);
  const [step, setStep] = useState<Step>("identify");

  const [role, setRole] = useState<PayerRole>("employer");
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // dev_otp is echoed only on a mock channel in dev/test — surfaced to ease local testing.
  const [devOtp, setDevOtp] = useState<string | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setStep("identify");
    setError(null);
    setDevOtp(null);
    setCode("");
  }

  async function onIdentify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDevOtp(null);
    try {
      const res =
        mode === "signup"
          ? await signup({ role, email, org_name: orgName })
          : await requestLogin(email);
      setDevOtp(res.dev_otp ?? null);
      setStep("verify");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await verifyLogin(email, code);
      setSession(session.access_token, {
        payerId: session.payer_id,
        role: session.role,
        email,
      });
      router.push("/dashboard");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">{mode === "signup" ? "Create your account" : "Sign in"}</h1>
      <p className="page-sub">
        {mode === "signup"
          ? "Companies and Agencies both sign up here — pick your account type below."
          : "We'll email you a one-time code. There is no password."}
      </p>

      <div className="tabs">
        <button
          type="button"
          className={`tab ${mode === "signup" ? "active" : ""}`}
          onClick={() => switchMode("signup")}
        >
          Sign up
        </button>
        <button
          type="button"
          className={`tab ${mode === "login" ? "active" : ""}`}
          onClick={() => switchMode("login")}
        >
          Log in
        </button>
      </div>

      <div className="card">
        {step === "identify" ? (
          <form className="form" onSubmit={onIdentify}>
            {mode === "signup" && (
              <>
                <div className="field">
                  <span className="field-legend" id="role-label">
                    Account type
                  </span>
                  <div className="role-row" role="radiogroup" aria-labelledby="role-label">
                    <label className={`role-option ${role === "employer" ? "selected" : ""}`}>
                      <input
                        type="radio"
                        name="role"
                        value="employer"
                        checked={role === "employer"}
                        onChange={() => setRole("employer")}
                      />
                      Company
                    </label>
                    <label className={`role-option ${role === "agent" ? "selected" : ""}`}>
                      <input
                        type="radio"
                        name="role"
                        value="agent"
                        checked={role === "agent"}
                        onChange={() => setRole("agent")}
                      />
                      Agency
                    </label>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="org">Organisation name</label>
                  <input
                    id="org"
                    className="input"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    required
                    maxLength={200}
                    placeholder="e.g. Sharma CNC Works"
                  />
                </div>
              </>
            )}

            <div className="field">
              <label htmlFor="email">Work email</label>
              <input
                id="email"
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={254}
                placeholder="you@company.com"
              />
            </div>

            {error && <p className="error-text">{error}</p>}

            <div className="btn-row">
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Sending…" : "Send login code"}
              </button>
            </div>
          </form>
        ) : (
          <form className="form" onSubmit={onVerify}>
            <p className="page-sub" style={{ margin: 0 }}>
              We sent a one-time code to <strong>{email}</strong>.
            </p>
            {devOtp && (
              <p className="ok-text">
                Dev code (mock channel only): <span className="mono">{devOtp}</span>
              </p>
            )}

            <div className="field">
              <label htmlFor="code">Login code</label>
              <input
                id="code"
                className="input mono"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                pattern="\d{4,8}"
                placeholder="6-digit code"
              />
            </div>

            {error && <p className="error-text">{error}</p>}

            <div className="btn-row">
              <button className="btn" type="submit" disabled={busy}>
                {busy ? "Verifying…" : "Verify & continue"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep("identify")}
                disabled={busy}
              >
                Back
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}

export default function AuthPage() {
  // useSearchParams() requires a Suspense boundary under the App Router.
  return (
    <Suspense fallback={<p className="page-sub">Loading…</p>}>
      <AuthInner />
    </Suspense>
  );
}
