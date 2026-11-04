import { describe, expect, it } from "vitest";
import type { PostingTradeFormWire } from "./contracts";
import {
  POSTING_TRADE_REQUIRED_MESSAGE,
  TRADE_REQUIRED_PARAM,
  isPostingTrade,
  isTradeRequiredParam,
  postingTradesProblemMessage,
  withTradeRequired,
} from "./posting-trades";

/**
 * #2645 — what the three company trade pickers share: the refusal's copy, the real cause when the
 * 16 trades are not on screen, and the edit page's "refused at the trade picker" link flag.
 */

const TRADE: PostingTradeFormWire = {
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  pack_id: "qp_cnc_turning",
  match_skill_id: "mskill_cnc_turner",
  ladder: [],
  questions: [],
};

describe("the refusal's copy", () => {
  it("is the app's own words — the payer app's kPostingTradeRequiredMessage, not the API's", () => {
    expect(POSTING_TRADE_REQUIRED_MESSAGE).toBe("Pick one of the 16 trades");
    expect(POSTING_TRADE_REQUIRED_MESSAGE).not.toContain("a live job must name");
  });
});

describe("isPostingTrade — only what the catalogue listed", () => {
  it("a listed trade is one; anything else, blank or absent is not", () => {
    expect(isPostingTrade([TRADE], "cnc_turner")).toBe(true);
    expect(isPostingTrade([TRADE], "welder")).toBe(false);
    expect(isPostingTrade([TRADE], "")).toBe(false);
    expect(isPostingTrade([TRADE], null)).toBe(false);
    expect(isPostingTrade([TRADE], undefined)).toBe(false);
    // No catalogue, no trade — never a guess from a local list.
    expect(isPostingTrade([], "cnc_turner")).toBe(false);
  });
});

describe("postingTradesProblemMessage — the REAL cause, never a generic line", () => {
  it.each([
    [{ kind: "empty" } as const, "No trades are open for posting right now. Try again in a moment."],
    [null, "No trades are open for posting right now. Try again in a moment."],
    [
      { kind: "rate-limited" } as const,
      "The 16 trades did not load: too many requests just now. Wait a minute, then retry.",
    ],
    [{ kind: "session" } as const, "The 16 trades did not load: your session has ended. Sign in again."],
    [
      { kind: "http", status: 503 } as const,
      "The 16 trades did not load: the BadaBhai server had a problem (error 503).",
    ],
    [
      { kind: "http", status: 404 } as const,
      "The 16 trades did not load: the server refused the request (error 404).",
    ],
    [
      { kind: "unreadable" } as const,
      "The 16 trades did not load: the server's answer could not be read.",
    ],
    [
      { kind: "unreachable" } as const,
      "The 16 trades did not load: the BadaBhai server could not be reached.",
    ],
  ])("%o", (problem, message) => {
    expect(postingTradesProblemMessage(problem)).toBe(message);
  });
});

describe("the edit page's ?trade=required flag", () => {
  it("is attached to a path, with or without a query already on it", () => {
    expect(TRADE_REQUIRED_PARAM).toBe("trade");
    expect(withTradeRequired("/postings/p1/edit")).toBe("/postings/p1/edit?trade=required");
    expect(withTradeRequired("/postings/p1/edit?x=1")).toBe("/postings/p1/edit?x=1&trade=required");
  });

  it("is read strictly: only `required` is the flag", () => {
    expect(isTradeRequiredParam("required")).toBe(true);
    expect(isTradeRequiredParam(["required", "x"])).toBe(true);
    expect(isTradeRequiredParam(undefined)).toBe(false);
    expect(isTradeRequiredParam("")).toBe(false);
    expect(isTradeRequiredParam("yes")).toBe(false);
    expect(isTradeRequiredParam("REQUIRED")).toBe(false);
  });
});
