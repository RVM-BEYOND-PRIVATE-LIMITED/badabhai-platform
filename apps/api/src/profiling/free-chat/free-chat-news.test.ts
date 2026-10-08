import { describe, expect, it } from "vitest";
import { FreeChatNewsOutputSchema, type FreeChatNewsOutput } from "@badabhai/ai-contracts";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import { FREE_CHAT_NEWS_OUTCOMES, FREE_CHAT_REFUSAL_TOPICS } from "@badabhai/types";

import { FREE_CHAT_COPY, FREE_CHAT_REFUSAL_LINES } from "./free-chat.copy";
import {
  judgeNews,
  NEWS_CAP_UNREADABLE,
  NEWS_TURN_OUTCOMES,
  newsCapped,
  newsServedOf,
  type FreeChatNewsResolution,
} from "./free-chat-news";

/**
 * ADR-0054 §3.1 / §3.3 — what one news call's output ends in. Code decides every ending: the mock
 * keeps today's NEWS line, every failure is the unavailable line, a refusal is its topic's line, and
 * an answer is served only grounded, through the whole reply gate, with at least one valid tile.
 */

const REAL = {
  ai_call_id: "call-news",
  task_type: "profiling_free_news",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  input_tokens: 900,
  output_tokens: 80,
  estimated_cost_inr: 1.4,
  latency_ms: 6_000,
  success: true,
  error_code: null,
  cost_alert: false,
  above_target: false,
  attempt_count: 1,
  candidates_tried: [],
  failure_reason: null,
  created_at: "2026-10-08T10:00:00.000Z",
};

const SOURCE = {
  url: "https://www.thehindu.com/news/cities/pune/factory",
  title: "New factory in Pune",
  site: "thehindu.com",
};

/** Through the REAL contract parse, as `AiService.post` does. */
const parsed = (raw: Record<string, unknown>): FreeChatNewsOutput =>
  FreeChatNewsOutputSchema.parse(raw);

const answer = (over: Record<string, unknown> = {}) =>
  parsed({
    status: "answer",
    kind: "work",
    lines: ["Pune mein ek nayi factory khul rahi hai."],
    sources: [SOURCE],
    search_count: 1,
    ai_metadata: REAL,
    ...over,
  });

describe("no real answer — the unavailable endings", () => {
  it("null (timeout, error, schema miss) → NEWS_UNAVAILABLE", () => {
    expect(judgeNews(null)).toMatchObject({
      outcome: "unavailable",
      line: FREE_CHAT_COPY.NEWS_UNAVAILABLE,
      searchCount: null,
    });
  });

  it("the UNARMED mock keeps today's NEWS line ('jaldi aayegi') — R7/R8", () => {
    const mock = parsed({
      status: "no_results",
      search_count: 0,
      ai_metadata: { ...REAL, real_call: false },
    });
    expect(judgeNews(mock)).toMatchObject({
      outcome: "unavailable",
      line: FREE_CHAT_COPY.NEWS,
      searchCount: 0,
    });
    // No metadata at all is no real call either.
    expect(judgeNews(parsed({ status: "no_results", search_count: 0 }))).toMatchObject({
      outcome: "unavailable",
      line: FREE_CHAT_COPY.NEWS,
    });
    // Even an "answer" is not served when it was not a real call.
    expect(judgeNews(answer({ ai_metadata: { ...REAL, real_call: false } })).outcome).toBe(
      "unavailable",
    );
  });

  it("a real call that FAILED → NEWS_UNAVAILABLE", () => {
    expect(judgeNews(answer({ ai_metadata: { ...REAL, success: false } }))).toMatchObject({
      outcome: "unavailable",
      line: FREE_CHAT_COPY.NEWS_UNAVAILABLE,
    });
  });
});

describe("the model's other two answers", () => {
  it("no_results → NEWS_UNAVAILABLE, with the searches it ran", () => {
    expect(
      judgeNews(parsed({ status: "no_results", search_count: 2, ai_metadata: REAL })),
    ).toMatchObject({
      outcome: "no_results",
      line: FREE_CHAT_COPY.NEWS_UNAVAILABLE,
      searchCount: 2,
    });
  });

  it("refuse(topic) → that topic's fixed line; a nested `news` refusal → NEWS_UNAVAILABLE", () => {
    for (const topic of FREE_CHAT_REFUSAL_TOPICS) {
      const out = judgeNews(parsed({ status: "refuse", topic, ai_metadata: REAL }));
      expect(out).toMatchObject({ outcome: "refused", refusalTopic: topic, searchCount: null });
      if (out.outcome === "answered") throw new Error("unreachable");
      expect(out.line).toBe(
        topic === "news" ? FREE_CHAT_COPY.NEWS_UNAVAILABLE : FREE_CHAT_REFUSAL_LINES[topic],
      );
    }
  });
});

describe("an answer — grounded, gated, and sourced", () => {
  it("passes with the gate's lines, its kind, its tiles and its search count", () => {
    expect(judgeNews(answer({ kind: "everyday", search_count: 2 }))).toEqual({
      outcome: "answered",
      kind: "everyday",
      lines: ["Pune mein ek nayi factory khul rahi hai."],
      links: [{ title: "New factory in Pune", url: SOURCE.url, site: "thehindu.com" }],
      searchCount: 2,
    });
  });

  it("is REJECTED when no search ran — an answer is never served ungrounded", () => {
    expect(judgeNews(answer({ search_count: 0 }))).toMatchObject({
      outcome: "rejected",
      rejection: "ungrounded",
      line: FREE_CHAT_COPY.NEWS_UNAVAILABLE,
    });
  });

  it("is REJECTED when a line fails the reply gate (G1, persona, script, shape, promise)", () => {
    for (const lines of [
      ["Call karein 98765 43210 par."],
      ["Bhai, factory khul rahi hai."],
      ["पुणे में नई फैक्ट्री खुल रही है।"],
      ["Aapko naukri pakka milegi."],
      [Array.from({ length: 25 }, () => "shabd").join(" ")],
      ["Factory {{worker_name}} khul rahi hai."],
    ]) {
      const out = judgeNews(answer({ lines }));
      expect(out.outcome, lines[0]).toBe("rejected");
      if (out.outcome === "answered") throw new Error("unreachable");
      expect(out.line).toBe(FREE_CHAT_COPY.NEWS_UNAVAILABLE);
      expect(out.rejection).not.toBeNull();
    }
  });

  it("is REJECTED when no source survives the tile checks", () => {
    for (const sources of [
      [{ ...SOURCE, url: "http://www.thehindu.com/a" }],
      [{ ...SOURCE, url: "https://evilindiatimes.com/a" }],
      [{ ...SOURCE, title: "Helpline 98765 43210" }],
    ]) {
      expect(judgeNews(answer({ sources }))).toMatchObject({
        outcome: "rejected",
        rejection: "no_valid_source",
      });
    }
  });

  it("keeps the answer when only SOME sources fail — the failures are dropped", () => {
    const out = judgeNews(
      answer({ sources: [{ ...SOURCE, url: "https://evil.example/x" }, SOURCE] }),
    );
    expect(out.outcome).toBe("answered");
    if (out.outcome !== "answered") throw new Error("unreachable");
    expect(out.links).toHaveLength(1);
  });
});

describe("the spine's facts, and the turn event's mapping", () => {
  const payload = (r: FreeChatNewsResolution) => {
    const s = newsServedOf(r);
    return {
      worker_id: "11111111-1111-4111-8111-111111111111",
      session_id: "22222222-2222-4222-8222-222222222222",
      outcome: s.outcome,
      kind: s.kind,
      search_count: s.searchCount,
      source_count: s.sourceCount,
      daily_count: s.dailyCount,
      submission_id: null,
    };
  };
  const valid = (r: FreeChatNewsResolution) =>
    EVENT_REGISTRY["chat.free_chat_news_served"].payload.safeParse(payload(r)).success;

  it("every ending maps to a payload the registered v1 schema accepts", () => {
    const endings: FreeChatNewsResolution[] = [
      { ...judgeNews(answer()), dailyCount: 2 },
      { ...judgeNews(null), dailyCount: 1 },
      { ...judgeNews(parsed({ status: "no_results", search_count: 0 })), dailyCount: 0 },
      {
        ...judgeNews(parsed({ status: "no_results", search_count: 2, ai_metadata: REAL })),
        dailyCount: 1,
      },
      {
        ...judgeNews(parsed({ status: "refuse", topic: "off_limits", ai_metadata: REAL })),
        dailyCount: 1,
      },
      { ...judgeNews(answer({ search_count: 0 })), dailyCount: 1 },
      newsCapped(5),
      NEWS_CAP_UNREADABLE,
    ];
    expect(new Set(endings.map((e) => e.outcome))).toEqual(new Set(FREE_CHAT_NEWS_OUTCOMES));
    for (const ending of endings) expect(valid(ending), ending.outcome).toBe(true);
    expect(newsServedOf({ ...judgeNews(answer()), dailyCount: 2 })).toMatchObject({
      kind: "work",
      sourceCount: 1,
    });
  });

  it("the cap line is NEWS_CAP and makes no search; an unreadable cap reports no count", () => {
    expect(newsCapped(5)).toMatchObject({
      outcome: "capped",
      line: FREE_CHAT_COPY.NEWS_CAP,
      searchCount: null,
      dailyCount: 5,
    });
    expect(NEWS_CAP_UNREADABLE).toMatchObject({
      outcome: "unavailable",
      line: FREE_CHAT_COPY.NEWS_UNAVAILABLE,
      dailyCount: null,
    });
  });

  it("chat.free_chat_turn_served keeps v1: answered | fixed_line | refused | fallback", () => {
    expect(NEWS_TURN_OUTCOMES).toEqual({
      answered: "answered",
      no_results: "fixed_line",
      refused: "refused",
      rejected: "fallback",
      unavailable: "fixed_line",
      capped: "fixed_line",
    });
  });
});
