/**
 * #2166 security H1 — the G2 own-name redaction FAILS CLOSED. Only an unreadable name (null, blank,
 * no usable part) leaves the text as it is; a throw while folding the text reaches the caller,
 * which fails the turn, the job or the call before anything is sent. A `catch` that returned the
 * raw text would be a silent leak on the floor ADR-0047 keeps "whatever the flag".
 *
 * The fold is the one step that touches every text, so it is the one made to throw here.
 */
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { fakeAiTraceRecorder } from "../ai/ai-trace-recorder.fake";
import { emptyProfilingEnvelope } from "../profiling/conversation-state";
import { LlmTurnService } from "../profiling/llm-turn.service";
import {
  knownNameMatcher,
  redactKnownName,
  redactKnownNameDeep,
  redactKnownNameLines,
} from "./redact-known-name";

const fold = vi.hoisted(() => ({ fails: false }));

vi.mock("./name-fold", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./name-fold")>();
  return {
    ...actual,
    foldText: (text: string) => {
      if (fold.fails) throw new Error("fold failed");
      return actual.foldText(text);
    },
  };
});

beforeEach(() => {
  fold.fails = true;
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  fold.fails = false;
  vi.restoreAllMocks();
});

describe("the redaction fails CLOSED (#2166 security H1)", () => {
  it("a throw while folding reaches the caller of every redactKnownName* function", () => {
    expect(() => redactKnownName("main Suresh hoon", "Suresh Kumar")).toThrow("fold failed");
    expect(() => redactKnownNameLines([{ text: "Suresh" }], "Suresh Kumar")).toThrow("fold failed");
    expect(() => redactKnownNameDeep({ note: ["Suresh"] }, "Suresh Kumar")).toThrow("fold failed");
    expect(() => knownNameMatcher("Suresh Kumar")?.test("Suresh")).toThrow("fold failed");
  });

  it("an UNREADABLE name is the only fail-safe: the text comes back as it is, nothing folded", () => {
    for (const name of [null, undefined, "", "   ", "R K"]) {
      expect(redactKnownName("main Suresh hoon", name)).toBe("main Suresh hoon");
    }
    expect(redactKnownNameLines([{ text: "Suresh" }], null)).toEqual([{ text: "Suresh" }]);
  });

  it("the classic interview turn fails instead of sending the message unredacted", async () => {
    const ai = { llmTurn: vi.fn(async () => null) };
    const cost = { record: vi.fn(async () => undefined) };
    const svc = new LlmTurnService(
      ai as never,
      { CHAT_LLM_INTERVIEW_ENABLED: true } as never,
      cost as never,
      fakeAiTraceRecorder().recorder,
    );
    const ctx = {
      workerId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      correlationId: "44444444-4444-4444-8444-444444444444",
      requestId: "req_1",
      knownName: async (): Promise<string | null> => "Suresh Kumar",
    };
    const envelope = { ...emptyProfilingEnvelope(), phase: "llm_interview" as const };

    await expect(svc.take(envelope, "main Suresh hoon", [], ctx)).rejects.toThrow("fold failed");
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });
});
