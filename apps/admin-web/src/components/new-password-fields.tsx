"use client";

import { useId } from "react";
import { PasswordInput } from "./password-input";
import { PASSWORD_POLICY_HINT, passwordPolicyProblem } from "../lib/password-policy";

/** Shown when the confirmation differs. One constant, shared with the server-side copy. */
export const CONFIRM_MISMATCH = "The two passwords don't match.";

/**
 * A new password and its confirmation, with the policy checked AS THE OPERATOR TYPES.
 *
 * Used wherever a password is chosen: the "set a new password" sign-in step, the reset page,
 * the Account page and the create-admin form. Instant feedback only — the server re-checks the
 * same policy on every request and its answer is the one that counts (`lib/password-policy.ts`).
 *
 * A problem is shown once the field has a value, never on an untouched empty field (an error on
 * a field nobody has typed in yet reads as a scolding). The rule itself is always visible as
 * help text, so the requirement is known before the first keystroke.
 */
export function NewPasswordFields({
  value,
  confirm,
  onChange,
  onConfirmChange,
  label = "New password",
  confirmLabel = "Confirm new password",
  autoFocus,
  disabled,
  required,
  autoComplete = "new-password",
  idPrefix,
  onBlur,
  onConfirmBlur,
}: {
  value: string;
  confirm: string;
  onChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
  label?: string;
  confirmLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Draw the console's required marker after each label (the create-admin form does). */
  required?: boolean;
  /** `off` when the password being chosen is someone else's (a temporary one for a new admin). */
  autoComplete?: "new-password" | "off";
  /** A stable id prefix, so a form can focus the first invalid field. */
  idPrefix?: string;
  onBlur?: () => void;
  onConfirmBlur?: () => void;
}) {
  const generated = useId();
  const base = idPrefix ?? generated;
  const newId = `${base}-new`;
  const confirmId = `${base}-confirm`;
  const hintId = `${base}-hint`;
  const problemId = `${base}-problem`;
  const mismatchId = `${base}-mismatch`;

  const problem = value === "" ? null : passwordPolicyProblem(value);
  const mismatch = confirm !== "" && confirm !== value;
  const marker = required ? <span className="req">*</span> : null;

  return (
    <>
      <PasswordInput
        id={newId}
        label={label}
        labelSuffix={marker}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
        onBlur={onBlur}
        invalid={problem !== null}
        describedBy={problem ? `${hintId} ${problemId}` : hintId}
      />
      <p className="field__help" id={hintId}>
        {PASSWORD_POLICY_HINT}
      </p>
      {problem ? (
        <p className="field__error" id={problemId}>
          {problem}
        </p>
      ) : null}
      <PasswordInput
        id={confirmId}
        label={confirmLabel}
        labelSuffix={marker}
        value={confirm}
        onChange={onConfirmChange}
        autoComplete={autoComplete}
        disabled={disabled}
        onBlur={onConfirmBlur}
        invalid={mismatch}
        describedBy={mismatch ? mismatchId : undefined}
      />
      {mismatch ? (
        <p className="field__error" id={mismatchId}>
          {CONFIRM_MISMATCH}
        </p>
      ) : null}
    </>
  );
}
