/**
 * LIVE NEWS IN THE FREE CHAT (ADR-0054 §3.1, §3.3) — what one news request ENDED IN. PURE.
 *
 * A casual or career reply that refused on `news` hands the worker's question to the searched
 * answer. Code decides everything the worker then reads (§4, "AI never decides"):
 *
 *   own-name lookup errored (G2)  → NEWS_UNAVAILABLE                 (`unavailable`, no call)
 *   an identifier in the question → NEWS_UNAVAILABLE                 (`unavailable`, no call, R9)
 *   cap store unreadable          → NEWS_UNAVAILABLE                 (`unavailable`, no call)
 *   capped                       → NEWS_CAP                         (`capped`)
 *   null / timeout / error        → NEWS_UNAVAILABLE                 (`unavailable`)
 *   the unarmed mock              → today's NEWS line                (`unavailable`)
 *     (no_results, real_call false, error_code null)
 *   any other non-real answer     → NEWS_UNAVAILABLE                 (`unavailable`)
 *     (no metadata; real_call false with an error_code — the spend cap, the cost ceiling, a
 *     cooldown; a real call with success false)
 *   no_results                    → NEWS_UNAVAILABLE                 (`no_results`)
 *   refuse(topic)                 → that topic's fixed line          (`refused`; `news` → NEWS_UNAVAILABLE)
 *   answer, a line fails the gate → NEWS_UNAVAILABLE                 (`rejected`)
 *   answer, no search ran         → NEWS_UNAVAILABLE                 (`rejected`, ungrounded)
 *   answer, a line carries a link → NEWS_UNAVAILABLE                 (`rejected`, link — §8)
 *   answer, no tile survives      → NEWS_UNAVAILABLE                 (`rejected`)
 *   answer, all checks pass       → the lines + 1-3 tiles            (`answered`)
 *
 * The lines go through the free chat's WHOLE reply gate (`screenFreeChatAnswer`) with no chips:
 * shape, Latin only, persona, promise, sensitive, rating, PII and G1, abuse, template tokens and the
 * regional walls — and no line may carry a URL or a domain (§8): links reach the worker only as
 * checked tiles. The tiles go through `newsLinksOf`.
 *
 * THE CAP COUNTS PAID ATTEMPTS (R5 as revised, §8): {@link keepsSlot} decides whether a request's
 * reservation is kept — whenever the request may have reached Anthropic.
 */

import type { FreeChatNewsOutput } from "@badabhai/ai-contracts";
import { looksLikePii, looksLikeUrl } from "@badabhai/validators";
import type {
  FreeChatNewsKind,
  FreeChatNewsOutcome,
  FreeChatOutcome,
  FreeChatRefusalTopic,
} from "@badabhai/types";

import { containsHardIdentifier } from "../resume-import/resume-parse-gates";
import { screenFreeChatAnswer, type FreeChatAnswerFailure } from "./free-chat-output.validator";
import { newsLinksOf, type FreeChatNewsLink } from "./free-chat-news-links";
import { FREE_CHAT_COPY, FREE_CHAT_REFUSAL_LINES, type FreeChatLine } from "./free-chat.copy";

/** Why the API threw a news answer away — a closed reason for the log, never a line of it. */
export type FreeChatNewsRejection =
  | FreeChatAnswerFailure
  | "ungrounded"
  | "link"
  | "no_valid_source";

/**
 * One news call as the API made it: whether the request was handed to the ai-service at all, and
 * what came back (null on a timeout, a non-OK, a schema miss or an unreachable service).
 */
export interface FreeChatNewsCall {
  readonly sent: boolean;
  readonly output: FreeChatNewsOutput | null;
}

/** A searched answer that passed every check. */
export interface FreeChatNewsAnswered {
  readonly outcome: "answered";
  readonly kind: FreeChatNewsKind;
  /** The gate's (unchanged) lines. Model-written: never read aloud. */
  readonly lines: readonly string[];
  /** 1-3 tiles, each checked by `newsLinksOf`. */
  readonly links: readonly FreeChatNewsLink[];
  readonly searchCount: number;
}

/** Every other ending: a reviewed fixed line. */
export interface FreeChatNewsFixed {
  readonly outcome: Exclude<FreeChatNewsOutcome, "answered">;
  readonly line: FreeChatLine;
  /** The news model's refusal topic — set exactly when `outcome` is `refused`. */
  readonly refusalTopic: FreeChatRefusalTopic | null;
  /** The searches the answer reported running; null when none was reported (or no call made). */
  readonly searchCount: number | null;
  /** Set exactly when `outcome` is `rejected`. */
  readonly rejection: FreeChatNewsRejection | null;
}

/** What the model's output alone decides — every ending but `capped`. */
export type FreeChatNewsVerdict = FreeChatNewsAnswered | FreeChatNewsFixed;

/**
 * One news request, end to end: the verdict plus the worker's count for the day. `dailyCount` is
 * the paid attempts counted today AFTER this request — including its own slot when it was kept,
 * without it when it was handed back — and null when no reservation was made (an unreadable cap,
 * an identifier in the question, an own-name lookup that errored).
 */
export type FreeChatNewsResolution = FreeChatNewsVerdict & { readonly dailyCount: number | null };

/** What `chat.free_chat_news_served` records — ids are the caller's; counts and enums only. */
export interface FreeChatNewsServed {
  readonly outcome: FreeChatNewsOutcome;
  readonly kind: FreeChatNewsKind | null;
  readonly searchCount: number | null;
  readonly sourceCount: number;
  readonly dailyCount: number | null;
}

/** How a news ending is recorded on `chat.free_chat_turn_served` (v1, unchanged — ADR-0054 §3.5). */
export const NEWS_TURN_OUTCOMES: Readonly<Record<FreeChatNewsOutcome, FreeChatOutcome>> = {
  answered: "answered",
  no_results: "fixed_line",
  refused: "refused",
  rejected: "fallback",
  unavailable: "fixed_line",
  capped: "fixed_line",
};

const UNAVAILABLE = FREE_CHAT_COPY.NEWS_UNAVAILABLE;

function fixed(
  outcome: FreeChatNewsFixed["outcome"],
  line: FreeChatLine,
  searchCount: number | null,
  extra: Partial<Pick<FreeChatNewsFixed, "refusalTopic" | "rejection">> = {},
): FreeChatNewsFixed {
  return { outcome, line, refusalTopic: null, searchCount, rejection: null, ...extra };
}

/** The worker has spent today's cap: no call is made. */
export function newsCapped(heldToday: number): FreeChatNewsResolution {
  return { ...fixed("capped", FREE_CHAT_COPY.NEWS_CAP, null), dailyCount: heldToday };
}

/**
 * NO REQUEST WAS MADE, AND NO SLOT TAKEN: the cap store could not be read, the question carries an
 * identifier (R9), or the worker's own name could not be looked up (G2). FAIL CLOSED — no call, the
 * unavailable line, no count.
 */
export const NEWS_NOT_REQUESTED: FreeChatNewsResolution = {
  ...fixed("unavailable", UNAVAILABLE, null),
  dailyCount: null,
};

/**
 * R9 — does a news question (or a recent turn riding with it) carry an identifier? A phone number,
 * an email, an ID number: `looksLikePii` OR `containsHardIdentifier`. Such text is never searched —
 * the search query is written from it and leaves for a third-party search provider. A scanner that
 * throws counts as a hit — fail closed. Independent of `AI_RAW_PII_ENABLED`.
 */
export function carriesNewsIdentifier(text: string): boolean {
  try {
    return looksLikePii(text) || containsHardIdentifier(text) !== null;
  } catch {
    return true;
  }
}

/**
 * R5 AS REVISED — is this request's slot KEPT? Whenever it may have reached Anthropic: a real call
 * (`real_call === true`, whatever it found), and a request that was sent but came back with nothing
 * (a timeout or an error after dispatch may still have been billed). HANDED BACK only when it
 * certainly did not: never sent (the input was refused before sending), or a result that says no
 * call was made — the unarmed mock, the spend-cap or cooldown mock (`real_call: false`), or a
 * blocked input (no metadata).
 */
export function keepsSlot(call: FreeChatNewsCall): boolean {
  if (!call.sent) return false;
  if (call.output === null) return true;
  return call.output.ai_metadata?.real_call === true;
}

/**
 * A LINE CARRYING A LINK (§8): a URL, a `www.` host or a dotted common TLD (`looksLikeUrl`, which
 * also reads the fullwidth / invisibly split fold), or a bare host on a TLD that list does not
 * name but a phishing or messaging link uses (`wa.me`, `bit.ly`, `x.xyz`, …). Links reach the
 * worker only as checked tiles. A check that throws counts as a hit — fail closed.
 */
const EXTRA_LINK_HOST =
  /(?:^|[^\w.@-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:me|ly|gl|gd|xyz|online|site|top|app|link|click|live|shop|store|ws|cc|tk|ml|ga|cf|gq|icu|buzz|club|vip|gov|edu)\b/i;

function carriesLink(line: string): boolean {
  try {
    return looksLikeUrl(line) || EXTRA_LINK_HOST.test(line.normalize("NFKC"));
  } catch {
    return true;
  }
}

/** Judge one news call's output — see the module header for the whole table. */
export function judgeNews(out: FreeChatNewsOutput | null): FreeChatNewsVerdict {
  if (out === null) return fixed("unavailable", UNAVAILABLE, null);
  const searchCount = out.status === "refuse" ? null : out.search_count;
  if (isUnarmedMock(out)) return fixed("unavailable", FREE_CHAT_COPY.NEWS, searchCount);
  // NO REAL VERDICT: a real verdict needs `real_call === true` and `success !== false`. Anything
  // else — no metadata (a blocked input), a refused call (the spend cap, the cost ceiling, a
  // cooldown: `real_call` false WITH an `error_code`), a failed one (timeout, provider error) — is
  // the unavailable line, never the "jaldi aayegi" promise and never `no_results`.
  const meta = out.ai_metadata;
  if (meta?.real_call !== true || meta.success === false) {
    return fixed("unavailable", UNAVAILABLE, searchCount);
  }
  switch (out.status) {
    case "no_results":
      return fixed("no_results", UNAVAILABLE, searchCount);
    case "refuse":
      return fixed(
        "refused",
        // A news model that refuses on `news` itself has nothing to say: the unavailable line,
        // never the "jaldi aayegi" promise the armed feature has already kept.
        out.topic === "news" ? UNAVAILABLE : FREE_CHAT_REFUSAL_LINES[out.topic],
        null,
        { refusalTopic: out.topic },
      );
    case "answer":
      return judgeAnswer(out);
  }
}

/**
 * THE TASK IS NOT ARMED (R7): the ai-service's mock — `no_results` from a call that was not made
 * (`real_call: false`) and that nothing refused (`error_code: null`). The worker keeps today's
 * "jaldi aayegi" line until the owner appends `profiling_free_news` to `AI_REAL_CALL_TASKS` (R8).
 * A non-null `error_code` is the spend cap, the cost ceiling or a cooldown on an ARMED task — not
 * this.
 */
function isUnarmedMock(out: FreeChatNewsOutput): boolean {
  // `?.`, not `!== null`: an unparsed body may carry no key at all, which is no metadata either.
  const meta = out.ai_metadata;
  return out.status === "no_results" && meta?.real_call === false && meta.error_code === null;
}

/** A searched answer: grounded, every line through the reply gate, at least one valid tile. */
function judgeAnswer(out: Extract<FreeChatNewsOutput, { status: "answer" }>): FreeChatNewsVerdict {
  const rejected = (rejection: FreeChatNewsRejection) =>
    fixed("rejected", UNAVAILABLE, out.search_count, { rejection });
  // GROUNDED ONLY (§4): a source can only have come from a search that actually ran.
  if (out.search_count < 1) return rejected("ungrounded");
  if (out.lines.some(carriesLink)) return rejected("link");
  const screened = screenFreeChatAnswer({ lines: out.lines, followup_chips: [] });
  if (screened.kind === "reject") return rejected(screened.failure);
  const links = newsLinksOf(out.sources);
  if (links.length === 0) return rejected("no_valid_source");
  return {
    outcome: "answered",
    kind: out.kind,
    lines: [...screened.answer.lines],
    links,
    searchCount: out.search_count,
  };
}

/** The spine's facts for one resolution — `kind` and tiles exactly when it was answered. */
export function newsServedOf(resolution: FreeChatNewsResolution): FreeChatNewsServed {
  return {
    outcome: resolution.outcome,
    kind: resolution.outcome === "answered" ? resolution.kind : null,
    searchCount: resolution.searchCount,
    sourceCount: resolution.outcome === "answered" ? resolution.links.length : 0,
    dailyCount: resolution.dailyCount,
  };
}
