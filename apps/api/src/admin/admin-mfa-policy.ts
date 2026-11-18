import type { AdminRole } from "@badabhai/db";

/**
 * WHICH ROLES MUST USE TWO-STEP SIGN-IN. Owner ruling #2924, option B (2026-11-18), recorded as
 * ADR-0060 Amendment 2.
 *
 * ADR-0060 Amendment 1 (2026-11-03) made two-step OPTIONAL for every admin, switched from the
 * Account page and starting off. That left the roles that can do the most damage on one factor:
 * super_admin and ops_admin can create admins and change companies, credits and postings, and
 * export events. For them two-step is now REQUIRED:
 *   - the sign-in gate treats them as two-step ON whatever their own switch says. One whose
 *     switch is still off gets the enrolment step (a FRESH seed, a QR code and one valid code)
 *     before any session, and that first code switches two-step on for good;
 *   - the Account page cannot switch it off for them (`POST /admin/me/mfa/disable` → 403).
 * support and analyst keep the per-admin switch of Amendment 1.
 *
 * A seed already on file is NOT trusted for a required role whose switch is off. That seed may
 * never have been scanned (the bootstrap's `--with-totp` used to store one without switching
 * two-step on), and asking for a code from it is the 3 Nov lockout. Enrolment again costs one
 * scan; a lockout costs a break-glass reset.
 *
 * `ADMIN_MFA_REQUIRED=false` (config) still switches two-step off for EVERY admin, these roles
 * included. It exists for local development and tests; production leaves it unset (true).
 */
export const ADMIN_MFA_REQUIRED_ROLES: readonly AdminRole[] = ["super_admin", "ops_admin"];

/** True when two-step sign-in is required for this role (deny-safe: an unknown role is not). */
export function mfaRequiredForRole(role: AdminRole | null | undefined): boolean {
  return role != null && ADMIN_MFA_REQUIRED_ROLES.includes(role);
}
