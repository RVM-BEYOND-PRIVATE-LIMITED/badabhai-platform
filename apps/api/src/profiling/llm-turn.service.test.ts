/**
 * `LlmTurnService` — the caps, the loop gate, and the fallback.
 *
 * WHAT THESE TESTS ARE FOR. Two of the three risks the plan names live in this class. A model
 * that can extend its own interview spends an unbounded amount of a worker's time (risk 1), and a
 * model that goes away mid-conversation must hand the turn back rather than break it (the whole
 * reason the packs are kept). Both are asserted here against a stubbed `AiService`, because what
 * is under test is the CONTROL FLOW, not the model.
 */
import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "@nestjs/common";

import {
  LlmTurnService,
  MAX_LLM_ASKS,
  MAX_EXPERIENCE_ENTRIES,
  EXPERIENCE_GATE_KEY,
  EXPERIENCE_GATE_PROMPT,
} from "./llm-turn.service";
import { emptyProfilingEnvelope, type ProfilingEnvelope } from "./conversation-state";

const CTX = { workerId: "11111111-1111-4111-8111-111111111111" };

const TURN = (over: Record<string, unknown> = {}) => ({
  reply_text: "Aap kaunsi cuisine banate hain?",
  stage: "skills",
  input_mode: "text",
  suggested_answers: [],
  domain_label: "cooking",
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

const ENTRY = {
  role_label: "tandoor cook",
  duration_text: "3 saal",
  duration_months: 36,
  work_done: "naan, roti",
};

function make(over: { turn?: unknown; enabled?: boolean } = {}) {
  const ai = {
    llmTurn: vi.fn(async () => ("turn" in over ? over.turn : TURN())),
  };
  const config = { CHAT_LLM_INTERVIEW_ENABLED: over.enabled ?? true };
  const svc = new LlmTurnService(ai as never, config as never);
  return { svc, ai };
}

const env = (over: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope => ({
  ...emptyProfilingEnvelope(),
  phase: "llm_interview",
  ...over,
});

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

describe("the flag and the fallback", () => {
  it("does not call the model when the flag is off", async () => {
    const { svc, ai } = make({ enabled: false });
    expect(await svc.take(env(), "cook hu", [], CTX)).toBeNull();
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("does not call the model again once the interview has fallen back", async () => {
    // STICKY, on purpose. An interview that flips between an LLM voice and an authored one
    // every few turns reads as two different people talking to the worker.
    const { svc, ai } = make();
    expect(await svc.take(env({ llmFallback: true }), "cook hu", [], CTX)).toBeNull();
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("returns null when the model is unavailable, so the engine takes the turn", async () => {
    // `null` is every failure collapsed: down, 429, deadline, mock posture, blocked, malformed.
    const { svc } = make({ turn: null });
    expect(await svc.take(env(), "cook hu", [], CTX)).toBeNull();
  });
});

describe("the caps — the API owns termination, never the model", () => {
  it("forces the model to close once the ask cap is reached", async () => {
    const { svc, ai } = make();
    await svc.take(env({ llmAsks: MAX_LLM_ASKS }), "haan", [], CTX);
    expect(ai.llmTurn.mock.calls[0]?.[0]).toMatchObject({ force_close: true });
  });

  it("ends Phase A at the cap even when the model says it is not done", async () => {
    // The model reporting `phase_a_done: false` must NOT be able to keep the interview open.
    const { svc } = make({ turn: TURN({ phase_a_done: false }) });
    const out = await svc.take(env({ llmAsks: MAX_LLM_ASKS }), "haan", [], CTX);
    expect(out?.done).toBe(true);
  });

  it("ends Phase A once the experience cap is reached", async () => {
    const full = Array.from({ length: MAX_EXPERIENCE_ENTRIES }, () => ENTRY);
    const { svc } = make();
    const out = await svc.take(
      env({ llmDraft: { domain_label: null, role_label: null, skills: [], experiences: full } }),
      "aur bhi hai",
      [],
      CTX,
    );
    expect(out?.done).toBe(true);
  });

  it("honours the model's phase_a_done as advice when no cap has fired", async () => {
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    expect((await svc.take(env(), "bas", [], CTX))?.done).toBe(true);
  });
});

describe("the experience loop gate is engine-served", () => {
  it("serves the Yes/No gate with typing disabled after an experience is captured", async () => {
    const { svc } = make({ turn: TURN({ experience_entry: ENTRY }) });
    const out = await svc.take(env(), "3 saal tandoor pe", [], CTX);
    expect(out?.reply).toBe(EXPERIENCE_GATE_PROMPT);
    expect(out?.questionKey).toBe(EXPERIENCE_GATE_KEY);
    expect(out?.inputMode).toBe("options_only");
    expect(out?.chips).toHaveLength(2);
    expect(out?.patch.llmDraft?.experiences).toHaveLength(1);
  });

  it("settles the gate WITHOUT calling the model — 'did they say yes' is not a judgement", async () => {
    const { svc, ai } = make();
    const out = await svc.take(env({ servedQuestionKey: EXPERIENCE_GATE_KEY }), "Haan", [], CTX);
    expect(ai.llmTurn).not.toHaveBeenCalled();
    expect(out?.done).toBe(false);
    expect(out?.patch.llmStage).toBe("experience");
  });

  it("ends Phase A when the worker declines another experience", async () => {
    const { svc } = make();
    const out = await svc.take(env({ servedQuestionKey: EXPERIENCE_GATE_KEY }), "Nahi", [], CTX);
    expect(out?.done).toBe(true);
    expect(out?.patch.llmStage).toBe("done");
  });

  it("treats an unreadable gate answer as 'no' rather than looping forever", async () => {
    const { svc } = make();
    const out = await svc.take(env({ servedQuestionKey: EXPERIENCE_GATE_KEY }), "^V", [], CTX);
    expect(out?.done).toBe(true);
  });

  it("accepts a TYPED yes, because shipped clients still render the keyboard", async () => {
    // Until the Flutter client honours `input_mode`, an options_only turn still shows a
    // TextField. A typed "haan ji" has to work or the interview dead-ends on a rendering gap.
    const { svc } = make();
    const out = await svc.take(env({ servedQuestionKey: EXPERIENCE_GATE_KEY }), "haan ji", [], CTX);
    expect(out?.done).toBe(false);
  });
});

describe("the draft accumulates rather than overwrites", () => {
  it("unions skills across turns so a later turn cannot erase earlier ones", async () => {
    const { svc } = make({ turn: TURN({ skills: ["tandoor", "naan"] }) });
    const out = await svc.take(
      env({
        llmDraft: { domain_label: null, role_label: null, skills: ["biryani"], experiences: [] },
      }),
      "naan bhi banata hun",
      [],
      CTX,
    );
    expect(out?.patch.llmDraft?.skills).toEqual(["biryani", "tandoor", "naan"]);
  });

  it("lets a corrected trade label win — the conversation already fixed the mistake", async () => {
    const { svc } = make({ turn: TURN({ domain_label: "catering" }) });
    const out = await svc.take(
      env({
        llmDraft: { domain_label: "cooking", role_label: null, skills: [], experiences: [] },
      }),
      "actually catering ka kaam",
      [],
      CTX,
    );
    expect(out?.patch.llmDraft?.domain_label).toBe("catering");
  });

  it("keeps the existing label when a turn reports nothing new", async () => {
    const { svc } = make({ turn: TURN({ domain_label: null }) });
    const out = await svc.take(
      env({
        llmDraft: { domain_label: "cooking", role_label: null, skills: [], experiences: [] },
      }),
      "haan",
      [],
      CTX,
    );
    expect(out?.patch.llmDraft?.domain_label).toBe("cooking");
  });
});
