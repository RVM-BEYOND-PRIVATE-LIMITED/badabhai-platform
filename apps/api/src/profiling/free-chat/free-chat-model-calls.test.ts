import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import {
  contextLinesOf,
  FreeChatModelCalls,
  type FreeChatCallContext,
} from "./free-chat-model-calls";
import { FreeChatService } from "./free-chat.service";

/**
 * ADR-0055 (#2275) — the free chat's model calls as the BADA BHAI CHAT makes them: no chat session
 * (`sessionId: null`), the `companion` surface on every AI input, and the classifier's
 * `resume_action`. The profiling behaviour of the same methods is pinned by
 * `free-chat.service.test.ts`, which runs them through `FreeChatService` unchanged.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-10-14T10:00:00.000Z");

const META = {
  ai_call_id: "call-1",
  task_type: "profiling_free_classify",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  input_tokens: 1,
  output_tokens: 1,
  estimated_cost_inr: 0.01,
  latency_ms: 10,
  success: true,
  error_code: null,
  cost_alert: false,
  above_target: false,
  attempt_count: 1,
  candidates_tried: [],
  failure_reason: null,
};

function make(classify: unknown = undefined) {
  const ai = {
    freeChatClassify: vi.fn(
      async (_input: unknown): Promise<unknown> =>
        classify === undefined
          ? {
              category: "resume",
              confidence: 0.9,
              blocked: false,
              ai_metadata: META,
              language: null,
              resume_action: "download",
            }
          : classify,
    ),
    freeChatReply: vi.fn(
      async (_input: unknown): Promise<unknown> => ({
        status: "answer",
        lines: ["Theek hai."],
        followup_chips: [],
        ai_metadata: { ...META, task_type: "profiling_free_reply" },
      }),
    ),
    freeChatNews: vi.fn(
      async (_input: unknown): Promise<unknown> => ({
        status: "no_results",
        search_count: 1,
        ai_metadata: { ...META, task_type: "profiling_free_news" },
      }),
    ),
  };
  const cost = { record: vi.fn(async (..._args: unknown[]) => undefined) };
  const newsCap = {
    reserve: vi.fn(async () => ({ ok: true, count: 1 })),
    release: vi.fn(async () => undefined),
  };
  const calls = new FreeChatModelCalls(ai as never, cost as never, newsCap as never);
  const ctx: FreeChatCallContext = {
    workerId: WORKER,
    sessionId: null,
    correlationId: "corr-1",
    requestId: "req-1",
    knownName: async () => null,
    surface: "companion",
  };
  return { calls, ai, cost, newsCap, ctx };
}

const REQ = {
  text: "mera resume bhejna hai",
  mode: "free" as const,
  pendingQuestion: null,
  messages: [],
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const level of ["log", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
  warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("FreeChatModelCalls — the Bada Bhai chat's surface (ADR-0055)", () => {
  it("sends `surface: companion` on classify, reply and news", async () => {
    const { calls, ai, ctx } = make();
    await calls.classify(REQ, ctx);
    await calls.reply(
      {
        category: "career",
        text: "welder kaise banun",
        messages: [],
        workerContext: { trade_label: null, experience_bucket: null },
        summary: null,
        replyLanguage: "hinglish",
      },
      ctx,
    );
    await calls.news(
      {
        text: "aaj ka mausam",
        messages: [],
        workerContext: { trade_label: null, experience_bucket: null },
        replyLanguage: "hinglish",
      },
      ctx,
      null,
    );
    for (const call of [ai.freeChatClassify, ai.freeChatReply, ai.freeChatNews]) {
      expect((call.mock.calls[0]![0] as { surface: string }).surface).toBe("companion");
    }
  });

  it("a context with no surface sends the contract default — every profiling input unchanged", async () => {
    const { calls, ai, ctx } = make();
    const { surface: _omitted, ...profiling } = ctx;
    await calls.classify(REQ, { ...profiling, sessionId: "22222222-2222-4222-8222-222222222222" });
    expect((ai.freeChatClassify.mock.calls[0]![0] as { surface: string }).surface).toBe(
      "profiling",
    );
  });

  it("records the spend with a NULL session — the companion has none", async () => {
    const { calls, cost, ctx } = make();
    await calls.classify(REQ, ctx);
    expect(cost.record).toHaveBeenCalledWith(
      META,
      "profiling_free_classify",
      null,
      "corr-1",
      "req-1",
      {
        workerId: WORKER,
        sessionId: null,
      },
    );
  });

  it("logs a session-less call by its worker, never as `session=null`", async () => {
    const { calls, ctx } = make();
    await calls.classify({ ...REQ, mode: "nonsense" as never }, ctx);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(`worker=${WORKER}`);
    expect(line).not.toContain("session=null");
  });
});

describe("classifyWithAction — the résumé action rides a REAL resume verdict only", () => {
  it("returns the verdict and the action from ONE call", async () => {
    const { calls, ai, cost, ctx } = make();
    const out = await calls.classifyWithAction(REQ, ctx);
    expect(out).toEqual({
      verdict: { kind: "verdict", category: "resume", confidence: 0.9, language: null },
      resumeAction: "download",
    });
    expect(ai.freeChatClassify).toHaveBeenCalledTimes(1);
    expect(cost.record).toHaveBeenCalledTimes(1);
  });

  it("drops an action on any other category", async () => {
    const { calls, ctx } = make({
      category: "career",
      confidence: 0.9,
      blocked: false,
      ai_metadata: META,
      language: null,
      resume_action: "edit",
    });
    expect((await calls.classifyWithAction(REQ, ctx)).resumeAction).toBeNull();
  });

  it("an unavailable verdict (a mock) carries no action", async () => {
    const { calls, ctx } = make({
      category: "resume",
      confidence: 0.9,
      blocked: false,
      ai_metadata: { ...META, real_call: false },
      language: null,
      resume_action: "new",
    });
    expect(await calls.classifyWithAction(REQ, ctx)).toEqual({
      verdict: { kind: "unavailable" },
      resumeAction: null,
    });
  });
});

describe("requestNews — a session-less retry shares ONE request", () => {
  it("dedupes on worker + submission when there is no session", async () => {
    const { calls, ai, newsCap, ctx } = make();
    const req = {
      text: "aaj ka mausam",
      messages: [],
      workerContext: { trade_label: null, experience_bucket: null },
      replyLanguage: "hinglish" as const,
    };
    const first = calls.requestNews(req, ctx, NOW, SUBMISSION);
    const second = calls.requestNews(req, ctx, NOW, SUBMISSION);
    expect(second).toBe(first);
    await first;
    expect(newsCap.reserve).toHaveBeenCalledTimes(1);
    expect(ai.freeChatNews).toHaveBeenCalledTimes(1);
  });
});

describe("contextLinesOf — companion memory as model context", () => {
  it("maps bada_bhai to assistant and keeps the order and the text", () => {
    expect(
      contextLinesOf([
        { role: "worker", text: "namaste" },
        { role: "bada_bhai", text: "Namaste ji" },
      ]),
    ).toEqual([
      { role: "worker", text: "namaste" },
      { role: "assistant", text: "Namaste ji" },
    ]);
  });
});

describe("FreeChatService IS the model calls plus the profiling writes", () => {
  it("inherits the calls, so the profiling chat's methods are unchanged", () => {
    expect(FreeChatService.prototype).toBeInstanceOf(FreeChatModelCalls);
  });
});
