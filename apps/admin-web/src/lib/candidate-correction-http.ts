import { isAdminForbidden, isAdminRequestError, isAdminUnauthorized } from "./admin-http";

/**
 * A failed correction request, as the drawer's same-origin routes answer it (A7, #2577). Every
 * answer is `{ ok: false, error }` with a sentence an operator can act on — never a stack, never
 * an id, never the API's internal route. A 400's own message is passed through because it explains
 * a refusal (a locked field, an unknown taxonomy id, a reason that mentions a phone) to an admin
 * who is already allowed to make the correction.
 */
export interface CorrectionRouteRefusal {
  status: number;
  error: string;
}

export function describeCorrectionRouteError(err: unknown): CorrectionRouteRefusal {
  if (isAdminUnauthorized(err)) {
    return { status: 401, error: "Your session has ended. Sign in again to make this change." };
  }
  if (isAdminForbidden(err)) {
    return { status: 403, error: "Your role cannot correct candidate fields." };
  }
  if (isAdminRequestError(err)) {
    if (err.status === 400) return { status: 400, error: err.message };
    if (err.status === 404) return { status: 404, error: "That candidate no longer exists." };
    if (err.status === 409) {
      return {
        status: 409,
        error: "There is no live correction on that field to revert.",
      };
    }
    if (err.status === 429) {
      return {
        status: 429,
        error: "Too many changes in this window. Wait a moment and try again.",
      };
    }
  }
  return { status: 502, error: "The change did not reach the server. Try again." };
}
