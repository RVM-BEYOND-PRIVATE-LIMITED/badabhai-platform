"use client";

import { useState } from "react";
import { IconButton, Input } from "../../components/ds";

/**
 * A password field for the sign-in forms (#2587): the DS Input, with a show/hide eye BESIDE it —
 * the shared icon-only control (IconButton: its label is the accessible name and the visible
 * tooltip), the same arrangement as admin-web's PasswordInput. The DS Input is not changed; the
 * row is laid out by `.login-secret` (globals.css).
 *
 * The eye names the ACTION, like the payer app's: "Show password" (an open eye) while the text is
 * masked, "Hide password" (a slashed eye) while it is shown. The glyph morphs only in answer to a
 * toggle (never on arrival), and a polite status says what changed.
 *
 * THE PASSWORD STAYS IN MEMORY: the value is the caller's React state, sent only by its submit
 * handler. The input has NO `name`, so a native submit (before hydration) can never serialize it
 * into a URL or a request; autocomplete tells a password manager which password this is.
 */
export interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** `current-password` to sign in; `new-password` where one is chosen (a manager can offer one). */
  autoComplete: "current-password" | "new-password";
  error?: string;
  hint?: string;
  /** Ids of more text that describes the field (the rules checklist), read with it. */
  describedBy?: string;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
  describedBy,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  // Set by the first toggle: the morph and the announcement answer the payer, never the page load.
  const [toggled, setToggled] = useState(false);

  return (
    <div className="login-secret">
      <Input
        id={id}
        label={label}
        type={visible ? "text" : "password"}
        iconLeft="lock-key"
        autoComplete={autoComplete}
        // A password is never auto-corrected or auto-capitalised, shown or not.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        error={error}
        hint={hint}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(ev) => onChange(ev.target.value)}
      />
      <IconButton
        className="login-secret__toggle"
        variant="outline"
        size="lg"
        icon={visible ? "eye-slash" : "eye"}
        label={visible ? "Hide password" : "Show password"}
        tooltipPlacement="top-end"
        aria-controls={id}
        data-morph={toggled ? (visible ? "hide" : "show") : undefined}
        onClick={() => {
          setVisible((v) => !v);
          setToggled(true);
        }}
      />
      <span className="sr-only" aria-live="polite">
        {toggled ? (visible ? "Your password is shown." : "Your password is hidden.") : ""}
      </span>
    </div>
  );
}
