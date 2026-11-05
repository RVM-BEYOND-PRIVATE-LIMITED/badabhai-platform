import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PayerHttpError } from "./payer-errors";

/**
 * #2645 — the company pages read the 16-trade catalogue through `readPostingTrades`: the trades, or
 * the REAL cause there are none. A failure used to be swallowed into `[]`, which quietly brought
 * back the free role list and the flat skill picker.
 */

const listPostingTrades = vi.fn();
vi.mock("./payer-api", () => ({ listPostingTrades: () => listPostingTrades() }));
// The transport's session-expiry error is private to it; its predicate is all this module reads.
class SessionEnded extends Error {}
vi.mock("./payer-http", () => ({
  isPayerUnauthorized: (e: unknown) => e instanceof SessionEnded,
}));

const { readPostingTrades, postingTradesProblemOf } = await import("./posting-trades.server");

const TRADE = {
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  pack_id: "qp_cnc_turning",
  match_skill_id: "mskill_cnc_turner",
  ladder: [],
  questions: [],
};

beforeEach(() => listPostingTrades.mockReset());

describe("readPostingTrades", () => {
  it("the 16 trades, with no problem", async () => {
    listPostingTrades.mockResolvedValueOnce([TRADE]);
    await expect(readPostingTrades()).resolves.toEqual({ trades: [TRADE], problem: null });
  });

  it("an answer with no trade is a problem of its own (said, not hidden)", async () => {
    listPostingTrades.mockResolvedValueOnce([]);
    await expect(readPostingTrades()).resolves.toEqual({
      trades: [],
      problem: { kind: "empty" },
    });
  });

  it("a failed read is no trades plus its cause — never a throw that blanks the page", async () => {
    listPostingTrades.mockRejectedValueOnce(new PayerHttpError("/payer/posting-trades", 502));
    await expect(readPostingTrades()).resolves.toEqual({
      trades: [],
      problem: { kind: "http", status: 502 },
    });
  });
});

describe("postingTradesProblemOf — the cause, from the transport's typed errors", () => {
  it("429 is rate limited; any other status is carried as itself", () => {
    expect(postingTradesProblemOf(new PayerHttpError("/p", 429))).toEqual({ kind: "rate-limited" });
    expect(postingTradesProblemOf(new PayerHttpError("/p", 503))).toEqual({
      kind: "http",
      status: 503,
    });
    expect(postingTradesProblemOf(new PayerHttpError("/p", 403))).toEqual({
      kind: "http",
      status: 403,
    });
  });

  it("an ended session, an unreadable answer and an unreachable API are told apart", () => {
    expect(postingTradesProblemOf(new SessionEnded("x"))).toEqual({ kind: "session" });
    const zod = z.object({ trades: z.array(z.string()) }).safeParse({ trades: 1 });
    expect(postingTradesProblemOf(zod.error)).toEqual({ kind: "unreadable" });
    expect(postingTradesProblemOf(new SyntaxError("Unexpected token"))).toEqual({
      kind: "unreadable",
    });
    expect(postingTradesProblemOf(new TypeError("fetch failed"))).toEqual({ kind: "unreachable" });
  });
});
