import { BadRequestException, ForbiddenException } from "@nestjs/common";

/**
 * #2541 (CEO pack v1 A4 #9) — the sign-up age gate's two refusals on `POST /consent/accept`.
 *
 * Typed constants, never magic strings, so the service that throws them, its tests and the worker
 * app all key on ONE definition. The global `AllExceptionsFilter` nests `{ code, message }` under
 * `error`, so the wire shape is `{ statusCode, error: { code, message }, requestId, path, timestamp }`.
 * Messages are PII-free human copy; the `code` is the machine signal.
 */

/** The worker answered "under 18". HTTP 403. No consent row was written; sessions were revoked. */
export const AGE_BELOW_MINIMUM_CODE = "AGE_BELOW_MINIMUM" as const;

/** The gate is armed and the request carried no answer. HTTP 400. Nothing was written. */
export const AGE_CONFIRMATION_REQUIRED_CODE = "AGE_CONFIRMATION_REQUIRED" as const;

/** The minimum age the platform onboards (owner ruling: 18+, no parental-consent path built). */
export const MINIMUM_SIGNUP_AGE = 18 as const;

export class AgeBelowMinimumException extends ForbiddenException {
  constructor() {
    super({
      code: AGE_BELOW_MINIMUM_CODE,
      message: `BadaBhai is for workers aged ${MINIMUM_SIGNUP_AGE} or older.`,
    });
  }
}

export class AgeConfirmationRequiredException extends BadRequestException {
  constructor() {
    super({
      code: AGE_CONFIRMATION_REQUIRED_CODE,
      message: `age_18_plus is required: confirm the worker is ${MINIMUM_SIGNUP_AGE} or older.`,
    });
  }
}
