import type { PostingTradeFormWire } from "./contracts";

/**
 * #2645 (the web half of #2635) — A COMPANY JOB IS ALWAYS ONE OF THE 16 TRADES.
 *
 * The API matches company jobs only within the 16 postable trades. It refuses to put a job live
 * that names none of them (`400 reason: posting_trade_required`), and it builds a 16-trade job's
 * match skills from its trade. The 16 come from `GET /payer/posting-trades`, the one source: this
 * app keeps no copy of the list. This module holds what the three company trade pickers (New
 * posting, Edit posting, the AI chat's publish step) share, so they cannot drift apart:
 *  - the refusal's copy (the app's own words, never the server's message);
 *  - why the list is not on screen, named from the real cause;
 *  - the edit page's "opened refused at the trade picker" link flag.
 */

/** The refusal, said AT the trade picker. Same copy as the payer app (`kPostingTradeRequiredMessage`). */
export const POSTING_TRADE_REQUIRED_MESSAGE = "Pick one of the 16 trades";

/** Whether `roleKind` is one of the trades the catalogue listed. */
export function isPostingTrade(
  trades: readonly PostingTradeFormWire[],
  roleKind: string | null | undefined,
): boolean {
  return (
    roleKind !== null &&
    roleKind !== undefined &&
    roleKind !== "" &&
    trades.some((trade) => trade.role_kind === roleKind)
  );
}

/**
 * Why the 16 trades are not on the form. Read SERVER-side, where the catalogue is fetched (the
 * Bearer never reaches the browser), and handed to the client form as plain data.
 */
export type PostingTradesProblem =
  /** The catalogue answered, with no trade in it. */
  | { kind: "empty" }
  /** 429 — the payer's request budget for the moment is spent. */
  | { kind: "rate-limited" }
  /** The payer's session ended between the page's reads. */
  | { kind: "session" }
  /** Any other non-2xx, with its status. */
  | { kind: "http"; status: number }
  /** The answer came back but could not be read. */
  | { kind: "unreadable" }
  /** The API could not be reached at all. */
  | { kind: "unreachable" };

/**
 * The line the picker shows instead of the 16 trades: the REAL cause, never a generic
 * "something went wrong" (the same split as the payer app's `PostingTradesUnavailable`).
 */
export function postingTradesProblemMessage(problem: PostingTradesProblem | null): string {
  if (problem === null || problem.kind === "empty") {
    return "No trades are open for posting right now. Try again in a moment.";
  }
  const lead = "The 16 trades did not load";
  switch (problem.kind) {
    case "rate-limited":
      return `${lead}: too many requests just now. Wait a minute, then retry.`;
    case "session":
      return `${lead}: your session has ended. Sign in again.`;
    case "http":
      return problem.status >= 500
        ? `${lead}: the BadaBhai server had a problem (error ${problem.status}).`
        : `${lead}: the server refused the request (error ${problem.status}).`;
    case "unreadable":
      return `${lead}: the server's answer could not be read.`;
    case "unreachable":
      return `${lead}: the BadaBhai server could not be reached.`;
  }
}

/**
 * `?trade=required` on the edit page — it opens with "Pick one of the 16 trades" at its trade
 * picker, because the API refused to put this job live without one (a refused publish elsewhere
 * lands here). Linkable on purpose: the refusal is said where the fix is, after any navigation.
 */
export const TRADE_REQUIRED_PARAM = "trade";
const TRADE_REQUIRED_VALUE = "required";

/** `path` with the trade-required flag attached. */
export function withTradeRequired(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${TRADE_REQUIRED_PARAM}=${TRADE_REQUIRED_VALUE}`;
}

/** Whether the `?trade=` value is the flag (anything else is no flag). */
export function isTradeRequiredParam(raw: string | string[] | undefined): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === TRADE_REQUIRED_VALUE;
}
