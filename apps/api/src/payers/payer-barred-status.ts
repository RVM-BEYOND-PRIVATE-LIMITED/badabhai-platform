import type { PayerStatus } from "@badabhai/db";

/**
 * #2564 — the payer statuses that may never be issued a session or a login code, never be
 * granted credits or a credential, and never act on the platform: an admin SUSPENSION (ADR-0037)
 * and a company ARCHIVE. One definition so every gate that used to compare with
 * `=== "suspended"` cannot silently let an archived account through.
 *
 * `PayerAuthGuard` needs no change — it already admits `active` ONLY — but the sign-in doors and
 * the admin money/credential paths each check the row before the guard ever runs.
 */
export const BARRED_PAYER_STATUSES = [
  "suspended",
  "archived",
] as const satisfies readonly PayerStatus[];
export type BarredPayerStatus = (typeof BARRED_PAYER_STATUSES)[number];

export function isBarredPayerStatus(
  status: PayerStatus | null | undefined,
): status is BarredPayerStatus {
  return status === "suspended" || status === "archived";
}

/**
 * The 403 message a barred account is told at sign-in. Deliberately specific (TD110: a payer
 * must be able to learn WHY a verified login was refused), and only ever shown AFTER the code or
 * password was proven, so it is no oracle for an unauthenticated caller.
 */
export function barredPayerMessage(status: BarredPayerStatus): string {
  return status === "archived" ? "Account is archived" : "Account is suspended";
}
