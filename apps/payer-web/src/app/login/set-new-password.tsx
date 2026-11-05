"use client";

import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { Icon } from "@badabhai/icons";
import { Button, Toast } from "../../components/ds";
import { focusControl } from "../../lib/form-focus";
import { setNewPasswordAction, type SetNewPasswordActionResult } from "./actions";
import { NEW_PASSWORD_UNAVAILABLE } from "./messages";
import { PasswordField } from "./password-field";
import {
  CONFIRM_MISMATCH,
  NEW_PASSWORD_ERRORS,
  newPasswordChecks,
  newPasswordChecksSummary,
  newPasswordRefusal,
} from "./password-rules";
import { shakeClass } from "./shake";

/** Stable ids — the parent focuses the heading when the step opens (login-form.tsx). */
export const NEW_PASSWORD_HEADING_ID = "login-new-password-heading";
export const NEW_PASSWORD_FIELD_ID = "login-new-password";
export const CONFIRM_PASSWORD_FIELD_ID = "login-confirm-password";
const RULES_ID = "login-new-password-rules";

export interface SetNewPasswordStepProps {
  /** The login ID the temporary password was accepted for (shown back; resent as is). */
  identifier: string;
  /** The temporary password, held in memory only while this step is open. */
  temporaryPassword: string;
  /** The new password is stored and a session was opened. The parent navigates. */
  onSignedIn: () => void;
  /** The temporary password no longer opens the account (the API's 401): back to sign-in. */
  onRestart: (error: string) => void;
  /** "Back to sign in": the step is abandoned and the parent drops the temporary password. */
  onCancel: () => void;
}

/**
 * "Set a new password" (#2587 / #2628) — shown when the API answers a TEMPORARY password with
 * `password_change_required`. No session exists until this step succeeds: the payer cannot reach
 * the portal holding a temporary password.
 *
 * The rules (8–128 characters, a letter, a number, not the temporary password, both entries the
 * same) tick as the payer types — a mirror for instant feedback (password-rules.ts); the API
 * re-checks every rule, and its 400s land inline on the new-password field. Submit resends the
 * temporary password with `new_password`; only a real session answer signs in.
 *
 * Both passwords live only in memory: this step's state and the parent's pending change, cleared
 * on success, on "Back to sign in", and when the API refuses the temporary password.
 */
export function SetNewPasswordStep({
  identifier,
  temporaryPassword,
  onSignedIn,
  onRestart,
  onCancel,
}: SetNewPasswordStepProps) {
  // useState call order (the node render tests seed by it): newPassword, confirm, newError,
  // confirmError, error, shake, succeeded.
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [succeeded, setSucceeded] = useState(false);
  const [pending, startTransition] = useTransition();

  const checks = newPasswordChecks(newPassword, confirm, temporaryPassword);
  const summary = newPasswordChecksSummary(checks, newPassword.length > 0 || confirm.length > 0);

  function clearPasswords() {
    setNewPassword("");
    setConfirm("");
  }

  function refuse(message: string) {
    setError(message);
    setShake((n) => n + 1);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const refusal = newPasswordRefusal(newPassword, temporaryPassword);
    if (refusal) {
      setNewError(NEW_PASSWORD_ERRORS[refusal]);
      focusControl(NEW_PASSWORD_FIELD_ID);
      return;
    }
    setNewError(null);
    if (confirm !== newPassword) {
      setConfirmError(CONFIRM_MISMATCH);
      focusControl(CONFIRM_PASSWORD_FIELD_ID);
      return;
    }
    setConfirmError(null);
    const chosen = newPassword;
    startTransition(async () => {
      let res: SetNewPasswordActionResult;
      try {
        res = await setNewPasswordAction({ identifier, temporaryPassword, newPassword: chosen });
      } catch {
        refuse(NEW_PASSWORD_UNAVAILABLE);
        return;
      }
      if (res.ok) {
        clearPasswords();
        setSucceeded(true);
        onSignedIn();
        return;
      }
      switch (res.outcome) {
        case "new_password_rejected":
          setNewError(res.error);
          focusControl(NEW_PASSWORD_FIELD_ID);
          return;
        case "temporary_password_rejected":
          clearPasswords();
          onRestart(res.error);
          return;
        default:
          refuse(res.error);
      }
    });
  }

  return (
    <div className="login-step">
      <form
        className={`login-form${shakeClass(shake)}`}
        onSubmit={onSubmit}
        aria-labelledby={NEW_PASSWORD_HEADING_ID}
      >
        <div className="login-step__head">
          <h2 id={NEW_PASSWORD_HEADING_ID} tabIndex={-1} className="login-step__title">
            Set a new password
          </h2>
          <p className="login-step__lead">
            Your temporary password worked. Choose your own password to finish signing in as{" "}
            <strong>{identifier}</strong>.
          </p>
        </div>
        {/* The account this password belongs to, for a password manager saving the new one. */}
        <input type="text" name="username" autoComplete="username" value={identifier} readOnly hidden />

        {succeeded ? null : (
          <>
            <PasswordField
              id={NEW_PASSWORD_FIELD_ID}
              label="New password"
              autoComplete="new-password"
              value={newPassword}
              error={newError ?? undefined}
              describedBy={RULES_ID}
              onChange={(value) => {
                setNewPassword(value);
                if (newError) setNewError(null);
              }}
            />
            <ul id={RULES_ID} className="login-rules" aria-label="Password rules">
              {checks.map((check) => (
                <li key={check.id} className={`login-rule${check.met ? " login-rule--met" : ""}`}>
                  <Icon name={check.met ? "check-circle" : "x-circle"} />
                  <span className="sr-only">{check.met ? "Done:" : "Not yet:"}</span>
                  <span>{check.label}</span>
                </li>
              ))}
            </ul>
            <p className="sr-only" aria-live="polite">
              {summary}
            </p>
            <PasswordField
              id={CONFIRM_PASSWORD_FIELD_ID}
              label="Confirm new password"
              autoComplete="new-password"
              value={confirm}
              error={confirmError ?? undefined}
              onChange={(value) => {
                setConfirm(value);
                if (confirmError) setConfirmError(null);
              }}
            />
          </>
        )}

        <Button
          type="submit"
          variant={succeeded ? "success" : "primary"}
          block
          loading={pending}
          disabled={succeeded}
          iconLeft={succeeded ? "check-circle" : "key"}
        >
          {succeeded ? "Signed in" : pending ? "Setting password…" : "Set password & sign in"}
        </Button>
        {succeeded ? null : (
          <Button
            type="button"
            variant="ghost"
            iconLeft="arrow-left"
            disabled={pending}
            onClick={() => {
              clearPasswords();
              onCancel();
            }}
          >
            Back to sign in
          </Button>
        )}

        <div aria-live="polite" className="login-status">
          {succeeded ? (
            <Toast tone="success" title="Signed in">
              Your new password is set.
            </Toast>
          ) : null}
          {error ? (
            <Toast tone="danger" title="Couldn’t set your password">
              {error}
            </Toast>
          ) : null}
        </div>
      </form>
    </div>
  );
}
