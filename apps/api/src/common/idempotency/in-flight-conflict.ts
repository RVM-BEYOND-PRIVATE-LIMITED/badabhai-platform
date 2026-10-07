import { ConflictException } from "@nestjs/common";

/**
 * The machine-readable `reason` on the 409 a guarded PURCHASE route answers to a duplicate that
 * lands while the first attempt under the same `Idempotency-Key` is still running (#2111).
 *
 * A wire contract, NOT the Redis sentinel {@link RequestIdempotency} writes while the work runs.
 * They happen to share a spelling; they are deliberately two constants, so a change to how the
 * seam stores its reservation can never rename a reason a client branches on.
 */
export const IN_FLIGHT_REASON = "in_flight" as const;

/**
 * The 409 body (the `error` member on the wire — `AllExceptionsFilter` nests it) for an in-flight
 * duplicate. The same `statusCode` / `error` / `message` keys a string-form `ConflictException`
 * produced before #2111, plus `reason` — additive, so a client matching on the message still works.
 */
export interface InFlightConflictBody {
  readonly statusCode: 409;
  readonly error: "Conflict";
  readonly message: string;
  readonly reason: typeof IN_FLIGHT_REASON;
}

/**
 * The exception a purchase route's `inFlight` throws. `message` is the route's own advice copy,
 * which stays unchanged: it carries NO number or field of the result shape, because the first
 * attempt has not computed one yet (a guessed balance/allowance would render state that never
 * existed). The client's answer to `reason: "in_flight"` is to RE-READ state, never to re-post.
 */
export function inFlightConflict(message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message,
    reason: IN_FLIGHT_REASON,
  } satisfies InFlightConflictBody);
}
