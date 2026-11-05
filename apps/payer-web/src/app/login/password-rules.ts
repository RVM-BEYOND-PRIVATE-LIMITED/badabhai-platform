import type { NewPasswordRefusal } from "../../lib/auth/types";

/**
 * The NEW-password rules for the "Set a new password" step (#2587), mirrored for instant feedback.
 *
 * The SERVER is the authority (#2628: the shared `PasswordPolicySchema` — 8–128 characters with at
 * least one ASCII letter and one digit — plus "must differ from the temporary password"), and it
 * re-checks every value this file accepts. This copy exists so the payer sees each rule tick as
 * they type, never so the client decides what is allowed. Same policy as the payer app
 * (`passwordPolicyProblem`) and admin-web (`lib/password-policy.ts`).
 *
 * Client-safe and pure: the form, the server action and the tests all import it. Nothing here
 * logs, stores or returns a password — only whether a rule is met, and fixed copy.
 */

export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_CHARS = 128;

/** The server's pattern: an ASCII letter and a digit anywhere (a line break defeats its `.+`). */
const LETTER_AND_DIGIT = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const LETTER = /[A-Za-z]/;
const DIGIT = /\d/;

/** Inline copy for a refused new password — about the typed value, never about the account. */
export const NEW_PASSWORD_ERRORS: Readonly<Record<NewPasswordRefusal, string>> = {
  too_short: `Use at least ${PASSWORD_MIN_CHARS} characters.`,
  too_long: `Use at most ${PASSWORD_MAX_CHARS} characters.`,
  letter_and_digit: "Add at least one letter and one number.",
  same_as_temporary: "Choose a password that is different from your temporary one.",
  other: "That password can’t be used. Choose another one.",
};

/** The confirmation differs from the new password. */
export const CONFIRM_MISMATCH = "The two passwords don’t match.";

export type NewPasswordCheckId = "length" | "letter" | "digit" | "differs" | "matches";

export interface NewPasswordCheck {
  id: NewPasswordCheckId;
  /** What the rule asks for, as the checklist reads it. */
  label: string;
  met: boolean;
}

/**
 * Every rule, in checklist order, with whether the typed values meet it. Recomputed on every
 * keystroke; an empty field meets nothing (no rule reads as passed before anything is typed).
 */
export function newPasswordChecks(
  value: string,
  confirm: string,
  temporary: string,
): NewPasswordCheck[] {
  return [
    {
      id: "length",
      label: `${PASSWORD_MIN_CHARS} to ${PASSWORD_MAX_CHARS} characters`,
      met: value.length >= PASSWORD_MIN_CHARS && value.length <= PASSWORD_MAX_CHARS,
    },
    { id: "letter", label: "At least one letter", met: LETTER.test(value) },
    { id: "digit", label: "At least one number", met: DIGIT.test(value) },
    {
      id: "differs",
      label: "Different from your temporary password",
      met: value.length > 0 && value !== temporary,
    },
    { id: "matches", label: "Both passwords match", met: confirm.length > 0 && confirm === value },
  ];
}

/**
 * The FIRST rule a candidate new password breaks (the server's order: length, then letter + digit,
 * then the temporary-password check), or null when it would be accepted. The confirmation is the
 * caller's separate check ({@link CONFIRM_MISMATCH}).
 */
export function newPasswordRefusal(value: string, temporary: string): NewPasswordRefusal | null {
  if (value.length < PASSWORD_MIN_CHARS) return "too_short";
  if (value.length > PASSWORD_MAX_CHARS) return "too_long";
  if (!LETTER_AND_DIGIT.test(value)) return "letter_and_digit";
  if (value === temporary) return "same_as_temporary";
  return null;
}

/**
 * The polite live summary of the checklist, or "" before anything is typed (nothing is announced
 * on arrival). It changes only when the number of met rules changes, so a screen reader hears a
 * short update as rules tick, not every keystroke.
 */
export function newPasswordChecksSummary(checks: readonly NewPasswordCheck[], typed: boolean): string {
  if (!typed) return "";
  const met = checks.filter((c) => c.met).length;
  return met === checks.length
    ? "All password rules met."
    : `${met} of ${checks.length} password rules met.`;
}
