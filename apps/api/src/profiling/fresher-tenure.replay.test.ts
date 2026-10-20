/**
 * ═══ #2384 END-TO-END: TOTAL EXPERIENCE BEFORE WORK HISTORY, AND A FRESHER'S "0" ═══
 *
 * The device report of 2026-10-20, replayed through a REAL `ProfilingOrchestrator` + REAL
 * `LlmTurnService` over the live `qp_universal@8`: the model asked a software worker about
 * frameworks ("nahi"), and the worker's "0" to "Is kaam mein aapko kitne saal ho gaye?" was
 * re-served three times — after work history, which a fresher should never have been asked.
 *
 * Only `AiService.llmTurn` is scripted. Owner ruling 2026-10-20: the engine asks the total itself
 * before any work history; 0 is a fresher, accepted and never re-asked, and a fresher is asked no
 * work history at all; a worker with experience goes on to it as before, and their stated total
 * stands over the sum of the jobs they describe.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { packFromCorpus } from "./form/corpus-pack.test-support";
import { EXPERIENCE_GATE_PROMPT } from "./llm-turn.service";
import {
  buildReplayWorld,
  step,
  SESSION,
  T0,
  turnInput,
} from "./testing/replay-world.test-support";

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

const UNIVERSAL = packFromCorpus("qp_universal@8");
const TENURE_KEY = "experience_years";
const TENURE_PROMPT = UNIVERSAL.items.find((i) => i.question_key === TENURE_KEY)?.prompt_text;

function answerOf(
  store: Map<string, unknown>,
  key: string,
): { status: string; value_normalized: unknown } | undefined {
  const held = store.get(SESSION) as
    | {
        profiling?: {
          answerMap: readonly { question_key: string; status: string; value_normalized: unknown }[];
        };
      }
    | undefined;
  return held?.profiling?.answerMap.find((a) => a.question_key === key);
}

function assistantLines(store: Map<string, unknown>): string[] {
  const held = store.get(SESSION) as
    | { messages?: readonly { role: string; text: string }[] }
    | undefined;
  return (held?.messages ?? []).filter((m) => m.role === "assistant").map((m) => m.text);
}

const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

// NO trade labels on any step, deliberately: a named trade opens the engine's trade-confirm gate
// on that turn, a different seam from the one under test.
const SKILLS_TURN = step({
  stage: "skills",
  reply_text: "Spring Boot ke alawa aur koi framework use karte hain?",
});
const JOB_TURN = step({ stage: "experience", reply_text: "Aapne pehle kahan kaam kiya?" });

describe("#2384: the engine asks the total before any work history", () => {
  it("a fresher's '0' is captured once and ends Phase A — no job questions, no gate", async () => {
    const world = buildReplayWorld({ universal: UNIVERSAL, turns: [SKILLS_TURN, JOB_TURN] });

    await world.orchestrator.takeTurn(turnInput("software developer hoon"));
    // The model turns to work history; the engine puts the TOTAL on screen instead, as the
    // universal pack's own question.
    const asked = await world.orchestrator.takeTurn(turnInput("nahi", at(1)));
    expect(asked?.questionKey).toBe(TENURE_KEY);
    expect(asked?.reply).toBe(TENURE_PROMPT);

    const after = await world.orchestrator.takeTurn(turnInput("0", at(2)));

    // Captured, never re-served.
    expect(answerOf(world.store, TENURE_KEY)).toMatchObject({
      status: "answered",
      value_normalized: 0,
    });
    expect(after?.questionKey).not.toBe(TENURE_KEY);
    // Phase A closed without consulting the model again, and no work history was asked.
    expect(world.ai.llmTurn).toHaveBeenCalledTimes(2);
    expect(after?.reply).not.toBe(EXPERIENCE_GATE_PROMPT);
    expect(assistantLines(world.store)).not.toContain(JOB_TURN.reply_text);
    expect(assistantLines(world.store)).not.toContain(EXPERIENCE_GATE_PROMPT);
    // Asked exactly once in the whole interview.
    expect(assistantLines(world.store).filter((l) => l === TENURE_PROMPT)).toHaveLength(1);
  });

  it("'fresher hoon' is the same answer as '0'", async () => {
    const world = buildReplayWorld({ universal: UNIVERSAL, turns: [SKILLS_TURN, JOB_TURN] });

    await world.orchestrator.takeTurn(turnInput("software developer hoon"));
    await world.orchestrator.takeTurn(turnInput("nahi", at(1)));
    await world.orchestrator.takeTurn(turnInput("fresher hoon", at(2)));

    expect(answerOf(world.store, TENURE_KEY)?.value_normalized).toBe(0);
    expect(world.ai.llmTurn).toHaveBeenCalledTimes(2);
  });

  it("a worker with experience goes on to work history; the total is never asked again", async () => {
    const world = buildReplayWorld({
      universal: UNIVERSAL,
      turns: [
        SKILLS_TURN,
        JOB_TURN,
        // After "5", the model leads again and records a 3-year job — which names a trade, so
        // the engine's trade-confirm gate comes first (its own seam, unchanged here).
        step({
          stage: "experience",
          experience_entry: {
            role_label: "backend developer",
            duration_text: "3 saal",
            duration_months: 36,
            work_done: "APIs",
          },
        }),
        // After "Haan" to the trade, the model closes; the engine's experience gate follows.
        step({ stage: "experience", phase_a_done: true }),
      ],
    });

    await world.orchestrator.takeTurn(turnInput("software developer hoon"));
    await world.orchestrator.takeTurn(turnInput("nahi", at(1)));
    const job = await world.orchestrator.takeTurn(turnInput("5", at(2)));
    expect(answerOf(world.store, TENURE_KEY)?.value_normalized).toBe(5);
    // The model was consulted again: work history goes on for a worker with experience.
    expect(world.ai.llmTurn).toHaveBeenCalledTimes(3);
    expect(job?.questionKey).not.toBe(TENURE_KEY);

    // Work history runs exactly as before: the engine's own "another job?" gate is asked.
    const gate = await world.orchestrator.takeTurn(turnInput("Haan", at(3)));
    expect(gate?.reply).toBe(EXPERIENCE_GATE_PROMPT);

    const tail = await world.orchestrator.takeTurn(turnInput("Nahi", at(4)));

    // The stated 5 stands over the one job's 3 years, and the tail does not ask it again.
    expect(answerOf(world.store, TENURE_KEY)?.value_normalized).toBe(5);
    expect(tail?.questionKey).not.toBe(TENURE_KEY);
    expect(assistantLines(world.store).filter((l) => l === TENURE_PROMPT)).toHaveLength(1);
  });
});
