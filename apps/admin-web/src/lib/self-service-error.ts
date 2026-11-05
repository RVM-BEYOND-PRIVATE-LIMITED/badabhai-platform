import "server-only";
import { isAdminUnauthorized } from "./admin-http";
import { currentSession } from "./auth/session";
import { describeAdminActionError } from "./describe-admin-error";

/**
 * Operator-facing copy for a refused SELF-SERVICE call on the Account page — changing your own
 * password, turning your own two-step verification on or off (ADR-0060 A2/A5).
 *
 * ── THE ONE AMBIGUITY THESE ROUTES HAVE ─────────────────────────────────────────────────────
 * `POST /admin/me/password`, `/admin/me/mfa/confirm` and `/admin/me/mfa/disable` answer a WRONG
 * CREDENTIAL (current password, authenticator code) with 401 — the same status the guard uses for
 * a dead session, which `adminFetch` turns into `AdminUnauthorizedError` before any body is read.
 * Telling an operator who mistyped one digit "your session has ended" would send them to sign in
 * again for nothing; telling one whose session really ended "wrong code" would loop them.
 *
 * So a 401 is resolved by ASKING the server whether the session is still alive (`GET /admin/me`),
 * never by reading the error text: alive ⇒ the credential was refused (`refusal`); dead ⇒ the
 * session ended. One extra request, and only on the failure path. Any other failure keeps the
 * console-wide wording of {@link describeAdminActionError} (a 4xx shows the server's own reason).
 */
export async function describeSelfServiceError(err: unknown, refusal: string): Promise<string> {
  if (!isAdminUnauthorized(err)) return describeAdminActionError(err);
  try {
    return (await currentSession()) ? refusal : describeAdminActionError(err);
  } catch (probeErr) {
    // The API went away between the two calls: say that, not either guess.
    return describeAdminActionError(probeErr);
  }
}
