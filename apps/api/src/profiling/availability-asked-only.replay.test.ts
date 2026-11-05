/**
 * ═══ AVAILABILITY IS ASKED, NEVER INFERRED IN PASSING (owner ruling 2026-11-04) ═══
 *
 * The 2026-11-02 production chat (qp_machining) closed `complete` without ever serving "Aap kaam
 * kab se shuru kar sakte hain?". A work-history answer on a Phase A turn — "lagbhag 8 mahine se
 * kaam kar raha hoon" — was read by the context-free availability parser as a notice period
 * ("lag…" is a notice cue), the cross-question fill settled the ask-once item with it, and the
 * engine never served the question.
 *
 * Replayed through a REAL `ProfilingOrchestrator` + REAL `LlmTurnService` over the live
 * `qp_universal@8`; only `AiService.llmTurn` is scripted.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { packFromCorpus } from "./form/corpus-pack.test-support";
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

const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

/** A generic answer for whatever the tail serves, so the walk reaches every question. */
function replyFor(questionKey: string | null): string {
  switch (questionKey) {
    case "primary_trade":
      return "machine operator";
    case "current_city":
      return "Pune";
    case "availability":
      return "Abhi turant";
    default:
      return "nahi";
  }
}

describe("availability is settled only by its own question", () => {
  it("a Phase A tenure ('lagbhag 8 mahine') does not answer it — the tail still asks it", async () => {
    const world = buildReplayWorld({
      universal: UNIVERSAL,
      turns: [
        // No trade labels: a named trade opens the trade-confirm gate, a different seam.
        step({ stage: "skills", reply_text: "Kaun si machine chalate hain?" }),
        step({ stage: "experience", reply_text: "Is kaam mein kitna samay hua?" }),
        step({ stage: "experience", phase_a_done: true }),
      ],
    });

    await world.orchestrator.takeTurn(turnInput("machine operator hoon"));
    await world.orchestrator.takeTurn(turnInput("lathe", at(1)));
    let result = await world.orchestrator.takeTurn(
      turnInput("lagbhag 8 mahine se kaam kar raha hoon", at(2)),
    );

    // The sentence was about his job, not his start: nothing is recorded for availability.
    expect(answerOf(world.store, "availability")).toBeUndefined();
    expect(answerOf(world.store, "notice_period_days")).toBeUndefined();

    // Walk the tail: the chip question is served, and only its own answer settles it.
    const served: (string | null)[] = [];
    for (let i = 0; i < 16 && result && !result.complete; i++) {
      served.push(result.questionKey);
      result = await world.orchestrator.takeTurn(turnInput(replyFor(result.questionKey), at(3 + i)));
    }
    expect(served).toContain("availability");
    expect(answerOf(world.store, "availability")).toMatchObject({
      status: "answered",
      value_normalized: "immediate",
    });
  });
});
