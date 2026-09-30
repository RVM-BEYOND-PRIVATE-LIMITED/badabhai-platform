/**
 * R32 / ADR-0047 G2 — Phase A's egress, end to end: a REAL `ProfilingOrchestrator` and a REAL
 * `LlmTurnService` (`testing/replay-world.test-support.ts`), with only `AiService.llmTurn`
 * scripted. The worker's own known name leaves `takeTurn` as `[NAME]` in the message and in every
 * history line the model reads; the buffer keeps what they typed.
 *
 * `llm-turn.service.test.ts` pins the redaction as a decision; this pins the wiring — that the
 * lookup a caller puts on `TurnInput` is the one the model call actually redacts with.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { TranscriptLine } from "@badabhai/ai-contracts";

import {
  buildReplayWorld,
  SESSION,
  step,
  T0,
  turnInput,
} from "./testing/replay-world.test-support";

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

const TYPED = "Main Suresh Kumar hoon, tandoor pe kaam karta hoon";
const REDACTED = "Main [NAME] hoon, tandoor pe kaam karta hoon";

type Sent = { message_text: string; history: TranscriptLine[] };

describe("Phase A never sends the worker's own name (R32, ADR-0047 G2)", () => {
  it("the name typed on turn 1 is [NAME] in that turn's message and in the next turn's history", async () => {
    const world = buildReplayWorld({
      turns: [
        step({ stage: "domain", reply_text: "Aapki trade kya hai?" }),
        step({ stage: "role", reply_text: "Us kaam mein kya karte the?" }),
      ],
    });
    const knownName = vi.fn(async (): Promise<string | null> => "Suresh Kumar");

    await world.orchestrator.takeTurn({ ...turnInput(TYPED), knownName });
    await world.orchestrator.takeTurn({
      ...turnInput("roti aur naan", new Date(T0.getTime() + 1_000)),
      knownName,
    });

    const [first, second] = world.ai.llmTurn.mock.calls.map(([input]) => input as Sent);
    expect(first?.message_text).toBe(REDACTED);
    expect(second?.history.map((line) => line.text)).toContain(REDACTED);
    expect(JSON.stringify(world.ai.llmTurn.mock.calls)).not.toMatch(/suresh|kumar/i);
    // The request's copy only: the buffer holds the worker's own words.
    expect(world.store.get(SESSION)?.messages.map((m) => m.text)).toContain(TYPED);
  });

  it("a worker with no name on record is sent exactly as typed", async () => {
    const world = buildReplayWorld({ turns: [step({ reply_text: "Aapki trade kya hai?" })] });
    await world.orchestrator.takeTurn(turnInput(TYPED));
    expect((world.ai.llmTurn.mock.calls[0]?.[0] as Sent | undefined)?.message_text).toBe(TYPED);
  });
});
