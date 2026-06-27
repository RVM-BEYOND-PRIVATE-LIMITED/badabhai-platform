"use client";

import { useEffect, useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Input, OtpInput, Tabs, Toast, tabId, tabPanelId } from "../../components/ds";
import { requestCodeAction, signupAction, verifyCodeAction } from "./actions";
import { INVALID_ORG_NAME, INVALID_PHONE, SEND_CONFIRMATION, VERIFIED_CONFIRMATION } from "./messages";
import type { PayerRole } from "../../lib/auth";

/**
 * Client auth form (AUTH-1) — a tri-axis state machine over the design system, presented as a
 * guided 2-step enterprise auth flow (progress cue → entry → confirm code → success):
 *
 *   role ∈ { company(employer), agency(agent) }  ← top ARIA Tabs (default Company). The PRIMARY
 *     control. Sets the role sent to SIGNUP + swaps voice/labels + the brand sub-label + the
 *     active-context Badge. In SIGNIN it is COSMETIC ONLY (see below).
 *   mode ∈ { signin, signup }                     ← a labelled radiogroup, styled as a LIGHT
 *     secondary switch under the tabs (deliberately NOT a second heavy segmented bar).
 *   step ∈ { entry, code }                         ← the existing 2-step OTP.
 *
 * THE ONE DESIGN TRUTH (load-bearing security):
 *   Login is ROLE-AGNOSTIC. The account's stored role is set at SIGNUP; the server already
 *   knows it. The Company|Agency tabs are a SIGNUP-ROLE SELECTOR + voice/labelling ONLY —
 *   NOT a login filter. LOGIN MUST NEVER REJECT OR BRANCH ON THE SELECTED TAB — doing so
 *   would leak whether an email is a Company or an Agency (a role-enumeration oracle). A user
 *   on the Company tab can sign IN to an Agency account and lands on the agency portal, and
 *   vice-versa. DO NOT add tab-gating to signin here or anywhere downstream.
 *
 * Both signin-entry (email → requestCodeAction) and signup-entry (org_name + email + optional
 * phone → signupAction) funnel into the EXACT SAME shared `code` step (OtpInput →
 * verifyCodeAction → /dashboard). There is no second OTP mechanism.
 *
 * THE CODE IS NEVER DISPLAYED OR AUTO-FILLED — auth is REAL-OTP only; the payer reads the
 * 6-digit code from their real email. The resend control re-uses the SERVER cooldown
 * (`resendInSeconds`) and is disabled while it counts down.
 *
 * NO-ORACLE / NO-ENUMERATION (XB-H): both the send/create step and a failed verify show ONE
 * neutral message — identical whether the email is unknown OR already registered, a limit was
 * hit, or the code is wrong — so the UI is never an enumeration oracle.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const CODE_RE = /^\d{4,8}$/;
const OTP_LENGTH = 6;
const TABS_ID = "auth-role";

type RoleKey = "company" | "agency";
type Mode = "signin" | "signup";

/** UI role-tab → backend PayerRole. company = employer, agency = agent. */
const PAYER_ROLE: Record<RoleKey, PayerRole> = { company: "employer", agency: "agent" };

/** Per-tab voice — crisp/operational, distinct per audience (payer voice). */
const ROLE_COPY: Record<
  RoleKey,
  { tab: string; icon: string; tagline: string; signupSub: string; account: string }
> = {
  company: {
    tab: "Company",
    icon: "buildings",
    tagline: "Post jobs and hire.",
    signupSub: "Create your hiring desk — post jobs, see verified applicants, unlock contacts.",
    account: "Company account",
  },
  agency: {
    tab: "Agency",
    icon: "users-three",
    tagline: "Source candidates for your clients.",
    signupSub: "Create your agency desk — source candidates and place them with your clients.",
    account: "Agency account",
  },
};

export function LoginForm() {
  const router = useRouter();
  // useState call order (kept stable for the node-env render test seeding):
  // role, mode, step, email, orgName, phone, code, emailError, orgError, phoneError,
  // codeError, error, info, cooldown.  (Any NEW state is appended AFTER cooldown so the
  // test's 14-slot seed order is preserved.)
  const [role, setRole] = useState<RoleKey>("company");
  const [mode, setMode] = useState<Mode>("signin");
  const [step, setStep] = useState<"entry" | "code">("entry");
  const [email, setEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  // --- appended AFTER the 14 seeded slots (test seeds only the first 14) ---
  // `succeeded` shows a brief success affordance between a correct code and the redirect.
  const [succeeded, setSucceeded] = useState(false);
  const [pending, startTransition] = useTransition();

  // Stable element ids used only for focus management on step change (a11y). We target by id
  // via the DOM rather than a React ref so this stays hook-free (the DS Input is not a
  // forwardRef component, and the node render test mocks effects/state but not useRef).
  const EMAIL_FIELD_ID = "login-email";
  const CODE_HEADING_ID = "login-code-heading";

  // Tick the resend cooldown down to zero (disables the resend button until elapsed).
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // On step change, move focus to the natural starting point of the new step (DOM-only; a no-op
  // in the node render test where useEffect is mocked out).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const targetId = step === "code" ? CODE_HEADING_ID : EMAIL_FIELD_ID;
    document.getElementById(targetId)?.focus();
  }, [step]);

  const copy = ROLE_COPY[role];
  const isSignup = mode === "signup";
  // Inline valid affordance — a subtle check once the typed email is well-formed (and not in
  // an error state). Presentation only; the server is still the source of truth.
  const emailValid = !emailError && EMAIL_RE.test(email.trim());

  function clearOutcome() {
    setError(null);
    setInfo(null);
  }

  /** Switch role tab. Mid-ENTRY: preserve the typed email, reset role-specific fields. */
  function onSelectRole(id: string) {
    if (step === "code") return; // disabled mid-verification (handled at render, belt-and-braces)
    if (id !== "company" && id !== "agency") return;
    setRole(id);
    // Role-specific signup fields don't carry across a role switch.
    setOrgName("");
    setOrgError(null);
    setPhone("");
    setPhoneError(null);
    // Clear a stale email validation error too (parity with onSelectMode) so a switch never
    // leaves an orphaned error on the preserved email field.
    setEmailError(null);
    clearOutcome();
  }

  /** Switch signin/signup mode. Preserve the typed email; reset signup-only fields + outcome. */
  function onSelectMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setOrgName("");
    setOrgError(null);
    setPhone("");
    setPhoneError(null);
    setEmailError(null);
    clearOutcome();
  }

  function startCodeStep(resendInSeconds: number) {
    setStep("code");
    // Resend countdown is driven by the SERVER cooldown — never a hard-coded number.
    setCooldown(resendInSeconds);
    // Neutral, account-state-independent confirmation. The code is NEVER echoed.
    setInfo(SEND_CONFIRMATION);
  }

  /** Step 1 (signin) — request a login code for the email. UNCHANGED logic. */
  function sendLoginCode() {
    clearOutcome();
    if (!EMAIL_RE.test(email.trim())) {
      setEmailError("Enter a valid email address.");
      return;
    }
    setEmailError(null);
    startTransition(async () => {
      const res = await requestCodeAction({ email: email.trim() });
      if (res.ok) startCodeStep(res.resendInSeconds);
      else setError(res.error);
    });
  }

  /** Step 1 (signup) — create the account for the active ROLE, then the SAME code step. */
  function sendSignup() {
    clearOutcome();
    let bad = false;
    if (orgName.trim().length < 1 || orgName.trim().length > 200) {
      setOrgError(INVALID_ORG_NAME);
      bad = true;
    } else setOrgError(null);
    if (!EMAIL_RE.test(email.trim())) {
      setEmailError("Enter a valid email address.");
      bad = true;
    } else setEmailError(null);
    const phoneTrimmed = phone.trim();
    if (phoneTrimmed && !E164_RE.test(phoneTrimmed)) {
      setPhoneError(INVALID_PHONE);
      bad = true;
    } else setPhoneError(null);
    if (bad) return;
    startTransition(async () => {
      const res = await signupAction({
        role: PAYER_ROLE[role],
        orgName: orgName.trim(),
        email: email.trim(),
        ...(phoneTrimmed ? { phone: phoneTrimmed } : {}),
      });
      if (res.ok) startCodeStep(res.resendInSeconds);
      else setError(res.error);
    });
  }

  function onEntry(e: FormEvent) {
    e.preventDefault();
    if (isSignup) sendSignup();
    else sendLoginCode();
  }

  function onResend() {
    if (cooldown > 0 || pending) return;
    // Re-run the SAME step-1 action that got us here (signup vs signin).
    if (isSignup) sendSignup();
    else sendLoginCode();
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
      // ROLE-AGNOSTIC: verify is identical for company- and agency-created accounts. An agent
      // account lands on the agency-labelled portal automatically (the server resolves the role).
      const res = await verifyCodeAction({ email: email.trim(), code: code.trim() });
      if (res.ok) {
        // Brief success affordance before the redirect (collapses instantly under
        // prefers-reduced-motion — the CSS animation is motion-gated).
        setSucceeded(true);
        setInfo(VERIFIED_CONFIRMATION);
        router.replace("/dashboard");
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  function backToEntry() {
    setStep("entry");
    setCode("");
    setError(null);
    setInfo(null);
    setCodeError(null);
    setCooldown(0);
    setSucceeded(false);
  }

  const statusRegion = (
    <div aria-live="polite" className="login-status">
      {info ? (
        <Toast tone={succeeded ? "success" : "brand"} title={succeeded ? "Signed in" : "Login code"}>
          {info}
        </Toast>
      ) : null}
      {error ? (
        <Toast tone="danger" title={isSignup ? "Couldn’t start signup" : "Couldn’t sign in"}>
          {error}
        </Toast>
      ) : null}
    </div>
  );

  // ---- Shared CODE step (UNCHANGED contract for both signin and signup) ----
  if (step === "code") {
    return (
      <form className="login-form" onSubmit={onVerify}>
        <div className="login-steps" aria-hidden="true">
          <span className="login-steps__label">Step 2 of 2</span>
          <span className="login-steps__track">
            <span className="login-steps__dot login-steps__dot--done" />
            <span className="login-steps__dot login-steps__dot--active" />
          </span>
        </div>

        <p id={CODE_HEADING_ID} tabIndex={-1} className="login-otp__sent">
          We sent a {OTP_LENGTH}-digit code to <strong>{email.trim()}</strong>. Enter it below to
          continue.
        </p>
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
        <Button
          type="submit"
          variant={succeeded ? "success" : "primary"}
          block
          loading={pending}
          disabled={succeeded}
          iconLeft={succeeded ? "check-circle" : "sign-in"}
        >
          {succeeded ? "Signed in" : pending ? "Verifying…" : "Verify & sign in"}
        </Button>
        <div className="login-actions__row">
          <Button
            type="button"
            variant="secondary"
            disabled={pending || succeeded || cooldown > 0}
            onClick={onResend}
            iconLeft="arrow-clockwise"
          >
            {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending || succeeded}
            onClick={backToEntry}
            iconLeft="arrow-left"
          >
            Use a different email
          </Button>
        </div>
        {statusRegion}
      </form>
    );
  }

  // ---- ENTRY step: progress cue + role tabs (PRIMARY) + light mode switch + the entry form ----
  return (
    <div className="login-auth">
      <div className="login-steps" aria-hidden="true">
        <span className="login-steps__label">Step 1 of 2</span>
        <span className="login-steps__track">
          <span className="login-steps__dot login-steps__dot--active" />
          <span className="login-steps__dot" />
        </span>
      </div>

      <div className="login-roleblock">
        <span className="login-roleblock__label" id={`${TABS_ID}-label`}>
          I’m a
        </span>
        <Tabs
          idBase={TABS_ID}
          variant="segmented"
          aria-labelledby={`${TABS_ID}-label`}
          className="login-roletabs"
          value={role}
          onChange={onSelectRole}
          tabs={[
            { id: "company", label: ROLE_COPY.company.tab, icon: ROLE_COPY.company.icon },
            { id: "agency", label: ROLE_COPY.agency.tab, icon: ROLE_COPY.agency.icon },
          ]}
        />
      </div>

      <div
        id={tabPanelId(TABS_ID, role)}
        role="tabpanel"
        aria-labelledby={tabId(TABS_ID, role)}
        className="login-rolepanel"
      >
        <div className="login-context">
          <Badge tone={role === "agency" ? "info" : "brand"} icon={copy.icon}>
            {copy.account}
          </Badge>
          <span className="login-context__tag">{copy.tagline}</span>
        </div>

        {/* Mode switch — a labelled radiogroup, presented as a LIGHT secondary control (not a
            second heavy segmented bar) so it never reads as a duplicate of the role tabs. */}
        <div
          className="login-modes"
          role="radiogroup"
          aria-label={`${isSignup ? "Create or sign in" : "Sign in or create"} — ${copy.account}`}
        >
          <label className={`login-mode ${mode === "signin" ? "login-mode--active" : ""}`}>
            <input
              type="radio"
              name="auth-mode"
              className="login-mode__input"
              checked={mode === "signin"}
              onChange={() => onSelectMode("signin")}
            />
            <span>Sign in</span>
          </label>
          <label className={`login-mode ${mode === "signup" ? "login-mode--active" : ""}`}>
            <input
              type="radio"
              name="auth-mode"
              className="login-mode__input"
              checked={mode === "signup"}
              onChange={() => onSelectMode("signup")}
            />
            <span>Create account</span>
          </label>
        </div>

        <form className="login-form" onSubmit={onEntry}>
          {isSignup ? (
            <Input
              label={role === "agency" ? "Agency name" : "Company name"}
              name="organization"
              iconLeft="buildings"
              autoComplete="organization"
              placeholder={role === "agency" ? "Your agency" : "Your company"}
              value={orgName}
              maxLength={200}
              error={orgError ?? undefined}
              aria-invalid={orgError ? true : undefined}
              onChange={(ev) => {
                setOrgName(ev.target.value);
                if (orgError) setOrgError(null);
              }}
            />
          ) : null}

          <Input
            id={EMAIL_FIELD_ID}
            label="Email"
            type="email"
            name="email"
            iconLeft="envelope"
            iconRight={emailValid ? "check-circle" : undefined}
            autoComplete="username"
            placeholder="you@company.example"
            value={email}
            error={emailError ?? undefined}
            aria-invalid={emailError ? true : undefined}
            className={emailValid ? "login-input--valid" : undefined}
            onChange={(ev) => {
              setEmail(ev.target.value);
              if (emailError) setEmailError(null);
            }}
          />

          {isSignup ? (
            <Input
              label="Phone"
              type="tel"
              name="tel"
              optional
              iconLeft="phone"
              autoComplete="tel"
              inputMode="tel"
              placeholder="+919876543210"
              hint="Optional. Use the full international format, e.g. +919876543210."
              value={phone}
              error={phoneError ?? undefined}
              aria-invalid={phoneError ? true : undefined}
              onChange={(ev) => {
                setPhone(ev.target.value);
                if (phoneError) setPhoneError(null);
              }}
            />
          ) : null}

          <Button
            type="submit"
            variant="primary"
            block
            loading={pending}
            iconLeft={isSignup ? "user-plus" : "paper-plane-right"}
          >
            {pending
              ? isSignup
                ? "Creating…"
                : "Sending code…"
              : isSignup
                ? "Create account & send code"
                : "Send login code"}
          </Button>

          <p className="login-trust">
            <i className="ph ph-lock-key" aria-hidden="true" />
            Secure one-time-code sign-in — no passwords. We’ll never share your details.
          </p>
          {statusRegion}
        </form>
      </div>
    </div>
  );
}
