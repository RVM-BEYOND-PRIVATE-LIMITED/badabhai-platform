import { describe, it, expect } from "vitest";
import { ConflictException } from "@nestjs/common";
import { renderedBody } from "../common/idempotency/replay-fidelity.test-support";
import { inFlightConflict } from "../common/idempotency/in-flight-conflict";
import { assertExpectedPrice } from "../pricing/charge-price";
import { noActivePlanToTopUp } from "../posting-plans/no-active-plan-conflict";

/**
 * The WIRE shape of the payer purchase routes' 409s (#2111), rendered through the REAL global
 * {@link AllExceptionsFilter} — the shape `docs/api/payer-agency-api-reference.md` documents.
 *
 * Two properties are pinned:
 *  1. the thrown body is NESTED under `error` (`{ statusCode, error: { reason, … }, requestId,
 *     path, timestamp }`), never flat — the API reference used to show `price_mismatch` flat;
 *  2. `in_flight` / `no_active_plan` are ADDITIVE: the `error` object is exactly what the
 *     string-form `ConflictException` produced before #2111, plus `reason`. Same message, so a
 *     client that still matches the message text (payer-web today) keeps working.
 */

const PATH = "/payer/job-postings/cccccccc-0000-4000-8000-000000000003/quota-topup";
const ENVELOPE = {
  statusCode: 409,
  requestId: "req-test",
  path: PATH,
  timestamp: expect.any(String),
};

const QUOTA_IN_FLIGHT =
  "This quota top-up is already being processed; check the posting before trying again";

/** What the 409 looked like before #2111: a string-form ConflictException. */
const legacy = (message: string) => renderedBody(new ConflictException(message), PATH);

describe("#2111 — purchase 409s carry a machine-readable reason, nested under `error`", () => {
  it("in_flight: the legacy error object plus `reason`, message unchanged", () => {
    const body = renderedBody(inFlightConflict(QUOTA_IN_FLIGHT), PATH);
    expect(body).toStrictEqual({
      ...ENVELOPE,
      error: { statusCode: 409, error: "Conflict", message: QUOTA_IN_FLIGHT, reason: "in_flight" },
    });
    expect(body.error).toStrictEqual({
      ...(legacy(QUOTA_IN_FLIGHT).error as object),
      reason: "in_flight",
    });
  });

  it("no_active_plan: the legacy error object plus `reason`, message unchanged", () => {
    const message = "no active plan to top up for this posting";
    const body = renderedBody(noActivePlanToTopUp(), PATH);
    expect(body).toStrictEqual({
      ...ENVELOPE,
      error: { statusCode: 409, error: "Conflict", message, reason: "no_active_plan" },
    });
    expect(body.error).toStrictEqual({
      ...(legacy(message).error as object),
      reason: "no_active_plan",
    });
  });

  it("price_mismatch: the documented body is nested under `error`, not flat", () => {
    let thrown: unknown;
    try {
      assertExpectedPrice(1000, 750);
    } catch (err) {
      thrown = err;
    }
    const body = renderedBody(thrown, PATH);
    expect(body).toStrictEqual({
      ...ENVELOPE,
      error: {
        statusCode: 409,
        error: "Conflict",
        reason: "price_mismatch",
        message:
          "The price changed: you confirmed ₹1000 but the current price is ₹750. " +
          "Nothing was charged; re-read the price and confirm again",
        expected_price_inr: 1000,
        current_price_inr: 750,
      },
    });
    // The top level is the envelope only — no flat `reason` beside `statusCode`.
    expect(body).not.toHaveProperty("reason");
  });

  it("the exception's own message is the advice copy, so logs and `.message` readers are unchanged", () => {
    expect(inFlightConflict(QUOTA_IN_FLIGHT).message).toBe(QUOTA_IN_FLIGHT);
    expect(noActivePlanToTopUp().message).toBe("no active plan to top up for this posting");
  });
});
