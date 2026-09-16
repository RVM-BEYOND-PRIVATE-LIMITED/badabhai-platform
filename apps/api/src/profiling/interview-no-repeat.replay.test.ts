/**
 * ═══ #1505 END-TO-END REPLAYS: THE OPENER-TOTAL/SUM RULING AND THE REPEAT GUARD ═══
 *
 * Six scripted interviews through a REAL `ProfilingOrchestrator` + REAL `LlmTurnService`
 * (`testing/replay-world.test-support.ts`), over the real `qp_universal@2` corpus. Only
 * `AiService.llmTurn` — the one HTTP seam `LlmTurnService` owns — is scripted; every decision
 * downstream of it (caps, the gate, `classifyLlmReply`, cross-fill, `settleFromLlmDraft`) runs
 * unmodified.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

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

function answerValue(store: Map<string, unknown>, key: string): unknown {
  const held = store.get(SESSION) as { profiling?: { answerMap: readonly { question_key: string; value_normalized: unknown }[] } } | undefined;
  return held?.profiling?.answerMap.find((a) => a.question_key === key)?.value_normalized;
}

function isSettled(store: Map<string, unknown>, key: string): boolean {
  const held = store.get(SESSION) as { profiling?: { answerMap: readonly { question_key: string; status: string }[] } } | undefined;
  return held?.profiling?.answerMap.some((a) => a.question_key === key && a.status === "answered") ?? false;
}

describe("#1505-1: the sum of resolved jobs ALWAYS wins over the opener's stated total", () => {
  it("opener states one total; two resolved job entries sum to a different one — the SUM wins", async () => {
    const world = buildReplayWorld({
      turns: [
        // Turn 1 (the opener reply): the model asks about the worker's domain — no entry yet.
        // NO `domain_label` HERE, deliberately: a label that matches `trade-form-router.ts`'s
        // occupation terms (e.g. "welding") hands the interview to the trade form on THIS turn,
        // which is a different seam entirely and would end Phase A before it ever reaches the
        // job entries this fixture is about.
        step({ stage: "domain", reply_text: "Aapki trade kya hai?" }),
        // Turn 2: the worker describes job 1 — a completed entry opens the gate immediately.
        // `role_label: "tandoor cook"` — NOT a `trade-form-router.ts` occupation term, for the
        // same reason turn 1's `domain_label` is left unset above.
        step({
          stage: "experience",
          experience_entry: {
            role_label: "tandoor cook",
            duration_text: "3 saal",
            duration_months: 36,
            work_done: "tandoor roti",
          },
        }),
        // Turn 3 ("Haan" closes the gate and falls through to the model for job 2 THIS turn):
        step({
          stage: "experience",
          experience_entry: {
            role_label: "kitchen helper",
            duration_text: "2 saal",
            duration_months: 24,
          },
        }),
        // Turn 4 answers the gate "Nahi" — no model call; branch 1 short-circuits.
      ],
    });

    // Turn 1 — the opener reply — states a TOTAL that must NOT be the final answer.
    await world.orchestrator.takeTurn(turnInput("Maine total 10 saal kaam kiya hai"));
    // Cross-filled from the opener turn: `crossFillItems`'s `phaseALeads` exclusion does not
    // cover turn 1 (`isOpenerReplyTurn`), so this DOES land — and is what must be overridden.
    expect(answerValue(world.store, "experience_years")).toBe(10);

    // Turn 2 — job 1. The worker's own sentence must NOT cross-fill a competing experience_years
    // (a per-job model question is on screen: `phaseALeads` is true here).
    await world.orchestrator.takeTurn(turnInput("Welder tha, teen saal", new Date(T0.getTime() + 1000)));

    // Turn 3 — "Haan", job 2.
    await world.orchestrator.takeTurn(turnInput("Haan, fitter bhi tha do saal", new Date(T0.getTime() + 2000)));

    // Turn 4 — "Nahi" closes Phase A; `settleFromLlmDraft` runs THIS turn.
    await world.orchestrator.takeTurn(turnInput("Nahi", new Date(T0.getTime() + 3000)));

    // THE RULING: sum of resolved jobs (36 + 24 months = 5 years) OVERRIDES the opener's "10".
    expect(answerValue(world.store, "experience_years")).toBe(5);
    expect(isSettled(world.store, "experience_years")).toBe(true);
  });
});

describe("#1505 F5: the model's own gate-shaped or repeated line is never served", () => {
  it("a gate-shaped line with ZERO entries recorded ends Phase A to the deterministic tail — the model's line is never served", async () => {
    const world = buildReplayWorld({
      turns: [
        // The opener-reply turn: the model writes the engine's OWN gate, in its own words, and
        // reports no entry at all — #1016's exact failure shape, one layer down.
        step({ stage: "domain", experience_entry: null, reply_text: "Koi aur kaam bhi kiya hai?" }),
      ],
    });

    const result = await world.orchestrator.takeTurn(turnInput("Namaste"));

    // NEVER the model's own words, and never `EXPERIENCE_GATE_PROMPT` either — there is no job to
    // offer "another" of. Phase A ends to the deterministic tail, in the SAME response.
    expect(result.reply).not.toBe("Koi aur kaam bhi kiya hai?");
    expect(result.kind).toBe("ask");
    expect(result.questionKey).not.toBeNull();
    expect(world.store.get(SESSION)?.profiling?.llmStage).toBe("done");
  });

  it("the model repeating its OWN previous line (zero entries so far) also ends Phase A to the tail", async () => {
    const world = buildReplayWorld({
      turns: [
        step({ stage: "domain", reply_text: "Aap kaunsi cuisine banate hain?" }),
        // Exact repeat of the line above, no entry recorded either time.
        step({ stage: "domain", reply_text: "Aap kaunsi cuisine banate hain?" }),
      ],
    });

    const first = await world.orchestrator.takeTurn(turnInput("cook hu"));
    expect(first).toMatchObject({ kind: "ask", reply: "Aap kaunsi cuisine banate hain?" });

    const second = await world.orchestrator.takeTurn(
      turnInput("north indian", new Date(T0.getTime() + 1000)),
    );
    expect(second.reply).not.toBe("Aap kaunsi cuisine banate hain?");
    expect(second.kind).toBe("ask");
    expect(world.store.get(SESSION)?.profiling?.llmStage).toBe("done");
  });

  /**
   * CRITIQUE-5'S DEMANDED FIXTURE. A boundary-scoped repeat comparator (only against lines AFTER
   * the last `EXPERIENCE_GATE_PROMPT`) would MISS this: the repeated line sits BEFORE the gate in
   * the transcript. `classifyLlmReply` compares against the FULL history by default, so it is
   * caught regardless of where the gate fell.
   */
  it("a PRE-gate question repeated AFTER job 1's gate is caught — the full-history comparison, not a boundary-scoped one", async () => {
    const world = buildReplayWorld({
      turns: [
        // Turn 1: an ordinary pre-gate question.
        step({ stage: "skills", reply_text: "Aap kaunsi skills jaante hain is kaam mein?" }),
        // Turn 2: the worker's answer resolves job 1 — the ENGINE serves its own gate here
        // (branch 3), so the model's `reply_text` on this turn is irrelevant and discarded either
        // way; what matters is the entry landing in the draft.
        step({
          stage: "experience",
          experience_entry: {
            role_label: "tandoor cook",
            duration_text: "3 saal",
            duration_months: 36,
          },
        }),
        // Turn 3: "Haan" closes the gate and falls through to the model — which RE-ASKS THE
        // TURN-1 SKILLS QUESTION verbatim, instead of asking about job 2.
        step({ stage: "skills", reply_text: "Aap kaunsi skills jaante hain is kaam mein?" }),
      ],
    });

    await world.orchestrator.takeTurn(turnInput("cook hu"));
    const gate = await world.orchestrator.takeTurn(
      turnInput("tandoor cook tha teen saal", new Date(T0.getTime() + 1000)),
    );
    expect(gate.reply).toBe("Aur koi experience jodna hai?");

    const third = await world.orchestrator.takeTurn(
      turnInput("Haan", new Date(T0.getTime() + 2000)),
    );
    // The repeated pre-gate line is never served — `llmGateAsked` is already true (set on turn 2),
    // so the guard's fallback is `done`, not the engine's own gate a second time.
    expect(third.reply).not.toBe("Aap kaunsi skills jaante hain is kaam mein?");
    expect(world.store.get(SESSION)?.profiling?.llmStage).toBe("done");
  });
});

describe("#1505 F1: cross-fill drops pages-owned facts unconditionally, even on the opener turn", () => {
  it("a composite opener mentioning salary AND city: salary never lands, city does", async () => {
    // Phase A disabled — this fixture is about `fillCrossQuestion`/`crossFillItems`, which run
    // BEFORE Phase A is ever consulted, so nothing here depends on a scripted model turn.
    const world = buildReplayWorld({ enabled: false });

    await world.orchestrator.takeTurn(
      turnInput("Mumbai mein rehta hoon, 25000 chahiye salary"),
    );

    expect(answerValue(world.store, "salary_expected")).toBeUndefined();
    expect(isSettled(world.store, "salary_expected")).toBe(false);
    expect(answerValue(world.store, "current_city")).toBe("Mumbai");
  });
});

describe("#1505 F3: the RI-5 confirm bubble only ever lists chat-owned facts", () => {
  it("a résumé offer with education + salary + city suggestions lists only city", async () => {
    const suggestions = new Map([
      [
        "current_city",
        { values: { option_keys: [], text: "Mumbai", number: null, bool: null }, source: "resume" as const, confidence: 0.9 },
      ],
      [
        "salary_expected",
        { values: { option_keys: [], text: null, number: 25000, bool: null }, source: "resume" as const, confidence: 0.9 },
      ],
      [
        "education",
        { values: { option_keys: ["tenth"], text: null, number: null, bool: null }, source: "resume" as const, confidence: 0.9 },
      ],
    ]);
    const world = buildReplayWorld({
      enabled: false,
      resumeSuggestions: {
        pendingForChat: async () => ({ importId: "import-1", suggestions }),
        forImport: async () => suggestions,
      },
    });

    const result = await world.orchestrator.takeTurn(turnInput("Namaste"));

    expect(result.reply).toContain("Mumbai");
    // Neither the salary figure nor the education option's label ever reach the bubble — both
    // facts are pages-owned and `chatServableItems` drops them before `confirmableFacts` runs.
    expect(result.reply).not.toContain("25000");
    expect(result.reply).not.toContain("Dasvi");
  });
});
