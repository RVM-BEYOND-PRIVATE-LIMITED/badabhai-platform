/**
 * #2563 — the ONE spelling of the payer password-attempt Redis key.
 *
 * `PayerAuthService` writes and clears the counter on the sign-in door; the admin accounts
 * list reads the same keys to show `locked`. Two literals would drift the day one side adds a
 * prefix or a namespace, and the symptom would be an operator looking at a permanently
 * unlocked account. The payer id is opaque, so the key carries no PII.
 */
export function payerPasswordAttemptsKey(payerId: string): string {
  return `payer_pw:attempts:${payerId}`;
}
