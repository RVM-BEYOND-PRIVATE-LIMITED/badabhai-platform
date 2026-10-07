import { ConflictException } from "@nestjs/common";

/**
 * The machine-readable `reason` on the 409 a quota top-up gets when the posting has no ACTIVE,
 * unexpired plan of the session payer's to add to (#2111). Before #2111 this 409 carried only
 * its message, so a client had to tell it apart from the in-flight duplicate (`in_flight`) by
 * the message text.
 */
export const NO_ACTIVE_PLAN_REASON = "no_active_plan" as const;

/** The unchanged message — payer-web matches it today, so it must not be reworded. */
export const NO_ACTIVE_PLAN_MESSAGE = "no active plan to top up for this posting";

/**
 * The 409 body (the `error` member on the wire — `AllExceptionsFilter` nests it). The same
 * `statusCode` / `error` / `message` keys the string-form `ConflictException` produced, plus
 * `reason` — additive.
 */
export interface NoActivePlanErrorBody {
  readonly statusCode: 409;
  readonly error: "Conflict";
  readonly message: typeof NO_ACTIVE_PLAN_MESSAGE;
  readonly reason: typeof NO_ACTIVE_PLAN_REASON;
}

/**
 * Refuse a quota top-up that has no active plan to add to. Thrown BEFORE any payment event
 * (both call sites), so a refusal charges nothing. Says nothing about WHY there is no plan — a
 * foreign plan is invisible to the payer-scoped lookup, so "none", "expired" and "someone
 * else's" are the same answer (no oracle).
 */
export function noActivePlanToTopUp(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message: NO_ACTIVE_PLAN_MESSAGE,
    reason: NO_ACTIVE_PLAN_REASON,
  } satisfies NoActivePlanErrorBody);
}
