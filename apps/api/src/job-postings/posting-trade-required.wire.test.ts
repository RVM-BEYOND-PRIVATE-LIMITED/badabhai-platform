import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { renderedBody } from "../common/idempotency/replay-fidelity.test-support";
import {
  POSTING_TRADE_REQUIRED_MESSAGE,
  POSTING_TRADE_REQUIRED_REASON,
  postingTradeRequired,
} from "./posting-trade-required";

/**
 * #2635 — the WIRE shape of the "a live job must name one of the 16 trades" 400, rendered
 * through the REAL global `AllExceptionsFilter`. Clients are told to branch on `reason`, so it
 * must survive the filter: nested under `error`, next to the same keys a string-form
 * `BadRequestException` produces.
 */

const PATH = "/payer/job-postings/cccccccc-0000-4000-8000-000000000003";

describe("#2635 — posting_trade_required on the wire", () => {
  it("nests the reason under `error`, beside the legacy keys", () => {
    const body = renderedBody(postingTradeRequired(), PATH);
    expect(body).toStrictEqual({
      statusCode: 400,
      requestId: "req-test",
      path: PATH,
      timestamp: expect.any(String),
      error: {
        statusCode: 400,
        error: "Bad Request",
        message: POSTING_TRADE_REQUIRED_MESSAGE,
        reason: POSTING_TRADE_REQUIRED_REASON,
      },
    });
  });

  it("is the string-form 400 plus `reason` — additive, nothing renamed", () => {
    const legacy = renderedBody(new BadRequestException(POSTING_TRADE_REQUIRED_MESSAGE), PATH);
    const body = renderedBody(postingTradeRequired(), PATH);
    expect(body.error).toStrictEqual({
      ...(legacy.error as object),
      reason: "posting_trade_required",
    });
  });
});
