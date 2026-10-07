import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { EVENT_REGISTRY } from "@badabhai/event-schema";

import type { BufferedMessage } from "../../chat/chat-transcript.buffer";
import {
  FreeChatService,
  freeChatWorkerContextOf,
  recentTurnOf,
  recentTurnsOf,
  summaryForModel,
  verdictOf,
  type FreeChatCallContext,
} from "./free-chat.service";

/**
 * `FreeChatService` — the free chat's I/O (ADR-0051 §3.3): what reaches the model (the worker's
 * own name redacted from EVERY field — G2), what a verdict is, what the ledger records, and what
 * the spine carries. The ai-service is faked at `AiService`'s seam.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const SUBMISSION = "66666666-6666-4666-8666-666666666666";
const CTX = { correlationId: "33333333-3333-4333-8333-333333333333", requestId: "req-1" };

const META = {
  ai_call_id: "call-1",
  task_type: "profiling_free_classify",
  model_name: "gemini-2.5-flash-lite",
  provider: "google",
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

const at = "2026-10-06T10:00:00.000Z";
const line = (role: "worker" | "assistant", text: string, flags: Partial<BufferedMessage> = {}) =>
  ({ role, text, at, voiceNoteId: null, ...flags }) as BufferedMessage;

function make(knownName: string | null = "Ramesh Kumar") {
  const ai = {
    freeChatClassify: vi.fn(
      async (_input: unknown): Promise<unknown> => ({
        category: "casual",
        confidence: 0.9,
        blocked: false,
        ai_metadata: META,
      }),
    ),
    freeChatReply: vi.fn(
      async (_input: unknown): Promise<unknown> => ({
        status: "answer",
        lines: ["Theek hai."],
        followup_chips: [],
        ai_metadata: { ...META, task_type: "profiling_free_reply" },
      }),
    ),
  };
  const cost = { record: vi.fn(async (..._args: unknown[]) => undefined) };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const chat = { mergeFreeChatLock: vi.fn(async (..._args: unknown[]) => true) };
  const service = new FreeChatService(ai as never, cost as never, events as never, chat as never);
  const ctx: FreeChatCallContext = {
    workerId: WORKER,
    sessionId: SESSION,
    ...CTX,
    knownName: async () => knownName,
  };
  return { service, ai, cost, events, chat, ctx };
}

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});
afterEach(() => vi.restoreAllMocks());

describe("classify — G2: the worker's own name leaves NO input field", () => {
  it("redacts the message, every recent turn AND the pending question", async () => {
    const { service, ai, ctx } = make();
    await service.classify(
      {
        text: "Ramesh bol raha hoon, aaj mausam kaisa hai",
        mode: "resume",
        pendingQuestion: "Ramesh ji, aap kaun sa kaam karte hain?",
        messages: [
          line("assistant", "Kumar sahab, kaise ho?"),
          line("worker", "main Ramesh, theek hoon"),
        ],
      },
      ctx,
    );
    const sent = ai.freeChatClassify.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(sent)).not.toMatch(/Ramesh|Kumar/);
    expect(sent).toEqual({
      text: "[NAME] bol raha hoon, aaj mausam kaisa hai",
      recent_turns: [
        { role: "bada_bhai", text: "[NAME] sahab, kaise ho?" },
        { role: "worker", text: "main [NAME], theek hoon" },
      ],
      mode: "resume",
      pending_question: "[NAME] ji, aap kaun sa kaam karte hain?",
    });
  });

  it("sends at most two recent turns, never an identity-intake line, and clips the text", async () => {
    const { service, ai, ctx } = make(null);
    await service.classify(
      {
        text: "x".repeat(1_500),
        mode: "free",
        pendingQuestion: null,
        messages: [
          line("assistant", "Aapka pehla naam kya hai?", { intake: true }),
          line("worker", "Sitaram", { intake: true }),
          line("assistant", "Namaste, main Bada Bhai hoon.", { aside: true }),
          line("worker", "Baad mein", { aside: true }),
          line("assistant", "Theek hai. {{worker_name}} Tab tak kuch bhi poochhiye.", {
            aside: true,
          }),
        ],
      },
      ctx,
    );
    const sent = ai.freeChatClassify.mock.calls[0]![0] as {
      text: string;
      recent_turns: { text: string }[];
    };
    expect(sent.text).toHaveLength(1_000);
    expect(sent.recent_turns.map((t) => t.text)).toEqual([
      "Baad mein",
      "Theek hai.  Tab tak kuch bhi poochhiye.",
    ]);
    expect(JSON.stringify(sent)).not.toContain("Sitaram");
  });
});

describe("classify — a VERDICT needs a real, unblocked, successful call", () => {
  it.each([
    ["null", null],
    ["blocked", { category: "casual", confidence: 0.9, blocked: true, ai_metadata: null }],
    [
      "a mock",
      {
        category: "casual",
        confidence: 0.9,
        blocked: false,
        ai_metadata: { ...META, real_call: false },
      },
    ],
    ["no metadata", { category: "casual", confidence: 0.9, blocked: false, ai_metadata: null }],
    [
      "a failed call",
      {
        category: "casual",
        confidence: 0.9,
        blocked: false,
        ai_metadata: { ...META, success: false },
      },
    ],
  ])("%s is UNAVAILABLE", (_label, out) => {
    expect(verdictOf(out as never)).toEqual({ kind: "unavailable" });
  });

  it("a real verdict carries its category and confidence", () => {
    expect(
      verdictOf({ category: "jobs", confidence: 0.81, blocked: false, ai_metadata: META } as never),
    ).toEqual({ kind: "verdict", category: "jobs", confidence: 0.81 });
  });

  it("records the spend ONCE, under its own task type, attributed to the worker and session", async () => {
    const { service, cost, ctx } = make();
    await service.classify(
      { text: "hello", mode: "free", pendingQuestion: null, messages: [] },
      ctx,
    );
    expect(cost.record).toHaveBeenCalledOnce();
    expect(cost.record).toHaveBeenCalledWith(
      META,
      "profiling_free_classify",
      null,
      CTX.correlationId,
      CTX.requestId,
      {
        workerId: WORKER,
        sessionId: SESSION,
      },
    );
  });

  it("an off-contract input is unavailable WITHOUT a call — never a 422 dressed as a verdict", async () => {
    const { service, ai, cost, ctx } = make(null);
    // `greeting` is never a classify mode (the greeting's chips are read deterministically).
    const bad = await service.classify(
      { text: "hi", mode: "greeting" as never, pendingQuestion: null, messages: [] },
      ctx,
    );
    expect(bad).toEqual({ kind: "unavailable" });
    expect(ai.freeChatClassify).not.toHaveBeenCalled();
    expect(cost.record).not.toHaveBeenCalled();
  });

  it("a name lookup that throws costs the redaction, never the call", async () => {
    const { service, ai, ctx } = make();
    await service.classify(
      { text: "hello", mode: "free", pendingQuestion: null, messages: [] },
      { ...ctx, knownName: async () => Promise.reject(new Error("decrypt failed")) },
    );
    expect(ai.freeChatClassify).toHaveBeenCalledOnce();
  });
});

describe("G2 — the helper's edge cases, on every free-chat input field", () => {
  it("a FIRST-NAME-ONLY worker is redacted from the text, the turns and the pending question", async () => {
    const { service, ai, ctx } = make("Ramesh");
    await service.classify(
      {
        text: "main Ramesh hoon",
        mode: "resume",
        pendingQuestion: "Ramesh ji, aapka kaam kya hai?",
        messages: [line("worker", "ramesh bol raha hoon")],
      },
      ctx,
    );
    const sent = ai.freeChatClassify.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(sent).toLowerCase()).not.toContain("ramesh");
    expect(sent).toMatchObject({
      text: "main [NAME] hoon",
      pending_question: "[NAME] ji, aapka kaam kya hai?",
      recent_turns: [{ role: "worker", text: "[NAME] bol raha hoon" }],
    });
  });

  it("a DEVANAGARI-stored name typed in Devanagari is redacted from all three", async () => {
    const { service, ai, ctx } = make("रमेश कुमार");
    await service.classify(
      {
        text: "मेरा नाम रमेश है",
        mode: "resume",
        pendingQuestion: "रमेश जी, आप कौन सा काम करते हैं?",
        messages: [line("worker", "रमेश कुमार बोल रहा हूँ")],
      },
      ctx,
    );
    const sent = ai.freeChatClassify.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(sent)).not.toMatch(/रमेश|कुमार/);
    expect(sent).toMatchObject({
      text: "मेरा नाम [NAME] है",
      pending_question: "[NAME] जी, आप कौन सा काम करते हैं?",
      recent_turns: [{ role: "worker", text: "[NAME] बोल रहा हूँ" }],
    });
  });
});

describe("reply — G2 and the ledger", () => {
  it("redacts the worker's own name out of worker_context.trade_label too", async () => {
    const { service, ai, ctx } = make();
    await service.reply(
      {
        category: "career",
        text: "welding seekhni hai",
        messages: [],
        workerContext: { trade_label: "Ramesh Kumar welding", experience_bucket: null },
        summary: null,
      },
      ctx,
    );
    const sent = ai.freeChatReply.mock.calls[0]![0] as { worker_context: { trade_label: string } };
    expect(sent.worker_context.trade_label).toBe("[NAME] welding");
  });

  it("redacts the message and every turn, sends six turns at most and the closed context", async () => {
    const { service, ai, cost, ctx } = make();
    const messages = Array.from({ length: 9 }, (_, i) =>
      line(i % 2 ? "assistant" : "worker", `line ${i} Ramesh`),
    );
    await service.reply(
      {
        category: "career",
        text: "Ramesh Kumar ko welding seekhni hai",
        messages,
        workerContext: { trade_label: "Welder", experience_bucket: "3-7" },
        summary: null,
      },
      ctx,
    );
    const sent = ai.freeChatReply.mock.calls[0]![0] as {
      text: string;
      recent_turns: unknown[];
      worker_context: unknown;
      category: string;
    };
    expect(sent.text).toBe("[NAME] ko welding seekhni hai");
    expect(sent.recent_turns).toHaveLength(6);
    expect(JSON.stringify(sent)).not.toContain("Ramesh");
    expect(sent.worker_context).toEqual({ trade_label: "Welder", experience_bucket: "3-7" });
    expect(cost.record.mock.calls[0]![1]).toBe("profiling_free_reply");
  });
});

describe("Release 2 — the rolling summary rides the REPLY only (R24)", () => {
  const reply = (summary: string | null) => ({
    category: "casual" as const,
    text: "kaise ho",
    messages: [],
    workerContext: { trade_label: null, experience_bucket: null },
    summary,
  });

  it("carries the stored summary into the reply input, the worker's own name redacted (G2)", async () => {
    const { service, ai, ctx } = make();
    await service.reply(reply("Ramesh likes cricket. Ramesh Kumar is from Patna."), ctx);
    const sent = ai.freeChatReply.mock.calls[0]![0] as { summary: unknown };
    expect(sent.summary).toBe("[NAME] likes cricket. [NAME] is from Patna.");
  });

  it("sends null when there is no summary, and when only whitespace is left", async () => {
    const { service, ai, ctx } = make();
    await service.reply(reply(null), ctx);
    await service.reply(reply("   "), ctx);
    expect(
      ai.freeChatReply.mock.calls.map(([input]) => (input as { summary: unknown }).summary),
    ).toEqual([null, null]);
  });

  it("an over-long stored summary is CLIPPED to the contract, never a lost reply", async () => {
    const { service, ai, ctx } = make(null);
    const out = await service.reply(reply("x".repeat(1_500)), ctx);
    expect(out).not.toBeNull();
    expect((ai.freeChatReply.mock.calls[0]![0] as { summary: string }).summary).toHaveLength(1_200);
  });

  it("the CLASSIFIER's input has no summary field at all", async () => {
    const { service, ai, ctx } = make();
    await service.classify(
      { text: "kaise ho", mode: "free", pendingQuestion: null, messages: [] },
      ctx,
    );
    expect("summary" in (ai.freeChatClassify.mock.calls[0]![0] as object)).toBe(false);
  });
});

describe("summaryForModel / recentTurnOf", () => {
  it("summaryForModel redacts, trims and clips; null for nothing", () => {
    expect(summaryForModel(null, "Ramesh")).toBeNull();
    expect(summaryForModel("  Ramesh is a welder.  ", "Ramesh")).toBe("[NAME] is a welder.");
    expect(summaryForModel("a".repeat(1_201), null)).toHaveLength(1_200);
  });

  it("recentTurnOf drops an intake line and a blank one, and redacts the rest", () => {
    expect(recentTurnOf(line("worker", "Sitaram", { intake: true }), null)).toBeNull();
    expect(recentTurnOf(line("assistant", " {{worker_name}} "), null)).toBeNull();
    expect(recentTurnOf(line("assistant", "Ramesh ji, theek?"), "Ramesh")).toEqual({
      role: "bada_bhai",
      text: "[NAME] ji, theek?",
    });
  });
});

describe("the worker context — trade and experience, never a name or a city (R16)", () => {
  it("is null when nothing is captured", () => {
    expect(freeChatWorkerContextOf({ occupation: null, answerMap: [] })).toEqual({
      trade_label: null,
      experience_bucket: null,
    });
  });

  it("reads the pin (not the universal placeholder) or the settled trade, and buckets the years", () => {
    expect(
      freeChatWorkerContextOf({
        occupation: { label: "Welder" },
        answerMap: [{ target_field: "experience_years", value_normalized: 4, status: "answered" }],
      }),
    ).toEqual({ trade_label: "Welder", experience_bucket: "3-7" });
    expect(
      freeChatWorkerContextOf({
        occupation: { label: "General" },
        answerMap: [
          { target_field: "trade", value_normalized: "silai", status: "answered" },
          { target_field: "current_city", value_normalized: "Pune", status: "answered" },
        ],
      }),
    ).toEqual({ trade_label: "silai", experience_bucket: null });
  });
});

describe("recentTurnsOf", () => {
  it("drops blank lines and keeps the newest", () => {
    expect(
      recentTurnsOf([line("worker", "a"), line("assistant", "   "), line("worker", "b")], 2, null),
    ).toEqual([
      { role: "worker", text: "a" },
      { role: "worker", text: "b" },
    ]);
  });
});

describe("the spine — ids and closed enums only, never throwing", () => {
  const ref = {
    workerId: WORKER,
    sessionId: SESSION,
    submissionId: SUBMISSION,
    turnRef: "rev3",
    ctx: CTX as never,
  };

  it("emits a served turn that validates, keyed on the submission", async () => {
    const { service, events } = make();
    await service.recordServed(
      {
        mode: "free",
        category: "trash",
        decidedBy: "lexicon",
        confidenceBucket: null,
        outcome: "cooldown",
        refusalTopic: null,
        strikeCount: 3,
        cooldownStarted: true,
        nudge: false,
      },
      ref,
    );
    const params = events.emit.mock.calls[0]![0] as { payload: unknown; idempotencyKey: string };
    expect(
      EVENT_REGISTRY["chat.free_chat_turn_served"].payload.safeParse(params.payload).success,
    ).toBe(true);
    expect(params.idempotencyKey).toBe(`chat.free_chat_turn_served:${SESSION}:${SUBMISSION}`);
  });

  it("keys a mode change on its target mode, and falls back to the write's rev without a submission", async () => {
    const { service, events } = make();
    await service.recordModeChanged({ from: "free", to: "resume", trigger: "classifier" }, ref);
    await service.recordServed(
      {
        mode: "resume",
        category: "casual",
        decidedBy: "classifier",
        confidenceBucket: "gte90",
        outcome: "deflected",
        refusalTopic: null,
        strikeCount: null,
        cooldownStarted: false,
        nudge: false,
      },
      { ...ref, submissionId: null },
    );
    const [changed, served] = events.emit.mock.calls.map(
      ([p]) => p as { idempotencyKey: string; payload: unknown },
    );
    expect(changed!.idempotencyKey).toBe(`chat.free_chat_mode_changed:${SESSION}:resume`);
    expect(
      EVENT_REGISTRY["chat.free_chat_mode_changed"].payload.safeParse(changed!.payload).success,
    ).toBe(true);
    expect(served!.idempotencyKey).toBe(`chat.free_chat_turn_served:${SESSION}:rev3`);
  });

  it("swallows an emit failure and a lock-write failure", async () => {
    const { service, events, chat } = make();
    events.emit.mockRejectedValue(new Error("db down"));
    chat.mergeFreeChatLock.mockRejectedValue(new Error("db down"));
    await expect(
      service.recordModeChanged({ from: null, to: "resume", trigger: "first_turn" }, ref),
    ).resolves.toBeUndefined();
    await expect(service.persistLock(SESSION, WORKER, at)).resolves.toBeUndefined();
  });
});
