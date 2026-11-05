import "server-only";
import {
  isAdminForbidden,
  isAdminRequestError,
  isAdminUnauthorized,
} from "./admin-http";
import {
  NOT_ALLOWED,
  SAFE_ACTION_ERROR,
  SESSION_ENDED,
  adminActionErrorCopy,
} from "./admin-action-messages";

/**
 * Turn a thrown error from a governed admin mutation into operator-facing copy.
 *
 * Every branch goes through the copy catalogue (#2689 rule 3): the API's status, code and text
 * are lookup keys only. A known refusal gets a specific sentence; an unknown one gets the safe
 * generic line. No caller may render the raw server text, a status code or an exception string.
 */
export function describeAdminActionError(err: unknown): string {
  if (isAdminUnauthorized(err)) return SESSION_ENDED;
  if (isAdminForbidden(err)) return NOT_ALLOWED;
  if (isAdminRequestError(err)) {
    const code =
      typeof err.body?.code === "string" ? err.body.code : undefined;
    return adminActionErrorCopy({
      status: err.status,
      code,
      message: err.message,
    });
  }
  return SAFE_ACTION_ERROR;
}
