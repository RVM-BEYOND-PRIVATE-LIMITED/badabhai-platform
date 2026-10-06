import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";

import { AiService } from "./ai.service";

/**
 * ADR-0051 — the profiling-stage free chat's two transport calls: the routes, the parse, the
 * fail-closed null, and the budgets (2.5 s classify, 10 s reply). The CALL SHAPE is pinned too:
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
  });
});
