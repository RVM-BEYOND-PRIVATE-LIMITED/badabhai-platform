import { ConflictException, ServiceUnavailableException } from "@nestjs/common";

/**
 * #2749 hardening 2 — the machine-readable `reason` on the 409 the ops credit grant
 * (`POST /payers/:payerId/credits`, InternalServiceGuard) answers for a payer whose company the
 * new money rules apply to (`credit_checkout` on for it). A wire contract an ops tool may branch on.
 */
export const CREDIT_GRANT_ROLLOUT_REASON = "credit_checkout_rollout" as const;

/** The refusal's message: where a credit grant for such a company goes instead. */
export const CREDIT_GRANT_ROLLOUT_MESSAGE =
  "Credit grants for this company go through the goodwill path (#2750), not this route. Nothing was granted";

/**
 * The 409 body (the `error` member on the wire — `AllExceptionsFilter` nests it). The same
 * `statusCode` / `error` / `message` / `reason` keys every purchase-route 409 carries (#2111).
 */
export interface CreditGrantRefusedBody {
  readonly statusCode: 409;
  readonly error: "Conflict";
  readonly message: typeof CREDIT_GRANT_ROLLOUT_MESSAGE;
  readonly reason: typeof CREDIT_GRANT_ROLLOUT_REASON;
}

/** Refuse the ops grant for a company in the new rules. Thrown before any read of the pack. */
export function creditGrantRefused(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message: CREDIT_GRANT_ROLLOUT_MESSAGE,
    reason: CREDIT_GRANT_ROLLOUT_REASON,
  } satisfies CreditGrantRefusedBody);
}

/**
 * The ops grant while the pilot list could not be read: whether the company is in the new rules
 * is unknown, so nothing is granted (fail closed). The caller retries; no SQL text is returned.
 */
export function creditGrantPilotListUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException(
    "The credit_checkout pilot list could not be read, so nothing was granted. Try again",
  );
}
