import "server-only";
import { AdminRequestError } from "../../lib/admin-http";
import { SERVICE_UNAVAILABLE_ERROR } from "./messages";

/**
 * Distinguish "the service is down" from "your input was wrong" — and ONLY those two — on the
 * public (unauthenticated) admin auth flows: sign-in and password reset.
 *
 * A transport failure (status 0) or a 5xx is not the operator's fault, and telling them to
 * re-check their code would send them in circles. Everything else — a 401, a 404, a 429 from the
 * IP cap, a schema mismatch — returns the step's ONE neutral message, so no response the API
 * gives can become an enumeration signal through this portal.
 *
 * Its own module (not a `"use server"` file, which may only export actions) so the sign-in and
 * forgot-password actions share one copy.
 */
export function failureMessage(err: unknown, neutral: string): string {
  if (err instanceof AdminRequestError && (err.status === 0 || err.status >= 500)) {
    return SERVICE_UNAVAILABLE_ERROR;
  }
  return neutral;
}
