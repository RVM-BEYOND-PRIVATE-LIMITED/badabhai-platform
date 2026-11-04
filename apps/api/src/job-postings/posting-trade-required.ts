import { BadRequestException } from "@nestjs/common";

/**
 * #2635 — the machine-readable `reason` on the 400 a company gets when a write would leave a
 * LIVE posting outside the 16 postable trades: publishing one that names none of them, or
 * changing (or clearing) the trade of a posting that is already open or paused. Matching runs
 * only for those trades (owner ruling 2026-11-04), so such a job would reach nobody. Clients
 * branch on `reason`, never on the message.
 */
export const POSTING_TRADE_REQUIRED_REASON = "posting_trade_required" as const;

/** The message, pinned by the API tests. */
export const POSTING_TRADE_REQUIRED_MESSAGE = "a live job must name one of the 16 trades";

/**
 * The 400 body (the `error` member on the wire — `AllExceptionsFilter` nests it): the same
 * `statusCode` / `error` / `message` keys a string-form `BadRequestException` produces, plus
 * `reason` — additive.
 */
export interface PostingTradeRequiredErrorBody {
  readonly statusCode: 400;
  readonly error: "Bad Request";
  readonly message: typeof POSTING_TRADE_REQUIRED_MESSAGE;
  readonly reason: typeof POSTING_TRADE_REQUIRED_REASON;
}

/** Refuse a company write that would leave a live posting outside the 16. Thrown before any write. */
export function postingTradeRequired(): BadRequestException {
  const body: PostingTradeRequiredErrorBody = {
    statusCode: 400,
    error: "Bad Request",
    message: POSTING_TRADE_REQUIRED_MESSAGE,
    reason: POSTING_TRADE_REQUIRED_REASON,
  };
  return new BadRequestException(body);
}
