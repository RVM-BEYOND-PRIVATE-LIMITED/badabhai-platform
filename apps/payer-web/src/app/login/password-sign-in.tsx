"use client";

import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { Icon } from "@badabhai/icons";
import { Button, Input, Toast } from "../../components/ds";
import { focusControl } from "../../lib/form-focus";
import { passwordSignInAction, type PasswordSignInActionResult } from "./actions";
import { IDENTIFIER_REQUIRED, PASSWORD_REQUIRED, PASSWORD_SIGNIN_UNAVAILABLE } from "./messages";
import { PasswordField } from "./password-field";
import { shakeClass } from "./shake";

/** Stable ids — the parent moves focus here by id when the view changes (login-form.tsx). */
export const IDENTIFIER_FIELD_ID = "login-identifier";
export const PASSWORD_FIELD_ID = "login-password";
/** The status region. A message the form arrives with also describes the password field. */
const STATUS_ID = "login-password-status";

export interface PasswordSignInFormProps {
  /**
   * The login ID — the parent's state, so it survives a mode or method switch (an email carried
   * over from the code flow, or the abandoned change step's).
   */
  identifier: string;
  onIdentifierChange: (value: string) => void;
  /** A refusal to show on arrival: the forced change's 401 (the neutral sign-in error). */
  initialError?: string | null;
  /** Guidance to show on arrival: the code door's "this account has a temporary password". */
  initialNotice?: string | null;
  /** A session was opened. The parent navigates — one place, one "Opening Dashboard…" cue. */
  onSignedIn: () => void;
  /**
   * The password was a TEMPORARY one (#2628): it was right, and NO session exists. The parent
   * shows the set-new-password step, which resends it with the replacement.
   */
  onChangeRequired: (pending: { identifier: string; temporaryPassword: string }) => void;
  /** "Use email code instead". The typed login ID travels, so an email is never retyped. */
  onUseEmailCode: (identifier: string) => void;
}

/**
 * Password sign-in (#2587) — login ID (email, phone or company name, as the payer app reads it)
 * and password, beside the email-code flow. ROLE-AGNOSTIC like the code door: nothing here reads
 * the Company | Agency tab; the API resolves the account's role.
 *
 * NO-ORACLE: a refused sign-in shows the action's neutral copy (one message for every credential
 * miss), never which part was wrong. The password lives only in this component's state for the
 * request and is cleared once it has done its job (signed in, or handed to the change step).
 */
export function PasswordSignInForm({
  identifier,
  onIdentifierChange,
  initialError,
  initialNotice,
  onSignedIn,
  onChangeRequired,
  onUseEmailCode,
}: PasswordSignInFormProps) {
  // useState call order (the node render tests seed by it): password, identifierError,
  // passwordError, error, notice, shake, succeeded, arrived.
  const [password, setPassword] = useState("");
  const [identifierError, setIdentifierError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  // Each refused attempt bumps it, which restarts the form's one shake (shake.ts).
  const [shake, setShake] = useState(0);
  const [succeeded, setSucceeded] = useState(false);
  // A message the form ARRIVES with mounts together with its live region, which a screen reader
  // does not reliably announce. Until the first submit it also describes the password field, where
  // the parent puts focus (loginFocusTarget), so it is read when focus lands there.
  const [arrived, setArrived] = useState(Boolean(initialError || initialNotice));
  const [pending, startTransition] = useTransition();

  function refuse(message: string) {
    setError(message);
    setShake((n) => n + 1);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setArrived(false);
    const id = identifier.trim();
    const idError = id ? null : IDENTIFIER_REQUIRED;
    const pwError = password ? null : PASSWORD_REQUIRED;
    setIdentifierError(idError);
    setPasswordError(pwError);
    if (idError || pwError) {
      // The field's own error is its description, read when focus lands on it.
      focusControl(idError ? IDENTIFIER_FIELD_ID : PASSWORD_FIELD_ID);
      return;
    }
    const submitted = password;
    startTransition(async () => {
      let res: PasswordSignInActionResult;
      try {
        res = await passwordSignInAction({ identifier: id, password: submitted });
      } catch {
        // The portal itself could not be reached: an honest retry, never a crash.
        refuse(PASSWORD_SIGNIN_UNAVAILABLE);
        return;
      }
      if (res.ok) {
        setPassword("");
        setSucceeded(true);
        onSignedIn();
        return;
      }
      if (res.outcome === "change_required") {
        setPassword("");
        onChangeRequired({ identifier: id, temporaryPassword: submitted });
        return;
      }
      refuse(res.error);
    });
  }

  return (
    <form className={`login-form${shakeClass(shake)}`} onSubmit={onSubmit}>
      <Input
        id={IDENTIFIER_FIELD_ID}
        label="Email, phone or company name"
        name="username"
        iconLeft="user"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={identifier}
        error={identifierError ?? undefined}
        aria-invalid={identifierError ? true : undefined}
        onChange={(ev) => {
          onIdentifierChange(ev.target.value);
          if (identifierError) setIdentifierError(null);
        }}
      />
      <PasswordField
        id={PASSWORD_FIELD_ID}
        label="Password"
        autoComplete="current-password"
        value={password}
        error={passwordError ?? undefined}
        describedBy={arrived ? STATUS_ID : undefined}
        onChange={(value) => {
          setPassword(value);
          if (passwordError) setPasswordError(null);
        }}
      />

      <Button
        type="submit"
        variant={succeeded ? "success" : "primary"}
        block
        loading={pending}
        disabled={succeeded}
        iconLeft={succeeded ? "check-circle" : "sign-in"}
      >
        {succeeded ? "Signed in" : pending ? "Signing in…" : "Sign in"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        iconLeft="envelope"
        disabled={pending || succeeded}
        onClick={() => onUseEmailCode(identifier.trim())}
      >
        Use email code instead
      </Button>

      <p className="login-trust">
        <Icon name="lock-key" />
        Secure sign-in. We’ll never share your details.
      </p>
      <div id={STATUS_ID} aria-live="polite" className="login-status">
        {succeeded ? (
          <Toast tone="success" title="Signed in">
            Welcome back!
          </Toast>
        ) : null}
        {notice ? (
          <Toast tone="neutral" title="Use your temporary password">
            {notice}
          </Toast>
        ) : null}
        {error ? (
          <Toast tone="danger" title="Couldn’t sign in">
            {error}
          </Toast>
        ) : null}
      </div>
    </form>
  );
}
