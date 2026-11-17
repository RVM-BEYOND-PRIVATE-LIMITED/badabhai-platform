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
 * #2749 hardening 2 ("before real money") — the `reason` on the 409 the same ops grant answers for
 * EVERY company while real payments are live: once packs cost money, the shared-token route hands
 * out no free pack to anyone, whatever the rollout says.
 */
export const CREDIT_GRANT_REAL_PAYMENTS_REASON = "real_payments_live" as const;

/** That refusal's message. */
export const CREDIT_GRANT_REAL_PAYMENTS_MESSAGE =
  "Real payments are live: credits are bought through checkout, or granted through the goodwill path (#2750), not on this route. Nothing was granted";

/**
 * The 409 body (the `error` member on the wire — `AllExceptionsFilter` nests it). The same
 * `statusCode` / `error` / `message` / `reason` keys every purchase-route 409 carries (#2111).
 */
export type CreditGrantRefusedBody =
  | {
      readonly statusCode: 409;
      readonly error: "Conflict";
      readonly message: typeof CREDIT_GRANT_ROLLOUT_MESSAGE;
      readonly reason: typeof CREDIT_GRANT_ROLLOUT_REASON;
    }
  | {
      readonly statusCode: 409;
      readonly error: "Conflict";
      readonly message: typeof CREDIT_GRANT_REAL_PAYMENTS_MESSAGE;
      readonly reason: typeof CREDIT_GRANT_REAL_PAYMENTS_REASON;
    };

/** Refuse the ops grant for a company in the new rules. Thrown before any read of the pack. */
export function creditGrantRefused(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message: CREDIT_GRANT_ROLLOUT_MESSAGE,
    reason: CREDIT_GRANT_ROLLOUT_REASON,
  } satisfies CreditGrantRefusedBody);
}

/** Refuse the ops grant for every company while real payments are live. Thrown before any read. */
export function creditGrantRefusedRealPaymentsLive(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message: CREDIT_GRANT_REAL_PAYMENTS_MESSAGE,
    reason: CREDIT_GRANT_REAL_PAYMENTS_REASON,
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
