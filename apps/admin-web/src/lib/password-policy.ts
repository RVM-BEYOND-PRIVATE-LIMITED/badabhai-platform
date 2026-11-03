import { z } from "zod";

/**
 * The admin password policy, mirrored for INSTANT feedback only (ADR-0060).
 *
 * The server is the authority: `POST /admin/login/password`, `/admin/password/reset`,
 * `/admin/me/password` and `/admin/admins/direct` all re-check the same rule (the payer policy,
 * #2497 — `PayerPasswordSetSchema` in apps/api), and a value this file accepts can still be
 * refused there. This copy exists so an operator learns "needs a digit" while typing instead of
 * after a round trip, never so the client can decide what is allowed.
 *
 * Client-safe: no server-only import, no secrets — the login, reset, account and create-admin
 * forms all import it.
 */

export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_CHARS = 128;

/** Shown when a new password is refused for its shape — about the typed value, never the account. */
export const PASSWORD_POLICY_ERROR = `Choose a password of ${PASSWORD_MIN_CHARS}–${PASSWORD_MAX_CHARS} characters with at least one letter and one digit.`;

/** The one sentence every form shows under a new-password field. */
export const PASSWORD_POLICY_HINT = `${PASSWORD_MIN_CHARS}–${PASSWORD_MAX_CHARS} characters, with at least one letter and one digit.`;

/** The same pattern as the server's: at least one ASCII letter and one digit, anywhere. */
const LETTER_AND_DIGIT = /^(?=.*[A-Za-z])(?=.*\d).+$/;

/** A NEW password (set, change, reset, temporary). Never trimmed: spaces are characters. */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_CHARS)
  .max(PASSWORD_MAX_CHARS)
  .regex(LETTER_AND_DIGIT);

/**
 * A password being PRESENTED (sign-in, current password). Bounded but not policy-checked: an
 * account created before a policy change must still be able to sign in, and the server burns
 * the same KDF work for every well-formed attempt.
 */
export const presentedPasswordSchema = z.string().min(1).max(PASSWORD_MAX_CHARS);

/** What is wrong with a candidate new password, in plain words, or null when it passes. */
export function passwordPolicyProblem(value: string): string | null {
  if (value.length < PASSWORD_MIN_CHARS) return `Use at least ${PASSWORD_MIN_CHARS} characters.`;
  if (value.length > PASSWORD_MAX_CHARS) return `Use at most ${PASSWORD_MAX_CHARS} characters.`;
  if (!/[A-Za-z]/.test(value)) return "Add at least one letter.";
  if (!/\d/.test(value)) return "Add at least one digit.";
  // The server's pattern is `.+` after the lookaheads, which a line break defeats.
  if (!LETTER_AND_DIGIT.test(value)) return "Remove the line break.";
  return null;
}

/** True when the pair is ready to submit: the new value passes and the confirmation matches. */
export function newPasswordPairReady(value: string, confirm: string): boolean {
  return passwordPolicyProblem(value) === null && value === confirm;
}

/**
 * A temporary password that satisfies the policy, for the create-admin form's "Generate".
 *
 * 16 characters from an alphabet with the look-alikes removed (no 0/O, 1/l/I), so it survives
 * being read out over a call. Uses the Web Crypto CSPRNG (browser and Node both expose it) with
 * rejection sampling, so no character is more likely than another. At least one letter and one
 * digit are guaranteed by construction rather than by retrying.
 */
const LETTERS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const ALPHABET = LETTERS + DIGITS;

function randomIndex(size: number): number {
  // Largest multiple of `size` below 256: bytes at or above it are rejected (no modulo bias).
  const limit = 256 - (256 % size);
  const buf = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const byte = buf[0]!;
    if (byte < limit) return byte % size;
  }
}

export function generateTemporaryPassword(length = 16): string {
  const chars = [LETTERS[randomIndex(LETTERS.length)]!, DIGITS[randomIndex(DIGITS.length)]!];
  while (chars.length < length) chars.push(ALPHABET[randomIndex(ALPHABET.length)]!);
  // Fisher–Yates, so the guaranteed letter and digit are not always the first two characters.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}
