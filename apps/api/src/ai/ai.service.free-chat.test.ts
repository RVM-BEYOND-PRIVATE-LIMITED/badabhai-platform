import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";

import { AiService } from "./ai.service";

/**
 * ADR-0051 — the profiling-stage free chat's transport calls: the routes, the parse, the
 * fail-closed null, and the budgets (2.5 s classify, 10 s reply, 8 s summarize — Release 2, 25 s
 * news — ADR-0054). The
 * CALL SHAPE is pinned too:
 * the ai-service's eval reads `ai.service.ts` for exactly
 * `this.post("/free-chat/classify", input, <Schema>, <ms>` to keep the two sides' timeouts in step.
 */

const config = { AI_SERVICE_URL: "http://ai-service:8000" } as unknown as ServerConfig;

const response = (json: unknown) =>
  ({ ok: true, status: 200, json: async () => json }) as unknown as Response;

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("freeChatClassify / freeChatReply", () => {
  it("posts the classifier to /free-chat/classify and parses the closed category", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response({ category: "career", confidence: 0.8, blocked: false, ai_metadata: null }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const out = await new AiService(config).freeChatClassify({
      text: "welder kaise banun",
      recent_turns: [],
      mode: "free",
      pending_question: null,
    });
    expect(out).toEqual({ category: "career", confidence: 0.8, blocked: false, ai_metadata: null });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://ai-service:8000/free-chat/classify");
  });

  it("posts the reply to /free-chat/reply and parses an answer or a refusal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: "answer", lines: ["Theek hai."] }))
      .mockResolvedValueOnce(response({ status: "refuse", topic: "news" }));
    vi.stubGlobal("fetch", fetchMock);
    const ai = new AiService(config);
    const input = {
      category: "casual" as const,
      text: "kaise ho",
      recent_turns: [],
      worker_context: { trade_label: null, experience_bucket: null },
      summary: null,
    };
    expect(await ai.freeChatReply(input)).toMatchObject({
      status: "answer",
      lines: ["Theek hai."],
    });
    expect(await ai.freeChatReply(input)).toMatchObject({ status: "refuse", topic: "news" });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://ai-service:8000/free-chat/reply");
  });

  it("returns NULL on a schema miss and when unreachable — never a fabricated verdict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ category: "gossip", confidence: 0.9 })),
    );
    const ai = new AiService(config);
    expect(
      await ai.freeChatClassify({
        text: "x",
        recent_turns: [],
        mode: "free",
        pending_question: null,
      }),
    ).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(
      await ai.freeChatReply({
        category: "career",
        text: "x",
        recent_turns: [],
        worker_context: { trade_label: null, experience_bucket: null },
        summary: null,
      }),
    ).toBeNull();
  });

  it("bounds the classifier at 2.5 s and the reply at 10 s", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signals.push(init.signal);
              init.signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        ),
      );
      const ai = new AiService(config);
      const classify = ai.freeChatClassify({
        text: "x",
        recent_turns: [],
        mode: "free",
        pending_question: null,
      });
      const reply = ai.freeChatReply({
        category: "career",
        text: "x",
        recent_turns: [],
        worker_context: { trade_label: null, experience_bucket: null },
        summary: null,
      });
      await vi.advanceTimersByTimeAsync(2_400);
      expect(signals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(7_500);
      expect(signals[1]?.aborted).toBe(true);
      expect(await classify).toBeNull();
      expect(await reply).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the call shape the ai-service eval reads", () => {
    const source = readFileSync(join(__dirname, "ai.service.ts"), "utf8");
    expect(source).toContain(
      'this.post("/free-chat/classify", input, FreeChatClassifyOutputSchema, 2500,',
    );
    expect(source).toContain(
      'this.post("/free-chat/reply", input, FreeChatReplyOutputSchema, 10000,',
    );
    expect(source).toContain(
      'this.post("/free-chat/summarize", input, FreeChatSummarizeOutputSchema, 8000,',
    );
  });
});

describe("freeChatSummarize — Release 2's rolling summary (ADR-0051 §8)", () => {
  const input = {
    previous_summary: null,
    turns: [{ role: "worker" as const, text: "aaj chhutti hai" }],
  };

  it("posts to /free-chat/summarize and parses the summary (or null)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ summary: "Worker had a day off.", ai_metadata: null }))
      .mockResolvedValueOnce(response({ summary: null, ai_metadata: null }));
    vi.stubGlobal("fetch", fetchMock);
    const ai = new AiService(config);
    expect(await ai.freeChatSummarize(input)).toEqual({
      summary: "Worker had a day off.",
      ai_metadata: null,
    });
    expect(await ai.freeChatSummarize(input)).toEqual({ summary: null, ai_metadata: null });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://ai-service:8000/free-chat/summarize");
  });

  it("returns NULL on a schema miss, a non-OK and when unreachable", async () => {
    const ai = new AiService(config);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ summary: 42 })));
    expect(await ai.freeChatSummarize(input)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response),
    );
    expect(await ai.freeChatSummarize(input)).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await ai.freeChatSummarize(input)).toBeNull();
  });

  it("is bounded at 8 s", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signal = init.signal;
              init.signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        ),
      );
      const out = new AiService(config).freeChatSummarize(input);
      await vi.advanceTimersByTimeAsync(7_900);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(signal?.aborted).toBe(true);
      expect(await out).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("freeChatNews — ADR-0054 live news", () => {
  const input = {
    text: "aaj ka mausam kaisa hai",
    recent_turns: [],
    worker_context: { trade_label: null, experience_bucket: null },
    worker_ref: "11111111-1111-4111-8111-111111111111",
  };

  it("posts to /free-chat/news and parses an answer, no_results or a refusal", async () => {
    const answer = {
      status: "answer",
      kind: "everyday",
      lines: ["Aaj Pune mein baarish ho sakti hai."],
      sources: [
        { url: "https://mausam.imd.gov.in/a", title: "Forecast", site: "mausam.imd.gov.in" },
      ],
      search_count: 1,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(answer))
      .mockResolvedValueOnce(response({ status: "no_results", search_count: 0 }))
      .mockResolvedValueOnce(response({ status: "refuse", topic: "off_limits" }));
    vi.stubGlobal("fetch", fetchMock);
    const ai = new AiService(config);
    expect(await ai.freeChatNews(input)).toEqual({ ...answer, ai_metadata: null });
    expect(await ai.freeChatNews(input)).toEqual({
      status: "no_results",
      search_count: 0,
      ai_metadata: null,
    });
    expect(await ai.freeChatNews(input)).toMatchObject({ status: "refuse", topic: "off_limits" });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://ai-service:8000/free-chat/news");
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)).toEqual(input);
  });

  it("returns NULL on a schema miss (4 sources, an unknown kind), a non-OK and when unreachable", async () => {
    const ai = new AiService(config);
    const source = { url: "https://www.thehindu.com/a", title: "t", site: "thehindu.com" };
    for (const bad of [
      {
        status: "answer",
        kind: "work",
        lines: ["x"],
        sources: [source, source, source, source],
        search_count: 1,
      },
      { status: "answer", kind: "politics", lines: ["x"], sources: [source], search_count: 1 },
      { status: "answer", kind: "work", lines: ["x"], sources: [], search_count: 1 },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(bad)));
      expect(await ai.freeChatNews(input)).toBeNull();
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 } as unknown as Response),
    );
    expect(await ai.freeChatNews(input)).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect(await ai.freeChatNews(input)).toBeNull();
  });

  it("is bounded at 25 s — and keeps the call shape the ai-service eval reads", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signal = init.signal;
              init.signal.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        ),
      );
      const out = new AiService(config).freeChatNews(input);
      await vi.advanceTimersByTimeAsync(24_900);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(signal?.aborted).toBe(true);
      expect(await out).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    const source = readFileSync(join(__dirname, "ai.service.ts"), "utf8");
    expect(source).toContain(
      'this.post("/free-chat/news", input, FreeChatNewsOutputSchema, 25000,',
    );
  });
});
