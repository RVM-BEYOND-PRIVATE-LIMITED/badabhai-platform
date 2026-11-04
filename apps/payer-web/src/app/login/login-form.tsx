"use client";

import { useEffect, useState, useTransition } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Input, Tabs, Toast, tabId, tabPanelId } from "../../components/ds";
import { OtpCodeInput } from "../../components/otp-input";
import { requestCodeAction, signupAction, verifyCodeAction } from "./actions";
import { looksLikeLoginEmail } from "./email-shape";
import { usePortalNavigation } from "../../components/portal-navigation";
import { INVALID_ORG_NAME, INVALID_PHONE } from "./messages";
import type { PayerRole } from "../../lib/auth";
import { Icon, type IconName } from "@badabhai/icons";
import { IDENTIFIER_FIELD_ID, PASSWORD_FIELD_ID, PasswordSignInForm } from "./password-sign-in";
import { NEW_PASSWORD_HEADING_ID, SetNewPasswordStep } from "./set-new-password";

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
 * phone → signupAction) funnel into the EXACT SAME shared `code` step (OtpCodeInput →
 * verifyCodeAction → /dashboard; the sixth digit submits, as Verify does). There is no second OTP
 * mechanism.
 *
 * THE CODE IS NEVER DISPLAYED OR AUTO-FILLED — auth is REAL-OTP only; the payer reads the
 * 6-digit code from their real email. The resend control re-uses the SERVER cooldown
 * (`resendInSeconds`) and is disabled while it counts down.
 *
 * NO-ORACLE / NO-ENUMERATION (XB-H): both the send/create step and a failed verify show ONE
 * neutral message — identical whether the email is unknown OR already registered, a limit was
 * hit, or the code is wrong — so the UI is never an enumeration oracle.
 *
 * PASSWORD SIGN-IN (#2587) — a fourth axis, for SIGN IN only:
 *   method ∈ { password, code }  ← password is the default sign-in view (the payer app's order);
 *     "Use email code instead" / "Sign in with a password instead" switch between them, and the
 *     email-code flow above is unchanged. Signup is always the code flow.
 *   change: a TEMPORARY password was right (#2628) → the "Set a new password" step replaces the
 *     form (no tabs, like the code step). No session exists until it succeeds.
 * A code that verifies for a temporary-password account (the API's 409) moves the payer to the
 * password form with the email filled in and the instruction shown — still no session.
 */
const E164_RE = /^\+[1-9]\d{7,14}$/;
const CODE_RE = /^\d{4,8}$/;
const OTP_LENGTH = 6;
const TABS_ID = "auth-role";

type RoleKey = "company" | "agency";
type Mode = "signin" | "signup";
/** How a payer signs IN (#2587). Signup is always the code flow. */
type Method = "password" | "code";
/** Which screen the card shows — the entry forms, the code step, or the set-new-password step. */
export type LoginView = "entry" | "code" | "new_password";
/** A temporary password the API accepted (#2628), held in memory while the change step is open. */
interface PendingChange {
  identifier: string;
  temporaryPassword: string;
}
/** What the password form shows on arrival: the forced change's refusal, or the code door's guidance. */
interface PasswordArrival {
  error: string | null;
  notice: string | null;
}
const NO_ARRIVAL: PasswordArrival = { error: null, notice: null };

const EMAIL_FIELD_ID = "login-email";
const CODE_HEADING_ID = "login-code-heading";
/** The code step's inline error line — it also describes every code box while it shows. */
const CODE_ERROR_ID = "login-code-error";

/**
 * Where focus goes when the view or the sign-in method changes — the natural first control of
 * what is now on screen. The code step and the set-new-password step land on their heading (a
 * screen reader hears what the step is for); the password form on the password when the login ID
 * is already filled in, else on the login ID. A mode switch never moves focus (the radio keeps it).
 */
export function loginFocusTarget(state: {
  view: LoginView;
  method: Method;
  isSignup: boolean;
  identifier: string;
}): string {
  if (state.view === "code") return CODE_HEADING_ID;
  if (state.view === "new_password") return NEW_PASSWORD_HEADING_ID;
  if (state.isSignup || state.method === "code") return EMAIL_FIELD_ID;
  return state.identifier.trim() ? PASSWORD_FIELD_ID : IDENTIFIER_FIELD_ID;
}

/** UI role-tab → backend PayerRole. company = employer, agency = agent. */
const PAYER_ROLE: Record<RoleKey, PayerRole> = { company: "employer", agency: "agent" };

/** Per-tab voice — crisp/operational, distinct per audience (payer voice). */
const ROLE_COPY: Record<
  RoleKey,
  { tab: string; icon: IconName; tagline: string; signupSub: string; account: string }
> = {
  company: {
    tab: "Company",
    icon: "buildings",
    tagline: "Publish postings and hire.",
    signupSub: "Create your hiring desk — publish postings, see verified applicants, unlock contacts.",
    account: "Company account",
  },
  agency: {
    tab: "Agency",
    icon: "users-three",
    tagline: "Source workers for your clients.",
    signupSub: "Create your agency desk — source workers and place them with your clients.",
    account: "Agency account",
  },
};

export function LoginForm() {
  // useState call order (kept stable for the node-env render test seeding):
  // role, mode, step, email, orgName, phone, code, emailError, orgError, phoneError,
  // codeError, error, info, cooldown, succeeded, method, identifier, change, arrival.
  // (Any NEW state is appended at the END so every existing seed position is preserved.)
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
  // --- appended AFTER the original 14 slots ---
  // `succeeded` shows a brief success affordance between a correct code and the redirect.
  const [succeeded, setSucceeded] = useState(false);
  // --- #2587 password sign-in, appended after `succeeded` (same reason: seed order) ---
  const [method, setMethod] = useState<Method>("password");
  // The password form's login ID — kept here so it survives a mode or method switch.
  const [identifier, setIdentifier] = useState("");
  // A temporary password the API accepted: the set-new-password step is open while this is set.
  const [change, setChange] = useState<PendingChange | null>(null);
  const [arrival, setArrival] = useState<PasswordArrival>(NO_ARRIVAL);
  const [pending, startTransition] = useTransition();
  // A verified code lands on the dashboard with the page's "Opening Dashboard…" cue (the button
  // already reads "Signed in" — `succeeded` — until the page is gone).
  const { navigate } = usePortalNavigation();

  // Tick the resend cooldown down to zero (disables the resend button until elapsed).
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const copy = ROLE_COPY[role];
  const isSignup = mode === "signup";
  const view: LoginView = step === "code" ? "code" : change ? "new_password" : "entry";

  // On a view or method change, move focus to the natural starting point of what is now shown
  // (by element id via the DOM — the DS Input is not a forwardRef component, and the node render
  // tests mock effects/state but not useRef). A no-op in the node env.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.getElementById(loginFocusTarget({ view, method, isSignup, identifier }))?.focus();
    // Deliberately NOT on mode or typing: focus moves only when what the card shows changes.
  }, [view, method]);

  // Inline valid affordance — a subtle check once the typed email is well-formed (and not in
  // an error state). Presentation only; the server is still the source of truth.
  const emailValid = !emailError && looksLikeLoginEmail(email.trim());

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
    // A message the password form arrived with is stale once the payer has moved on.
    setArrival(NO_ARRIVAL);
  }

  /** Every sign-in that opens a session lands here: the dashboard, cued, replacing /login. */
  function goToDashboard() {
    navigate("/dashboard", { pendingLabel: "Dashboard", replace: true, refresh: true });
  }

  /** "Sign in with a password instead" — the typed email becomes the login ID. */
  function switchToPassword() {
    setMethod("password");
    if (email.trim()) setIdentifier(email.trim());
    setEmailError(null);
    clearOutcome();
    setArrival(NO_ARRIVAL);
  }

  /** "Use email code instead" — a login ID that is an email fills the email field. */
  function switchToEmailCode(typed: string) {
    setMethod("code");
    if (looksLikeLoginEmail(typed)) setEmail(typed);
    setEmailError(null);
    clearOutcome();
    setArrival(NO_ARRIVAL);
  }

  /** A temporary password was right (#2628): open the change step. Still no session. */
  function openChangeStep(pending: PendingChange) {
    setIdentifier(pending.identifier);
    setArrival(NO_ARRIVAL);
    setChange(pending);
  }

  /** The new password is set and a session is open: drop the temporary password, then go. */
  function onChangeSignedIn() {
    setChange((c) => (c ? { identifier: c.identifier, temporaryPassword: "" } : c));
    goToDashboard();
  }

  /** Leave the change step for the password form (abandoned, or the temporary password refused). */
  function closeChangeStep(error: string | null) {
    setChange(null);
    setMethod("password");
    setArrival({ error, notice: null });
  }

  function startCodeStep(resendInSeconds: number) {
    setStep("code");
    // Resend countdown is driven by the SERVER cooldown — never a hard-coded number.
    setCooldown(resendInSeconds);
  }

  /** Step 1 (signin) — request a login code for the email. UNCHANGED logic. */
  function sendLoginCode() {
    clearOutcome();
    if (!looksLikeLoginEmail(email.trim())) {
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
    if (!looksLikeLoginEmail(email.trim())) {
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

  /** The form's submit — Verify, or Enter in a box: the code in the boxes. */
  function onVerify(e: FormEvent) {
    e.preventDefault();
    verifyCode(code);
  }

  /**
   * Step 2 — verify a code. The form's submit and the sixth digit both land here: OtpCodeInput's
   * `onComplete` hands over the code it just completed (this render still holds the edit before
   * it). One request at a time — nothing is sent while one is in flight (a verify, or a resend), or
   * once a code was accepted — so the sixth digit and a Verify press never submit twice.
   */
  function verifyCode(entered: string) {
    if (pending || succeeded) return;
    setError(null);
    const submitted = entered.trim();
    if (!CODE_RE.test(submitted)) {
      setCodeError("Enter the numeric code (4–8 digits).");
      return;
    }
    setCodeError(null);
    startTransition(async () => {
      // ROLE-AGNOSTIC: verify is identical for company- and agency-created accounts. An agent
      // account lands on the agency-labelled portal automatically (the server resolves the role).
      const res = await verifyCodeAction({ email: email.trim(), code: submitted });
      if (res.ok) {
        // The accepted code stays readable — locked in the boxes, with the check — while the
        // dashboard opens (a box edited during the check shows the code that was accepted).
        setCode(submitted);
        setSucceeded(true);
        setInfo(res.isNewPayer ? "Account created — welcome!" : "Welcome back!");
        goToDashboard();
      } else if (res.usePassword) {
        // #2587 — the code was right, but the account holds a temporary password (#2628): NO
        // session. Password sign-in, with the email filled in and the instruction shown.
        setStep("entry");
        setCode("");
        setCodeError(null);
        setCooldown(0);
        setMode("signin");
        setMethod("password");
        setIdentifier(email.trim());
        setArrival({ error: null, notice: res.error });
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
      {info && succeeded ? (
        <Toast tone="success" title="Signed in">
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
          {/* Six boxes (components/otp-input.tsx): the visible label names the group, the first box
              takes the browser's one-time-code autofill, and the sixth digit — or a whole pasted
              or autofilled code — submits through verifyCode, as Verify does. An accepted code
              locks read-only with a check. */}
          <OtpCodeInput
            label={`Enter the ${OTP_LENGTH}-digit login code`}
            length={OTP_LENGTH}
            value={code}
            autoFocus
            success={succeeded}
            describedBy={codeError ? CODE_ERROR_ID : undefined}
            onChange={(v) => {
              setCode(v);
              if (codeError) setCodeError(null);
            }}
            onComplete={verifyCode}
          />
          {codeError ? (
            <span id={CODE_ERROR_ID} className="bb-field__error" role="alert">
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

  // ---- #2587 SET-NEW-PASSWORD step: replaces the form (no tabs), like the code step ----
  if (change) {
    return (
      <SetNewPasswordStep
        identifier={change.identifier}
        temporaryPassword={change.temporaryPassword}
        onSignedIn={onChangeSignedIn}
        onRestart={(refusal) => closeChangeStep(refusal)}
        onCancel={() => closeChangeStep(null)}
      />
    );
  }

  // ---- ENTRY step: progress cue + role tabs (PRIMARY) + light mode switch + the entry form ----
  const passwordSignIn = !isSignup && method === "password";
  return (
    <div className="login-auth">
      {/* The 2-step cue belongs to the code flow; password sign-in is one step. */}
      {passwordSignIn ? null : (
        <div className="login-steps" aria-hidden="true">
          <span className="login-steps__label">Step 1 of 2</span>
          <span className="login-steps__track">
            <span className="login-steps__dot login-steps__dot--active" />
            <span className="login-steps__dot" />
          </span>
        </div>
      )}

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

        {passwordSignIn ? (
          <PasswordSignInForm
            identifier={identifier}
            onIdentifierChange={setIdentifier}
            initialError={arrival.error}
            initialNotice={arrival.notice}
            onSignedIn={goToDashboard}
            onChangeRequired={openChangeStep}
            onUseEmailCode={switchToEmailCode}
          />
        ) : (
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
            {isSignup ? null : (
              <Button
                type="button"
                variant="ghost"
                iconLeft="key"
                disabled={pending}
                onClick={switchToPassword}
              >
                Sign in with a password instead
              </Button>
            )}

            <p className="login-trust">
              <Icon name="lock-key" />
              Secure one-time-code sign-in. We’ll never share your details.
            </p>
            {statusRegion}
          </form>
        )}
      </div>
    </div>
  );
}
