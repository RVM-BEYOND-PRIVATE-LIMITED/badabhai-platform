import { z } from "zod";
import type { PiiCryptoService } from "./pii-crypto.service";

/**
 * The ONE password policy + credential helpers shared by every principal that signs in with a
 * password (payer #2497, admin 0142). Extracted so the two doors cannot drift: a policy tweak,
 * a pepper bump or a timing fix lands in both or in neither.
 *
 * The SERVER is the policy authority (clients mirror it): 8–128 characters with at least one
 * letter and one digit. The messages are the user-facing 400 text, unchanged from #2497.
 */
export const PasswordPolicySchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "Password must include at least one letter and one digit");

/**
 * A presented (not a new) password: bounded so it is never an unbounded KDF input, but NOT
 * policy-checked — every well-formed attempt burns one KDF verify, so a short or weak guess
 * cannot be told apart from a wrong one (no policy oracle on the sign-in door).
 */
export const PresentedPasswordSchema = z.string().min(1).max(128);

/**
 * The pepper version that produced a row's `password_hash` (#2497). Today only v1 exists (the
 * `password-v1` scrypt token); an unexpected version fails closed at verify time, and a future
 * v2 rehashes on successful verify (mirrors the worker-PIN `CURRENT_PIN_PEPPER_VERSION`).
 */
export const CURRENT_PASSWORD_PEPPER_VERSION = 1;

/**
 * A well-formed but never-matching scrypt token (#2497). `verifyPassword` against this still
 * runs the FULL KDF (format checks pass, bytes differ), so a miss path burns the same scrypt time
 * as a real mismatch — miss/hit timing cannot distinguish "no account" from "wrong password".
 * Deterministic (no per-call hash cost); the zero bytes carry no secret.
 */
export const DUMMY_PASSWORD_HASH = `password-v1.${Buffer.alloc(16).toString("base64")}.${Buffer.alloc(32).toString("base64")}`;

/** The stored half of a password credential, as any principal's row carries it. */
export interface StoredPasswordCredential {
  passwordHash: string | null;
  passwordPepperVersion: number | null;
}

/**
 * True only when `password` matches a CURRENT-pepper stored hash. A missing hash (no password
 * set yet) or an unknown pepper version fails CLOSED — and still burns ONE full KDF against
 * {@link DUMMY_PASSWORD_HASH}, so "this account has no password" costs exactly what "wrong
 * password" costs and cannot be timed apart.
 */
export function matchesStoredPassword(
  pii: Pick<PiiCryptoService, "verifyPassword">,
  password: string,
  stored: StoredPasswordCredential,
): boolean {
  const hash = stored.passwordHash;
  if (hash === null || stored.passwordPepperVersion !== CURRENT_PASSWORD_PEPPER_VERSION) {
    burnPasswordKdf(pii, password);
    return false;
  }
  return pii.verifyPassword(password, hash);
}

/** Burn one full KDF for a path that has no account to check (unknown identifier, lockout). */
export function burnPasswordKdf(
  pii: Pick<PiiCryptoService, "verifyPassword">,
  password: string,
): void {
  pii.verifyPassword(password, DUMMY_PASSWORD_HASH);
}
