import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { personaCorpus } from "@badabhai/profiling-lexicon";

import { TurnUnderstandingService, type UnderstandRequest } from "./turn-understanding.service";

/**
 * ADR-0057 (#2311) — the two model calls: what reaches the model (never the worker's own name),
 * what is recorded (always the spend), and what comes back (only a real, on-persona answer).
 */

const META = {
  ai_call_id: "c",
  task_type: "profiling_turn_understand",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  success: true,
  created_at: "2026-10-16T10:00:00Z",
};

function world(opts: { understand?: unknown; turn?: unknown } = {}) {
  const ai = {
    understandTurn: vi.fn(async (_input: unknown, _ctx?: unknown) =>
      opts.understand === undefined
        ? {
            intent: "statement",
            confidence: 0.9,
            fills: [],
            edits: [],
            page_owned_mentions: [],
            blocked: false,
            ai_metadata: META,
          }
        : opts.understand,
    ),
    llmTurn: vi.fn(async (_input: unknown, _ctx?: unknown) =>
      opts.turn === undefined
        ? { reply_text: "Theek hai, likh liya.", is_mock: false, blocked: false, ai_metadata: META }
        : opts.turn,
    ),
  };
  const cost = { record: vi.fn(async () => undefined) };
  const traces = { capture: vi.fn(async () => undefined) };
  const service = new TurnUnderstandingService(ai as never, cost as never, traces as never);
  return { service, ai, cost, traces };
}

const CTX = {
  workerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  correlationId: "33333333-3333-4333-8333-333333333333",
  requestId: "req_1",
  knownName: async () => "Ramesh Kumar",
};

const REQUEST: UnderstandRequest = {
  text: "main Ramesh Kumar hoon, Pune mein rehta hoon",
  history: [
    { role: "assistant", text: "Namaste Ramesh Kumar" },
    { role: "worker", text: "haan" },
  ],
  onScreen: { key: "current_city", text: "Aap kis sheher mein rehte hain?", options: [] },
  schema: [
    {
      key: "experience",
      label: "Kaam",
      kind: "list",
      options: [],
      value: null,
      status: "answered",
      entries: [{ ref: "x1", value: "Ramesh Kumar ki dukaan pe helper" }],
    },
  ],
  progress: { answered: 1, total: 5 },
};

describe("understand", () => {
  it("never sends the worker's own name — message, turns or schema", async () => {
    const { service, ai } = world();
    await service.understand(REQUEST, CTX);
    const sent = JSON.stringify(ai.understandTurn.mock.calls[0]?.[0]);
    expect(sent).not.toContain("Ramesh");
    expect(sent).toContain("Pune");
  });

  it("L1 — only the on-screen row carries options", async () => {
    const { service, ai } = world();
    const req: UnderstandRequest = {
      ...REQUEST,
      onScreen: { key: "controller", text: "Kaunsa controller?", options: ["Fanuc", "Siemens"] },
      schema: [
        { key: "controller", label: "Controller", kind: "single_select", options: ["Fanuc", "Siemens"], value: null, status: "unanswered", entries: [] },
        { key: "trade", label: "Trade", kind: "text", options: ["Turner"], value: null, status: "unanswered", entries: [] },
      ],
    };
    await service.understand(req, CTX);
    const sent = ai.understandTurn.mock.calls[0]?.[0] as {
      schema_rows: { key: string; label: string; options: string[] }[];
    };
    expect(sent.schema_rows).toEqual([
      expect.objectContaining({ key: "controller", options: ["Fanuc", "Siemens"] }),
      expect.objectContaining({ key: "trade", options: [], label: "Trade" }),
    ]);
  });

  it("L1 — a model-written question (null key) carries no row options", async () => {
    const { service, ai } = world();
    const req: UnderstandRequest = {
      ...REQUEST,
      onScreen: { key: null, text: "Aap kis machine pe kaam karte hain?", options: [] },
      schema: [
        { key: "controller", label: "Controller", kind: "single_select", options: ["Fanuc"], value: null, status: "unanswered", entries: [] },
      ],
    };
    await service.understand(req, CTX);
    const sent = ai.understandTurn.mock.calls[0]?.[0] as {
      schema_rows: { key: string; options: string[] }[];
    };
    expect(sent.schema_rows).toEqual([expect.objectContaining({ key: "controller", options: [] })]);
  });

  it("FAILS CLOSED on an unreadable name: no call at all", async () => {
    const { service, ai, cost } = world();
    const out = await service.understand(REQUEST, {
      ...CTX,
      knownName: async () => {
        throw new Error("decrypt failed");
      },
    });
    expect(out).toBeNull();
    expect(ai.understandTurn).not.toHaveBeenCalled();
    expect(cost.record).not.toHaveBeenCalled();
  });

  it("records the spend before any branch, and returns a real verdict", async () => {
    const { service, cost, traces } = world();
    const out = await service.understand(REQUEST, CTX);
    expect(out?.intent).toBe("statement");
    expect(cost.record).toHaveBeenCalledWith(
      META,
      "profiling_turn_understand",
      null,
      CTX.correlationId,
      CTX.requestId,
      { workerId: CTX.workerId, sessionId: CTX.sessionId },
    );
    expect(traces.capture).toHaveBeenCalled();
  });

  it.each([
    ["a mock", { intent: "chat", confidence: 1, fills: [], edits: [], page_owned_mentions: [], blocked: false, ai_metadata: { ...META, real_call: false } }],
    ["a blocked input", { intent: "unclear", confidence: 0, fills: [], edits: [], page_owned_mentions: [], blocked: true, ai_metadata: null }],
    ["a failed call", { intent: "chat", confidence: 1, fills: [], edits: [], page_owned_mentions: [], blocked: false, ai_metadata: { ...META, success: false } }],
    ["no answer", null],
  ])("%s is no verdict — today's turn runs", async (_label, answer) => {
    const { service, cost } = world({ understand: answer });
    expect(await service.understand(REQUEST, CTX)).toBeNull();
    // Recorded even so: a call that may have reached a provider is a call that may have cost.
    expect(cost.record).toHaveBeenCalledTimes(1);
  });
});

describe("bridge", () => {
  const BRIDGE = {
    reason: "filled" as const,
    noted: ["Sheher: Pune", "Naam: Ramesh Kumar"],
    nextQuestion: "Aap kab se kaam shuru kar sakte hain?",
    remaining: null,
    text: "Ramesh hoon, Pune mein",
    stage: "done" as const,
  };

  it("asks for a bridge line, name-redacted, and returns it", async () => {
    const { service, ai, cost } = world();
    expect(await service.bridge(BRIDGE, CTX)).toBe("Theek hai, likh liya.");
    const sent = ai.llmTurn.mock.calls[0]?.[0] as unknown as { interview_mode: string };
    expect(sent.interview_mode).toBe("bridge");
    expect(JSON.stringify(sent)).not.toContain("Ramesh");
    expect(cost.record).toHaveBeenCalledWith(
      META,
      "profiling_chat_turn",
      null,
      CTX.correlationId,
      CTX.requestId,
      expect.anything(),
    );
  });

  it("refuses a question, a mock, and a persona break", async () => {
    expect(
      await world({ turn: { reply_text: "Theek hai?", is_mock: false, blocked: false } }).service.bridge(BRIDGE, CTX),
    ).toBeNull();
    expect(
      await world({ turn: { reply_text: "Theek hai.", is_mock: true, blocked: false } }).service.bridge(BRIDGE, CTX),
    ).toBeNull();
    const banned = personaCorpus().bannedVocatives[0] ?? personaCorpus().bannedInformal[0];
    expect(
      await world({
        turn: { reply_text: `Theek hai ${banned}, likh liya.`, is_mock: false, blocked: false },
      }).service.bridge(BRIDGE, CTX),
    ).toBeNull();
  });
});
