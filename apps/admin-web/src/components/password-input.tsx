"use client";

import { useState } from "react";
import { IconButton } from "./icon-button";

/**
 * A labelled password field with a show/hide toggle — the one password input in the console
 * (sign-in, set a new password, reset, Account, create admin).
 *
 * The toggle is a TOGGLE BUTTON: one constant name ("Show password") and `aria-pressed` for its
 * state, so assistive tech hears "Show password, toggle button, pressed" rather than a label
 * that changes under the reader. It is `type="button"` so it never submits the form, and it is
 * a sibling of the input, not inside a `<label>` (a label wrapping two controls names the wrong
 * one).
 *
 * `autoComplete` is required, because it is what makes a password manager offer the saved
 * password (`current-password`) or generate a strong one (`new-password`) in the right place.
 */
export function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete,
  name,
  required = true,
  autoFocus,
  invalid,
  describedBy,
  disabled,
  labelSuffix,
  onBlur,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * `off` only where the password is NOT the signed-in user's own (the create-admin form's
   * temporary password): offering to save it would file someone else's password under yours.
   */
  autoComplete: "current-password" | "new-password" | "off";
  name?: string;
  required?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  /** Space-separated ids of the help and error text that describe this field. */
  describedBy?: string;
  disabled?: boolean;
  /** Rendered after the label text (e.g. the required marker). */
  labelSuffix?: React.ReactNode;
  /** The admin form's inline-validation timing (blur starts reporting). */
  onBlur?: () => void;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {labelSuffix}
      </label>
      <div className="password-input">
        <input
          id={id}
          className="field__input"
          // Shown as text only while the operator has asked to see it.
          type={visible ? "text" : "password"}
          name={name}
          autoComplete={autoComplete}
          // A password is never auto-corrected or auto-capitalised, shown or not.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required={required}
          autoFocus={autoFocus}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
        />
        <IconButton
          icon="eye"
          label="Show password"
          variant="outline"
          tooltipPlacement="top-end"
          aria-pressed={visible}
          aria-controls={id}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        />
      </div>
    </div>
  );
}
