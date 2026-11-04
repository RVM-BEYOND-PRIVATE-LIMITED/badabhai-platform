import "server-only";
import { ZodError } from "zod";
import type { PostingTradeFormWire } from "./contracts";
import { listPostingTrades } from "./payer-api";
import { httpStatusOf } from "./payer-errors";
import { isPayerUnauthorized } from "./payer-http";
import type { PostingTradesProblem } from "./posting-trades";

/**
 * #2645 — the 16-trade catalogue (`GET /payer/posting-trades`) as the company posting pages read
 * it: the trades, or WHY there are none.
 *
 * A failure is no longer swallowed into an empty list that quietly brought back the free role
 * list and the flat skill picker. A company job must name one of the 16 to go live (#2635), so
 * the picker says the real cause and offers Retry, and the form refuses to post without a trade.
 */
export interface PostingTradesRead {
  trades: PostingTradeFormWire[];
  /** Why `trades` is empty; null when the 16 are there. */
  problem: PostingTradesProblem | null;
}

export async function readPostingTrades(): Promise<PostingTradesRead> {
  try {
    const trades = await listPostingTrades();
    return trades.length > 0
      ? { trades, problem: null }
      : { trades: [], problem: { kind: "empty" } };
  } catch (e) {
    return { trades: [], problem: postingTradesProblemOf(e) };
  }
}

/** The cause of a failed catalogue read, from the transport's typed errors (never a message). */
export function postingTradesProblemOf(e: unknown): PostingTradesProblem {
  const status = httpStatusOf(e);
  if (status === 429) return { kind: "rate-limited" };
  if (status !== null) return { kind: "http", status };
  if (isPayerUnauthorized(e)) return { kind: "session" };
  if (e instanceof ZodError || e instanceof SyntaxError) return { kind: "unreadable" };
  return { kind: "unreachable" };
}
