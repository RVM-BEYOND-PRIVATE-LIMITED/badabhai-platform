/**
 * `SkillsTurnService` — one turn of the general road's skills stage (ADR-0045 §3.2, §6).
 *
 * WHAT THESE TESTS ARE FOR. The service decides ONE thing — what the skills stage puts on screen
 * this turn — and every risk it carries is control flow, not the model:
 *
 *   1. SPEND. A model told to stop after sixteen questions cannot count to sixteen, and a worker
 *      who has said "bas" must not buy a model call to learn it. Every cap, the stop and the gate
 *      are read BEFORE the call; a call that happened is ledgered whether or not it was usable.
 *   2. TERMINATION. The gate is ours, not the model's. It is served on the API's decision (the
 *      caps, the stale count, the model's advice, a gate-shaped reply), it is bounded to four
 *      rounds, and a stage with nothing gathered skips it for the form.
 *   3. PRIVACY. Nothing reaches the gate, the chips or `general_road` without passing the API's
 *      certifier, grounded in the worker's words on THIS turn; and nothing a worker said or a
 *      model returned ever reaches a log line.
 *
 * All of it is asserted against a stubbed `AiService`, because what is under test is the branch
 * taken, never the model's judgement.
 */
import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { LlmTurnInput, TranscriptLine } from "@badabhai/ai-contracts";

import { fakeAiTraceRecorder } from "../ai/ai-trace-recorder.fake";
import {
  emptyGeneralRoad,
  emptyProfilingEnvelope,
  type GeneralRoadState,
  type ProfilingEnvelope,
} from "./conversation-state";
import { MAX_SKILLS } from "./skill-certifier";
import { SKILLS_ADD_PROMPT, SKILLS_GATE_QUESTION, skillsGatePrompt } from "./skills-gate";
import {
  MAX_SKILL_CANDIDATES_PER_TURN,
  MAX_SKILLS_ASKS,
  MAX_SKILLS_GATE_ROUNDS,
  MAX_STALE_SKILL_TURNS,
  SkillsTurnService,
} from "./skills-turn.service";

const CTX = {
  workerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  correlationId: "44444444-4444-4444-8444-444444444444",
  requestId: "req_1",
};

/** The settled, certified role the lane was entered with. */
const ROLE = "Graphic Designer";
const DOMAIN = "Design";

/** Two certified skills already on the stage — the ordinary mid-stage state. */
const HELD = ["Tally", "CorelDRAW"] as const;

/** A model question the reply guard passes (`ok`): it asks WHICH, not WHETHER. */
const QUESTION = "Kaunsa software chalate hain?";

const META = {
  ai_call_id: "77777777-7777-4777-8777-777777777777",
  task_type: "profiling_chat_turn",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: true,
  input_tokens: 640,
  output_tokens: 88,
  estimated_cost_inr: 0.11,
  latency_ms: 2100,
  success: true,
  created_at: "2026-09-26T05:04:02.270Z",
};

/** An `LlmTurnOutput`-shaped model reply: an ordinary skills question that found nothing. */
const TURN = (over: Record<string, unknown> = {}) => ({
  reply_text: QUESTION,
  stage: "skills",
  input_mode: "text",
  suggested_answers: [],
  domain_label: null,
  role_label: null,
  skills: [],
  experience_entry: null,
  phase_a_done: false,
  blocked: false,
  blocked_reason: null,
  is_mock: false,
  ai_metadata: null,
  ...over,
});

function make(over: { turn?: unknown; general?: unknown; interview?: unknown } = {}) {
  // Typed to TAKE its arguments so `mock.calls[0][0]` is assertable (see llm-turn.service.test).
  const ai = {
    llmTurn: vi.fn(async (_input: unknown, _ctx?: unknown) =>
      "turn" in over ? over.turn : TURN(),
    ),
  };
  const config = {
    CHAT_GENERAL_ROAD_ENABLED: "general" in over ? over.general : true,
    CHAT_LLM_INTERVIEW_ENABLED: "interview" in over ? over.interview : true,
  };
  const cost = { record: vi.fn(async (..._args: unknown[]) => undefined) };
  const traces = fakeAiTraceRecorder();
  const svc = new SkillsTurnService(ai as never, config as never, cost as never, traces.recorder);
  return { svc, ai, cost, traces };
}

/** An armed session on the skills lane — the state the orchestrator hands this service. */
const road = (over: Partial<GeneralRoadState> = {}): GeneralRoadState => ({
  ...emptyGeneralRoad(),
  armed: true,
  lane: "skills",
  laneReason: "outside_declared_roles",
  roleLabel: ROLE,
  domainLabel: DOMAIN,
  ...over,
});

const env = (over: Partial<GeneralRoadState> = {}): ProfilingEnvelope => ({
  ...emptyProfilingEnvelope(),
  generalRoad: road(over),
});

/** The gate on screen after `rounds` servings, over the held skills. */
const atGate = (over: Partial<GeneralRoadState> = {}): ProfilingEnvelope =>
  env({ skills: [...HELD], gateOpen: true, gateRounds: 1, ...over });

const MID = { entering: false } as const;
const ENTERING = { entering: true } as const;

/** The request the service sent on its first (only) call. */
function sent(ai: ReturnType<typeof make>["ai"]): LlmTurnInput {
  return ai.llmTurn.mock.calls[0]?.[0] as LlmTurnInput;
}

/** `n` distinct stored labels — held skills are never re-certified, so any text will do. */
const labels = (n: number): string[] => Array.from({ length: n }, (_, i) => `Held skill ${i}`);

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("armed() — both flags, read once when the envelope is created", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])("general=%s interview=%s → %s", (general, interview, want) => {
    const { svc, ai } = make({ general, interview });
    expect(svc.armed()).toBe(want);
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("is off for anything but a real `true` — a stray string or a missing key arms nothing", () => {
    // FAIL CLOSED: the config loader coerces, but this is the one stamp that moves a worker
    // between roads, so it reads `=== true` and never truthiness.
    expect(make({ general: "true", interview: true }).svc.armed()).toBe(false);
    expect(make({ general: true, interview: 1 }).svc.armed()).toBe(false);
    expect(make({ general: undefined, interview: true }).svc.armed()).toBe(false);
  });
});

describe("the gate owns the turn when it is on screen", () => {
  it.each(["Nahi", "skills_gate_done", "bas itna hi"])(
    "%j closes the stage WITHOUT a model call — handover, confirmed",
    async (answer) => {
      const { svc, ai, cost, traces } = make();
      const out = await svc.take(atGate({ gateRounds: 2 }), answer, [], CTX, MID);

      expect(out).toMatchObject({
        kind: "handover",
        outcome: "confirmed",
        gateReply: "done",
        // The round ANSWERED — the one the gate was on screen for — for the event.
        gateRound: 2,
      });
      expect(out.road).toMatchObject({ gateOpen: false, outcome: "confirmed", gateRounds: 2 });
      expect(out.road.skills).toEqual(HELD);
      expect(ai.llmTurn).not.toHaveBeenCalled();
      expect(cost.record).not.toHaveBeenCalled();
      expect(traces.captured).toHaveLength(0);
    },
  );

  it.each(["Haan", "skills_gate_add"])(
    "%j goes back to the stage in the SAME turn, and is not an answer that can be stale",
    async (answer) => {
      // `staleTurns: 1` is the load-bearing seed: one more stale answer would end the stage, so a
      // "haan" counted as stale would show the gate straight back instead of a question. A gate
      // answer starts a FRESH window (review, Phase 2b), so the count comes back to 0.
      const { svc, ai } = make();
      const out = await svc.take(atGate({ staleTurns: 1, skillsAsks: 5 }), answer, [], CTX, MID);

      expect(ai.llmTurn).toHaveBeenCalledTimes(1);
      expect(sent(ai).message_text).toBe(answer);
      expect(out).toMatchObject({ kind: "ask", reply: QUESTION, gateReply: "add", gateRound: 1 });
      expect(out.road).toMatchObject({ gateOpen: false, staleTurns: 0, skillsAsks: 6 });
    },
  );

  it("a yes with a skill after it is still `add`, and the skill it names is kept", async () => {
    // The reader said yes first; the words after it are still the worker's own, so the skill they
    // name is grounded in this turn and lands — the reply stays `add`, not `typed`.
    const { svc } = make({ turn: TURN({ skills: ["Illustrator"] }) });
    const out = await svc.take(atGate(), "haan Illustrator bhi", [], CTX, MID);

    expect(out).toMatchObject({ kind: "ask", gateReply: "add" });
    expect(out.road.skills).toEqual([...HELD, "Illustrator"]);
    expect(out.road.staleTurns).toBe(0);
  });

  it("a skill typed at the gate is read by the model and lands as `typed`", async () => {
    const { svc, ai } = make({ turn: TURN({ skills: ["Photoshop"] }) });
    const out = await svc.take(atGate({ staleTurns: 1 }), "Photoshop bhi", [], CTX, MID);

    expect(ai.llmTurn).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ kind: "ask", gateReply: "typed", gateRound: 1 });
    expect(out.road.skills).toEqual([...HELD, "Photoshop"]);
    expect(out.road).toMatchObject({ gateOpen: false, staleTurns: 0 });
  });

  it("a reply that names no skill is `unclear` — a Nahi, counted apart (§6)", async () => {
    const { svc, ai, cost } = make();
    const out = await svc.take(atGate({ skillsAsks: 7 }), "kal batata hoon", [], CTX, MID);

    // The model WAS asked — only it can say whether the reply was a skill — and that is billed.
    expect(ai.llmTurn).toHaveBeenCalledTimes(1);
    expect(cost.record).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({
      kind: "handover",
      outcome: "confirmed",
      gateReply: "unclear",
      gateRound: 1,
    });
    expect(out.road).toMatchObject({ gateOpen: false, outcome: "confirmed", skillsAsks: 8 });
  });

  it("a typed reply whose only skill is refused, or already held, is `unclear` too", async () => {
    // Refused: the model's "Photoshop" is nowhere in "Excel bhi" (and "Excel" is not returned).
    const refused = make({ turn: TURN({ skills: ["Photoshop"] }) });
    const a = await refused.svc.take(atGate({ rejectedCount: 1 }), "Excel bhi", [], CTX, MID);
    expect(a).toMatchObject({ kind: "handover", outcome: "confirmed", gateReply: "unclear" });
    expect(a.road.rejectedCount).toBe(2);

    // Held: "tally" is a skill, but not a NEW one — nothing was added, so nothing was answered.
    const held = make({ turn: TURN({ skills: ["tally"] }) });
    const b = await held.svc.take(atGate(), "tally bhi", [], CTX, MID);
    expect(b).toMatchObject({ kind: "handover", gateReply: "unclear" });
    expect(b.road.skills).toEqual(HELD);
    expect(b.road.rejectedCount).toBe(0);
  });
});

describe("a stop mid-stage — the worker has said they are done", () => {
  it.each(["bas", "aur kuch nahi", "बस", "that's all"])(
    "%j serves the gate over what is held, WITHOUT a model call",
    async (stop) => {
      const { svc, ai, cost, traces } = make();
      const out = await svc.take(
        env({ skills: [...HELD], gateRounds: 1, skillsAsks: 4 }),
        stop,
        [],
        CTX,
        MID,
      );

      expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt(HELD), gateReply: null });
      expect(out.road).toMatchObject({ gateOpen: true, gateRounds: 2, skillsAsks: 4 });
      expect(ai.llmTurn).not.toHaveBeenCalled();
      expect(cost.record).not.toHaveBeenCalled();
      expect(traces.captured).toHaveLength(0);
    },
  );

  it("with nothing gathered, skips the gate for the form — no_skills (§6)", async () => {
    // A bullet list of nothing followed by "any more?" is a question with no referent.
    const { svc, ai } = make();
    const out = await svc.take(env(), "bas", [], CTX, MID);

    expect(out).toMatchObject({ kind: "handover", outcome: "no_skills", gateReply: null });
    expect(out.road).toMatchObject({ gateOpen: false, outcome: "no_skills", gateRounds: 0 });
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("the ENTERING turn never reads its text as a stop — it is the role answer, harvested", async () => {
    // A role answer that happens to be a whole stop word must still be sent to the model; the
    // same text one turn later is the worker ending the list.
    const { svc, ai } = make();
    const out = await svc.take(env(), "bas", [], CTX, ENTERING);

    expect(ai.llmTurn).toHaveBeenCalledTimes(1);
    expect(sent(ai).message_text).toBe("bas");
    expect(out.kind).toBe("ask");
  });

  it("a sentence that merely CONTAINS a stop word is a skills answer, not a stop", async () => {
    const { svc, ai } = make();
    await svc.take(env({ skills: [...HELD] }), "Excel nahi aata, bas Tally", [], CTX, MID);
    expect(ai.llmTurn).toHaveBeenCalledTimes(1);
  });
});

describe("caps and the kill switch — checked BEFORE the call, so a runaway costs nothing", () => {
  it(`at ${MAX_SKILLS_ASKS} asks the stage goes to the gate without a call`, async () => {
    const { svc, ai, cost, traces } = make();
    const out = await svc.take(
      env({ skills: [...HELD], skillsAsks: MAX_SKILLS_ASKS }),
      "Illustrator bhi",
      [],
      CTX,
      MID,
    );

    expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt(HELD), gateReply: null });
    expect(out.road).toMatchObject({ gateOpen: true, gateRounds: 1, outcome: null });
    expect(ai.llmTurn).not.toHaveBeenCalled();
    expect(cost.record).not.toHaveBeenCalled();
    expect(traces.captured).toHaveLength(0);
  });

  it(`at ${MAX_SKILLS} skills the stage goes to the gate without a call`, async () => {
    const full = labels(MAX_SKILLS);
    const { svc, ai } = make();
    const out = await svc.take(env({ skills: full }), "Illustrator bhi", [], CTX, MID);

    expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt(full) });
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("at the ask cap with nothing gathered, hands over — capped, not no_skills", async () => {
    const { svc, ai } = make();
    const out = await svc.take(env({ skillsAsks: MAX_SKILLS_ASKS }), "kuch", [], CTX, MID);

    expect(out).toMatchObject({ kind: "handover", outcome: "capped", gateReply: null });
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("a reply TYPED at the gate under a cap cannot be read without the model — unclear", async () => {
    const { svc, ai } = make();
    const out = await svc.take(
      atGate({ skillsAsks: MAX_SKILLS_ASKS, gateRounds: 2 }),
      "Photoshop bhi",
      [],
      CTX,
      MID,
    );

    expect(out).toMatchObject({
      kind: "handover",
      outcome: "capped",
      gateReply: "unclear",
      gateRound: 2,
    });
    expect(out.road).toMatchObject({ gateOpen: false, outcome: "capped" });
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("a Haan at the gate under a cap spends no call, and is still recorded as `add`", async () => {
    const { svc, ai, cost } = make();
    const out = await svc.take(atGate({ skillsAsks: MAX_SKILLS_ASKS }), "Haan", [], CTX, MID);

    expect(out.gateReply).toBe("add");
    expect(out.gateRound).toBe(1);
    expect(ai.llmTurn).not.toHaveBeenCalled();
    expect(cost.record).not.toHaveBeenCalled();
  });

  describe("the kill switch — CHAT_LLM_INTERVIEW_ENABLED, read live on every turn", () => {
    // Armed at creation, switched off since: the stamp keeps the session on the road, and the
    // switch still stops the spend.
    it("with skills held, serves the gate and calls nothing", async () => {
      const { svc, ai, cost } = make({ interview: false });
      const out = await svc.take(env({ skills: [...HELD] }), "Illustrator bhi", [], CTX, MID);

      expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt(HELD) });
      expect(ai.llmTurn).not.toHaveBeenCalled();
      expect(cost.record).not.toHaveBeenCalled();
    });

    it("with nothing gathered, hands over — unavailable", async () => {
      const { svc, ai } = make({ interview: false });
      const out = await svc.take(env(), "Illustrator bhi", [], CTX, ENTERING);

      expect(out).toMatchObject({ kind: "handover", outcome: "unavailable" });
      expect(ai.llmTurn).not.toHaveBeenCalled();
    });

    it("a reply typed at the gate is unclear, and the stage hands over — unavailable", async () => {
      const { svc, ai } = make({ interview: false });
      const out = await svc.take(atGate(), "Photoshop bhi", [], CTX, MID);

      expect(out).toMatchObject({
        kind: "handover",
        outcome: "unavailable",
        gateReply: "unclear",
      });
      expect(ai.llmTurn).not.toHaveBeenCalled();
    });

    it("is a real `true` or nothing — a truthy string does not re-enable the spend", async () => {
      const { svc, ai } = make({ interview: "true" });
      await svc.take(env({ skills: [...HELD] }), "Illustrator bhi", [], CTX, MID);
      expect(ai.llmTurn).not.toHaveBeenCalled();
    });
  });
});

describe("the request — the skills_only mode, and only what this stage may echo", () => {
  it("sends the certified role and skills, and never an experience", async () => {
    const history: TranscriptLine[] = [
      { i: 0, role: "assistant", text: "Aap kya kaam karte hain?" },
      { i: 1, role: "worker", text: "Graphic designer hoon" },
    ];
    const { svc, ai } = make();
    await svc.take(env({ skills: [...HELD], skillsAsks: 3 }), "Illustrator bhi", history, CTX, MID);

    expect(sent(ai)).toEqual({
      schema_version: "oie.v1",
      worker_ref: CTX.workerId,
      stage: "skills",
      message_text: "Illustrator bhi",
      history,
      draft: {
        domain_label: DOMAIN,
        role_label: ROLE,
        skills: [...HELD],
        experiences: [],
      },
      experience_count: 0,
      force_close: false,
      interview_mode: "skills_only",
    });
    // A copy, not the caller's array — the request is built, never aliased.
    expect(sent(ai).history).not.toBe(history);
  });

  it("forwards the turn's correlation and request ids, so spend and trace name one call", async () => {
    const { svc, ai } = make();
    await svc.take(env(), "Illustrator", [], CTX, ENTERING);
    expect(ai.llmTurn.mock.calls[0]?.[1]).toEqual({
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
  });

  it.each([
    [0, false],
    [MAX_SKILLS_ASKS - 2, false],
    [MAX_SKILLS_ASKS - 1, true],
  ])("skillsAsks=%i → force_close %s", async (asks, want) => {
    const { svc, ai } = make();
    await svc.take(env({ skills: [...HELD], skillsAsks: asks }), "Illustrator", [], CTX, MID);
    expect(sent(ai).force_close).toBe(want);
  });

  it("the force_close turn harvests the answer, then goes to the gate whatever the model asked", async () => {
    // The far side is told "do not ask anything" on this turn; the API does not rely on it.
    const { svc } = make({ turn: TURN({ skills: ["Illustrator"], reply_text: QUESTION }) });
    const out = await svc.take(
      env({ skills: [...HELD], skillsAsks: MAX_SKILLS_ASKS - 1 }),
      "Illustrator bhi",
      [],
      CTX,
      MID,
    );

    const skills = [...HELD, "Illustrator"];
    expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt(skills) });
    expect(out.road).toMatchObject({ skills, skillsAsks: MAX_SKILLS_ASKS, gateOpen: true });
  });

  it("the force_close turn with nothing gathered hands over — capped", async () => {
    const { svc } = make();
    const out = await svc.take(env({ skillsAsks: MAX_SKILLS_ASKS - 1 }), "kuch", [], CTX, MID);
    expect(out).toMatchObject({ kind: "handover", outcome: "capped" });
  });
});

describe("the ledger — every call is a billable `profiling_chat_turn`", () => {
  it("records the spend and the trace, attributed to the worker and the session", async () => {
    const { svc, cost, traces } = make({ turn: TURN({ ai_metadata: META }) });
    await svc.take(env(), "Illustrator", [], CTX, ENTERING);

    expect(cost.record).toHaveBeenCalledTimes(1);
    expect(cost.record).toHaveBeenCalledWith(
      META,
      "profiling_chat_turn",
      null,
      CTX.correlationId,
      CTX.requestId,
      { workerId: CTX.workerId, sessionId: CTX.sessionId },
    );
    expect(traces.stored).toHaveLength(1);
    expect(traces.stored[0]).toMatchObject({
      meta: META,
      taskType: "profiling_chat_turn",
      aiJobId: null,
      correlationId: CTX.correlationId,
      attribution: { workerId: CTX.workerId, sessionId: CTX.sessionId },
    });
  });

  it("still records a turn the model could not deliver — ledgered BEFORE the null check", async () => {
    const { svc, cost, traces } = make({ turn: null });
    await svc.take(env({ skills: [...HELD] }), "Illustrator", [], CTX, MID);

    expect(cost.record).toHaveBeenCalledWith(
      null,
      "profiling_chat_turn",
      null,
      CTX.correlationId,
      CTX.requestId,
      { workerId: CTX.workerId, sessionId: CTX.sessionId },
    );
    expect(traces.captured).toHaveLength(1);
    expect(traces.captured[0]).toMatchObject({
      taskType: "profiling_chat_turn",
      correlationId: CTX.correlationId,
      outcome: "no_metadata",
    });
  });
});

describe("the model is unavailable — the lane has no engine to fall back to", () => {
  it("with skills held, the stage ends at the gate; the question that never came is not counted", async () => {
    const { svc } = make({ turn: null });
    const out = await svc.take(
      env({ skills: [...HELD], skillsAsks: 4, staleTurns: 1 }),
      "Illustrator",
      [],
      CTX,
      MID,
    );

    expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt(HELD), gateReply: null });
    expect(out.road).toMatchObject({
      gateOpen: true,
      gateRounds: 1,
      skillsAsks: 4,
      // Every gate restarts the stale window.
      staleTurns: 0,
      outcome: null,
    });
  });

  it("with nothing gathered, hands over — unavailable", async () => {
    const { svc } = make({ turn: null });
    const out = await svc.take(env(), "Illustrator", [], CTX, ENTERING);
    expect(out).toMatchObject({ kind: "handover", outcome: "unavailable", gateReply: null });
    expect(out.road.outcome).toBe("unavailable");
  });

  it("a reply typed at the gate is unclear, and the stage hands over — unavailable", async () => {
    const { svc } = make({ turn: null });
    const out = await svc.take(atGate(), "Photoshop bhi", [], CTX, MID);
    expect(out).toMatchObject({ kind: "handover", outcome: "unavailable", gateReply: "unclear" });
  });
});

describe("certification — the API's wall, grounded in THIS turn's words", () => {
  it("keeps what the worker said, refuses what they did not, and counts the refusal", async () => {
    const { svc } = make({ turn: TURN({ skills: ["Illustrator", "Photoshop"] }) });
    const out = await svc.take(
      env({ skills: [...HELD], rejectedCount: 2 }),
      "Illustrator pe kaam karta hoon",
      [],
      CTX,
      MID,
    );

    expect(out.kind).toBe("ask");
    expect(out.road.skills).toEqual([...HELD, "Illustrator"]);
    // A COUNT, never the text — and it accumulates across the stage.
    expect(out.road.rejectedCount).toBe(3);
  });

  it("refuses identifiers and contact routes even when the worker typed them", async () => {
    const { svc } = make({
      turn: TURN({ skills: ["Tally 9876543210", "ramesh@gmail.com", "Illustrator"] }),
    });
    const out = await svc.take(
      env(),
      "Illustrator, Tally 9876543210, ramesh@gmail.com",
      [],
      CTX,
      ENTERING,
    );

    expect(out.road.skills).toEqual(["Illustrator"]);
    expect(out.road.rejectedCount).toBe(2);
  });

  it("refuses the role itself — what he is, not what he can do", async () => {
    const { svc } = make({ turn: TURN({ skills: [ROLE, DOMAIN] }) });
    const out = await svc.take(
      env(),
      "Graphic Designer hoon, design karta hoon",
      [],
      CTX,
      ENTERING,
    );
    expect(out.road.skills).toEqual([]);
    expect(out.road.rejectedCount).toBe(2);
  });

  it("grounds in the latest message ONLY — a skill heard turns ago is not a licence now", async () => {
    // The history mentions Photoshop; this turn does not. A model re-returning it is refused.
    const history: TranscriptLine[] = [
      { i: 0, role: "worker", text: "Photoshop bhi aata hai" },
      { i: 1, role: "assistant", text: QUESTION },
    ];
    const { svc } = make({ turn: TURN({ skills: ["Photoshop"], reply_text: "Aur kaunsa tool?" }) });
    const out = await svc.take(env({ skills: [...HELD] }), "aur kya bataun", history, CTX, MID);

    expect(out.road.skills).toEqual(HELD);
    expect(out.road.rejectedCount).toBe(1);
  });

  it("an already-held skill is a duplicate, not a refusal, and adds nothing", async () => {
    const { svc } = make({ turn: TURN({ skills: ["tally", "CORELDRAW"] }) });
    const out = await svc.take(env({ skills: [...HELD] }), "tally aur coreldraw", [], CTX, MID);
    expect(out.road.skills).toEqual(HELD);
    expect(out.road.rejectedCount).toBe(0);
    expect(out.road.staleTurns).toBe(1);
  });

  it(`reads at most ${MAX_SKILL_CANDIDATES_PER_TURN} candidates — the contract's list is unbounded`, async () => {
    // Twelve grounded, then three that would be REFUSED (none is in the message). Bounded first,
    // so the tail costs nothing: not kept, and not even counted as a refusal.
    const grounded = [
      "Tally",
      "Excel",
      "Photoshop",
      "CorelDRAW",
      "Illustrator",
      "InDesign",
      "AutoCAD",
      "Revit",
      "SketchUp",
      "Canva",
      "Figma",
      "Blender",
    ];
    expect(grounded).toHaveLength(MAX_SKILL_CANDIDATES_PER_TURN);
    const tail = ["Maya", "Premiere", "Lightroom"];
    const { svc } = make({ turn: TURN({ skills: [...grounded, ...tail] }) });
    const out = await svc.take(env(), grounded.join(", "), [], CTX, ENTERING);

    expect(out.road.skills).toEqual(grounded);
    expect(out.road.rejectedCount).toBe(0);
  });

  it(`stops at ${MAX_SKILLS}: a skill left out for room ends the stage at the gate — capped`, async () => {
    const held = labels(MAX_SKILLS - 2);
    const { svc } = make({ turn: TURN({ skills: ["Illustrator", "Photoshop", "Figma"] }) });
    const out = await svc.take(
      env({ skills: held }),
      "Illustrator, Photoshop aur Figma",
      [],
      CTX,
      MID,
    );

    const skills = [...held, "Illustrator", "Photoshop"];
    expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt(skills) });
    expect(out.road.skills).toEqual(skills);
    expect(out.road.rejectedCount).toBe(0);
  });

  it("the gate is built only from certified skills — a refused one never reaches the bullets", async () => {
    const { svc } = make({
      turn: TURN({ skills: ["Illustrator", "Photoshop"], phase_a_done: true }),
    });
    const out = await svc.take(env({ skills: [...HELD] }), "Illustrator", [], CTX, MID);

    expect(out.kind).toBe("gate");
    const reply = out.kind === "gate" ? out.reply : "";
    expect(reply).toBe(skillsGatePrompt([...HELD, "Illustrator"]));
    expect(reply).not.toContain("Photoshop");
  });
});

describe("the stale count — two answers in a row with nothing new", () => {
  it(`a second empty answer (staleTurns → ${MAX_STALE_SKILL_TURNS}) ends the stage at the gate`, async () => {
    const { svc } = make();
    const out = await svc.take(
      env({ skills: [...HELD], staleTurns: 1 }),
      "pata nahi",
      [],
      CTX,
      MID,
    );

    expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt(HELD), gateReply: null });
    // The count reached the limit (that is WHY this is the gate) and restarts as the gate opens,
    // so the "Haan" that follows is asked a question instead of shown the gate again.
    expect(out.road.staleTurns).toBe(0);
  });

  it("REGRESSION (review 2b): after a stale-opened gate, Haan is asked WHICH skill — never the same gate", async () => {
    // Reached the natural way: two empty answers, then the gate.
    const { svc, ai } = make();
    const first = await svc.take(env({ skills: [...HELD] }), "pata nahi", [], CTX, MID);
    const gate = await svc.take(env(first.road), "yaad nahi", [], CTX, MID);
    expect(gate.kind).toBe("gate");

    const haan = await svc.take(env(gate.road), "Haan", [], CTX, MID);
    expect(haan).toMatchObject({ kind: "ask", gateReply: "add" });
    expect(ai.llmTurn).toHaveBeenCalledTimes(3);
  });

  it("a first empty answer is counted, and the stage carries on", async () => {
    const { svc } = make();
    const out = await svc.take(env({ skills: [...HELD] }), "pata nahi", [], CTX, MID);
    expect(out).toMatchObject({ kind: "ask", reply: QUESTION });
    expect(out.road.staleTurns).toBe(1);
  });

  it("stale with nothing gathered hands over — no_skills", async () => {
    const { svc } = make();
    const out = await svc.take(env({ staleTurns: 1 }), "pata nahi", [], CTX, MID);
    expect(out).toMatchObject({ kind: "handover", outcome: "no_skills" });
  });

  it("a new skill resets the count", async () => {
    const { svc } = make({ turn: TURN({ skills: ["Figma"] }) });
    const out = await svc.take(env({ skills: [...HELD], staleTurns: 1 }), "Figma", [], CTX, MID);
    expect(out.kind).toBe("ask");
    expect(out.road.staleTurns).toBe(0);
  });

  it("the ENTERING turn's role answer is not a skills answer — it cannot be stale", async () => {
    // "main graphic designer hoon" names no skill, and was never asked to: it answered Phase A's
    // role question. Counted, it would leave the worker ONE empty skills answer before the form
    // instead of the two ADR-0045 §6 promises.
    const { svc } = make();
    const out = await svc.take(env(), "main graphic designer hoon", [], CTX, ENTERING);
    expect(out).toMatchObject({ kind: "ask", reply: QUESTION });
    expect(out.road).toMatchObject({ staleTurns: 0, skillsAsks: 1 });
  });

  it("so a worker whose role answer named no skill still gets two empty answers, not one", async () => {
    // The consequence, over three turns: role answer → first skills answer (nothing certifiable)
    // → the stage must still be ASKING. Only the second empty skills answer ends it.
    const { svc } = make();
    const entered = await svc.take(env(), "main graphic designer hoon", [], CTX, ENTERING);
    const first = await svc.take(env(entered.road), "pata nahi", [], CTX, MID);
    expect(first.kind).toBe("ask");
    const second = await svc.take(env(first.road), "pata nahi", [], CTX, MID);
    expect(second).toMatchObject({ kind: "handover", outcome: "no_skills" });
  });
});

describe("ending the stage — the model advises, the API decides", () => {
  it("phase_a_done ends the stage at the gate, with this turn's skill on it", async () => {
    const { svc } = make({ turn: TURN({ skills: ["Figma"], phase_a_done: true }) });
    const out = await svc.take(env({ skills: [...HELD] }), "Figma bhi", [], CTX, MID);

    const skills = [...HELD, "Figma"];
    expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt(skills), gateReply: null });
    expect(out.road).toMatchObject({ skills, gateOpen: true, gateRounds: 1, skillsAsks: 1 });
  });

  it("phase_a_done with nothing gathered hands over — no_skills", async () => {
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    const out = await svc.take(env(), "main graphic designer hoon", [], CTX, ENTERING);
    expect(out).toMatchObject({ kind: "handover", outcome: "no_skills" });
  });

  it.each(["Aur koi skill hai?", SKILLS_GATE_QUESTION, "Kaunsa software? Koi aur skill bhi hai?"])(
    "a model reply shaped like the gate (%j) is replaced by the REAL gate",
    async (reply_text) => {
      const { svc } = make({ turn: TURN({ reply_text, skills: ["Figma"] }) });
      const out = await svc.take(env({ skills: [...HELD] }), "Figma", [], CTX, MID);

      expect(out).toMatchObject({ kind: "gate", reply: skillsGatePrompt([...HELD, "Figma"]) });
    },
  );

  it("a model reply that repeats an earlier question is not served — the gate is", async () => {
    const history: TranscriptLine[] = [
      { i: 0, role: "assistant", text: QUESTION },
      { i: 1, role: "worker", text: "Tally" },
    ];
    const { svc } = make({ turn: TURN({ reply_text: QUESTION, skills: ["Figma"] }) });
    const out = await svc.take(env({ skills: [...HELD] }), "Figma", history, CTX, MID);
    expect(out.kind).toBe("gate");
  });

  it("a WHICH question is the stage doing its job — served, not replaced", async () => {
    const reply_text = "Aur kaunsi skill aati hai?";
    const { svc } = make({ turn: TURN({ reply_text, skills: ["Figma"] }) });
    const out = await svc.take(env({ skills: [...HELD] }), "Figma", [], CTX, MID);
    expect(out).toMatchObject({ kind: "ask", reply: reply_text });
  });
});

describe(`the gate is bounded — ${MAX_SKILLS_GATE_ROUNDS} rounds, then the form`, () => {
  it(`round ${MAX_SKILLS_GATE_ROUNDS} is still served`, async () => {
    const { svc } = make();
    const out = await svc.take(
      env({ skills: [...HELD], gateRounds: MAX_SKILLS_GATE_ROUNDS - 1 }),
      "bas",
      [],
      CTX,
      MID,
    );
    expect(out.kind).toBe("gate");
    expect(out.road.gateRounds).toBe(MAX_SKILLS_GATE_ROUNDS);
  });

  it("the would-be next gate hands over instead — capped", async () => {
    const { svc } = make();
    const out = await svc.take(
      env({ skills: [...HELD], gateRounds: MAX_SKILLS_GATE_ROUNDS }),
      "bas",
      [],
      CTX,
      MID,
    );
    expect(out).toMatchObject({ kind: "handover", outcome: "capped", gateReply: null });
    expect(out.road).toMatchObject({ gateOpen: false, gateRounds: MAX_SKILLS_GATE_ROUNDS });
  });

  it("a Haan at the last round is still ASKED which skill, whatever the model reports", async () => {
    // "Haan" names nothing, so `phase_a_done` cannot end the stage on this turn: the worker said
    // they want to add more and must be asked what.
    const { svc, ai } = make({ turn: TURN({ phase_a_done: true }) });
    const out = await svc.take(
      atGate({ gateRounds: MAX_SKILLS_GATE_ROUNDS }),
      "Haan",
      [],
      CTX,
      MID,
    );

    expect(ai.llmTurn).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ kind: "ask", gateReply: "add", gateRound: MAX_SKILLS_GATE_ROUNDS });
  });

  it("past the last round, the next would-be gate hands over as capped", async () => {
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    const out = await svc.take(
      env({ skills: [...HELD], gateRounds: MAX_SKILLS_GATE_ROUNDS }),
      "Photoshop",
      [],
      CTX,
      MID,
    );
    expect(out).toMatchObject({ kind: "handover", outcome: "capped" });
  });
});

describe("chips — an offer the worker may tap, so each passes the same wall", () => {
  it("are certified labels, never one held or repeated, at most four", async () => {
    const { svc } = make({
      turn: TURN({
        skills: ["Figma"],
        suggested_answers: [
          "Figma", // landed on THIS turn — held now
          "tally", // held before
          "Kuch nahi", // generic
          "9876543210", // an identifier
          "- Photoshop.", // debris, cleaned
          "photoshop", // the same skill again
          "InDesign",
          "Canva",
          "Blender",
        ],
      }),
    });
    const out = await svc.take(env({ skills: [...HELD] }), "Figma", [], CTX, MID);

    expect(out.kind).toBe("ask");
    const chips = out.kind === "ask" ? out.chips : [];
    expect(chips).toEqual(["Photoshop", "InDesign", "Canva"]);
  });

  it("never more than four, whatever the model sends", async () => {
    const { svc } = make({
      turn: TURN({
        suggested_answers: ["Photoshop", "InDesign", "Canva", "Blender", "Figma", "Revit"],
      }),
    });
    const out = await svc.take(env({ skills: [...HELD] }), "kuch aur", [], CTX, MID);
    expect(out.kind === "ask" ? out.chips : null).toEqual([
      "Photoshop",
      "InDesign",
      "Canva",
      "Blender",
    ]);
  });
});

describe("the turn is pure over its input", () => {
  it("never mutates the envelope it was handed — the orchestrator folds `road` in itself", async () => {
    const frozenSkills = Object.freeze([...HELD]);
    const generalRoad = Object.freeze(
      road({ skills: frozenSkills, gateOpen: true, gateRounds: 1 }),
    );
    const envelope = Object.freeze({ ...emptyProfilingEnvelope(), generalRoad });
    const { svc } = make({ turn: TURN({ skills: ["Figma"] }) });

    const out = await svc.take(envelope, "Figma bhi", [], CTX, MID);

    expect(out.road).not.toBe(generalRoad);
    expect(generalRoad).toMatchObject({ skills: HELD, gateOpen: true, gateRounds: 1 });
  });
});

describe("privacy — counts in the logs, never a word", () => {
  it("no log line carries a skill, a chip, a reply or the worker's text", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    const verbose = vi.spyOn(Logger.prototype, "verbose").mockImplementation(() => undefined);

    const workerText = "Illustrator aur Photoshop, mera number 9876543210, ramesh@gmail.com";
    const secrets = [
      workerText,
      "Illustrator",
      "Photoshop",
      "9876543210",
      "ramesh@gmail.com",
      "Kaunsa brush",
      "Canva",
      ...HELD,
      ROLE,
    ];

    // A turn with refusals (the only `log` line), then a turn the model could not deliver (the
    // only `warn` line) — both paths that write a line at all.
    const refusing = make({
      turn: TURN({
        reply_text: "Kaunsa brush tool chalate hain?",
        skills: ["Illustrator", "9876543210", "ramesh@gmail.com", "Figma"],
        suggested_answers: ["Canva"],
      }),
    });
    await refusing.svc.take(env({ skills: [...HELD] }), workerText, [], CTX, MID);
    const unavailable = make({ turn: null });
    await unavailable.svc.take(env({ skills: [...HELD] }), workerText, [], CTX, MID);

    const lines = [log, warn, error, debug, verbose].flatMap((spy) =>
      spy.mock.calls.map((args) => JSON.stringify(args)),
    );
    // The two lines exist — so the scan below reads something rather than passing on silence.
    expect(log).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    for (const line of lines) {
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });
});

describe("review 2b — a gate answer is never answered with the same gate", () => {
  it("the prompt-mandated follow-up is served even when it repeats an earlier line", async () => {
    // Round 2: the model follows the prompt and asks "Kaunsi skill jodni hai?" — again. The repeat
    // guard would have re-served the gate; the worker who said Haan must be asked instead.
    const history = [
      { i: 0, role: "assistant" as const, text: SKILLS_ADD_PROMPT },
      { i: 1, role: "worker" as const, text: "Illustrator" },
    ];
    const { svc } = make({ turn: TURN({ reply_text: SKILLS_ADD_PROMPT }) });
    const out = await svc.take(atGate({ gateRounds: 2 }), "Haan", history, CTX, MID);
    expect(out).toMatchObject({ kind: "ask", reply: SKILLS_ADD_PROMPT, gateReply: "add" });
  });

  it("an unusable model reply after Haan becomes the engine's own which-skill prompt", async () => {
    const { svc } = make({ turn: TURN({ reply_text: "Kya aur koi skill jodni hai?" }) });
    const out = await svc.take(atGate(), "Haan", [], CTX, MID);
    expect(out).toMatchObject({ kind: "ask", reply: SKILLS_ADD_PROMPT, chips: [] });
  });

  it.each([
    ["at the ask cap", { skillsAsks: MAX_SKILLS_ASKS }, "capped"],
    [
      "one ask from the cap (no room for a question)",
      { skillsAsks: MAX_SKILLS_ASKS - 1 },
      "capped",
    ],
  ] as const)("a Haan %s hands over without a call", async (_what, seed, outcome) => {
    const { svc, ai } = make();
    const out = await svc.take(atGate(seed), "Haan", [], CTX, MID);
    expect(ai.llmTurn).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: "handover", outcome, gateReply: "add" });
  });

  it("a Haan with the kill switch off hands over as unavailable, not capped", async () => {
    const { svc, ai } = make({ interview: false });
    const out = await svc.take(atGate(), "Haan", [], CTX, MID);
    expect(ai.llmTurn).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: "handover", outcome: "unavailable", gateReply: "add" });
  });

  it("a Haan while the model is down hands over as unavailable — not the same gate again", async () => {
    const { svc } = make({ turn: null });
    const out = await svc.take(atGate(), "Haan", [], CTX, MID);
    expect(out).toMatchObject({ kind: "handover", outcome: "unavailable", gateReply: "add" });
  });
});

describe("review 2b — a bare 'nahi' mid-stage empties ONE area, it does not end the stage", () => {
  it.each(["nahi", "no", "koi nahi", "kuch nahi", "नहीं"])("%j goes to the model", async (text) => {
    const { svc, ai } = make();
    const out = await svc.take(env({ skills: [...HELD] }), text, [], CTX, MID);
    expect(ai.llmTurn).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe("ask");
  });

  it.each(["bas", "bas itna hi", "aur kuch nahi", "that's all"])(
    "%j still ends it with no call",
    async (text) => {
      const { svc, ai } = make();
      const out = await svc.take(env({ skills: [...HELD] }), text, [], CTX, MID);
      expect(ai.llmTurn).not.toHaveBeenCalled();
      expect(out.kind).toBe("gate");
    },
  );
});

describe("review 2b — a question off the skills topic is never served", () => {
  it.each([
    "Photoshop kitne saal se chala rahe hain?",
    "Is kaam mein kitna tajurba hai?",
    "Aapki expected salary kitni hai?",
    "Aap kis company mein kaam karte the?",
  ])("%j ends the stretch at the gate instead", async (reply) => {
    const { svc } = make({ turn: TURN({ reply_text: reply, skills: ["Figma"] }) });
    const out = await svc.take(env({ skills: [...HELD] }), "figma bhi", [], CTX, MID);
    expect(out.kind).toBe("gate");
  });

  it("a skills question that mentions experience is still served", async () => {
    const reply = "Kis software ka experience hai aapko?";
    const { svc } = make({ turn: TURN({ reply_text: reply }) });
    const out = await svc.take(env({ skills: [...HELD] }), "figma bhi", [], CTX, MID);
    expect(out).toMatchObject({ kind: "ask", reply });
  });
});

describe("review 2b — the role is never offered as a chip", () => {
  it("drops a chip equal to the role or domain label", async () => {
    const { svc } = make({
      turn: TURN({ suggested_answers: ["Graphic designer", "InDesign"] }),
    });
    const out = await svc.take(
      env({ skills: [...HELD], roleLabel: "Graphic designer" }),
      "figma",
      [],
      CTX,
      MID,
    );
    expect(out.kind === "ask" ? out.chips : []).toEqual(["InDesign"]);
  });
});
