import "server-only";
import {
  isAdminForbidden,
  isAdminRequestError,
  isAdminUnauthorized,
} from "./admin-http";

/**
 * Turn a thrown error from a governed admin mutation into operator-facing copy.
 *
 * A 4xx here is the SERVER explaining why the action was refused — not found, a business
 * conflict such as "Cannot demote the last active super_admin" or "An admin cannot suspend
 * themselves" — and that explanation is exactly what the operator needs, so (thanks to
 * `admin-http.ts`'s `describeErrorBody`) it is shown verbatim. This is deliberately narrower
 * than a blanket "show whatever the server said": a transport failure or a 5xx is not the
 * operator's fault and its text is not guaranteed operator-safe, so those collapse to one
 * neutral message instead — the same asymmetry `login/actions.ts`'s `failureMessage` uses.
 */
export function describeAdminActionError(err: unknown): string {
  if (isAdminUnauthorized(err)) {
    return "Your session has ended. Reload the page and sign in again.";
  }
  if (isAdminForbidden(err)) {
    return "Your role no longer has permission to do that.";
  }
  if (isAdminRequestError(err) && err.status >= 400 && err.status < 500) {
    return err.message;
  }
  return "The admin API is unreachable or returned an error. Try again.";
}
