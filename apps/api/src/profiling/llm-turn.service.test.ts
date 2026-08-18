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
  EXPERIENCE_GATE_PROMPT,
} from "./llm-turn.service";
import { emptyProfilingEnvelope, type ProfilingEnvelope } from "./conversation-state";

const CTX = {
  workerId: "11111111-1111-4111-8111-111111111111",
  correlationId: "44444444-4444-4444-8444-444444444444",
  requestId: "req_1",
};

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
  // Typed to TAKE its arguments, so a test can assert on what was sent — `vi.fn(async () => …)`
  // infers a zero-arg signature and `mock.calls[0][0]` is then a compile error. The second
  // parameter is BL-19's optional trace ctx, asserted on below.
  const ai = {
    llmTurn: vi.fn(async (_input: unknown, _ctx?: unknown) =>
      "turn" in over ? over.turn : TURN(),
    ),
  };
  const config = { CHAT_LLM_INTERVIEW_ENABLED: over.enabled ?? true };
  const cost = { record: vi.fn(async () => undefined) };
  const svc = new LlmTurnService(ai as never, config as never, cost as never);
  return { svc, ai, cost };
}

const env = (over: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope => ({
  ...emptyProfilingEnvelope(),
  phase: "llm_interview",
  ...over,
});

const withEntries = (n: number): Partial<ProfilingEnvelope> => ({
  llmDraft: {
    domain_label: null,
    role_label: null,
    skills: [],
    experiences: Array.from({ length: n }, () => ENTRY),
  },
});

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
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

  it("does not call the model once Phase A is over", async () => {
    // `llmStage`, NOT `phase`: `nextQuestion` rewrites `phase` on every decision it makes, so a
    // single fallback turn would otherwise re-open a finished LLM stretch.
    const { svc, ai } = make();
    expect(await svc.take(env({ llmStage: "done" }), "haan", [], CTX)).toBeNull();
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("returns null when the model is unavailable, so the engine takes the turn", async () => {
    // `null` is every failure collapsed: down, 429, deadline, mock posture, blocked, malformed,
    // and an empty reply — `AiService.llmTurn` nulls that last one before it reaches here.
    const { svc } = make({ turn: null });
    expect(await svc.take(env(), "cook hu", [], CTX)).toBeNull();
  });
});

describe("the caps — the API owns termination, never the model", () => {
  it("ends Phase A at the ask cap WITHOUT spending a call", async () => {
    // A runaway must cost nothing. The cap is checked before the call, not enforced through it.
    const { svc, ai } = make();
    const out = await svc.take(env({ llmAsks: MAX_LLM_ASKS }), "haan", [], CTX);
    expect(out?.kind).toBe("done");
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("tells the model which question is its LAST, so it closes on something worth asking", async () => {
    const { svc, ai } = make();
    await svc.take(env({ llmAsks: MAX_LLM_ASKS - 1 }), "haan", [], CTX);
    expect(ai.llmTurn.mock.calls[0]?.[0]).toMatchObject({ force_close: true });
  });

  it("does not cry wolf: an ordinary turn is not sent force_close", async () => {
    const { svc, ai } = make();
    await svc.take(env({ llmAsks: 3 }), "haan", [], CTX);
    expect(ai.llmTurn.mock.calls[0]?.[0]).toMatchObject({ force_close: false });
  });

  it("BL-19: forwards the turn's correlation/request ids, so the far side is ONE trace", async () => {
    // WITHOUT THIS, `AiService.post` mints a fresh uuid per call and a twelve-turn interview
    // lands as twelve unrelated traces — the same ids the cost record already carries, so a
    // disagreement here also splits the spend from the call that caused it.
    // The ids are the SAME pair the cost record already asserts on further down, which is the
    // point: spend and trace must name one id, not two.
    const { svc, ai } = make();
    await svc.take(env(), "cook hu", [], CTX);
    expect(ai.llmTurn.mock.calls[0]?.[1]).toEqual({
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
  });

  it("ends Phase A once the experience cap is reached, without a call", async () => {
    const { svc, ai } = make();
    const out = await svc.take(env(withEntries(MAX_EXPERIENCE_ENTRIES)), "aur bhi hai", [], CTX);
    expect(out?.kind).toBe("done");
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("ends Phase A when the model's OWN turn fills the last experience slot", async () => {
    // The gate is not offered when there is nothing left to offer — the entry that arrived on
    // this turn is the fifth, so the loop has nowhere to go.
    const { svc } = make({ turn: TURN({ experience_entry: ENTRY }) });
    const out = await svc.take(env(withEntries(MAX_EXPERIENCE_ENTRIES - 1)), "ek aur", [], CTX);
    expect(out?.kind).toBe("done");
    expect(out?.patch.llmDraft?.experiences).toHaveLength(MAX_EXPERIENCE_ENTRIES);
  });

  it("honours the model's phase_a_done as advice when no cap has fired", async () => {
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    expect((await svc.take(env(), "bas", [], CTX))?.kind).toBe("done");
  });

  it("keeps the model's findings on the turn that ends Phase A", async () => {
    // The last turn is still a turn: dropping its draft would lose whatever the worker said in
    // the sentence that finished the phase.
    const { svc } = make({ turn: TURN({ phase_a_done: true, skills: ["tandoor"] }) });
    const out = await svc.take(env(), "bas itna hi", [], CTX);
    expect(out?.patch.llmDraft?.skills).toEqual(["tandoor"]);
    expect(out?.patch.llmStage).toBe("done");
  });
});

describe("the experience loop gate is engine-served", () => {
  it("serves the Yes/No gate with typing disabled after an experience is captured", async () => {
    const { svc } = make({ turn: TURN({ experience_entry: ENTRY }) });
    const out = await svc.take(env(), "3 saal tandoor pe", [], CTX);
    expect(out).toMatchObject({
      kind: "ask",
      reply: EXPERIENCE_GATE_PROMPT,
      inputMode: "options_only",
    });
    expect(out?.kind === "ask" && out.chips).toHaveLength(2);
    expect(out?.patch.llmGateOpen).toBe(true);
    expect(out?.patch.llmDraft?.experiences).toHaveLength(1);
  });

  it("spends no ask on the gate — the model's discarded question was never asked", async () => {
    const { svc } = make({ turn: TURN({ experience_entry: ENTRY }) });
    const out = await svc.take(env({ llmAsks: 4 }), "3 saal", [], CTX);
    expect(out?.patch.llmAsks).toBeUndefined();
  });

  it("settles the gate WITHOUT calling the model — 'did they say yes' is not a judgement", async () => {
    const { svc, ai } = make();
    const out = await svc.take(env({ llmGateOpen: true }), "Haan", [], CTX);
    // One call, and it is the NEXT experience question — not a call to read the tap.
    expect(ai.llmTurn).toHaveBeenCalledTimes(1);
    expect(out?.kind).toBe("ask");
    expect(out?.patch.llmGateOpen).toBe(false);
  });

  it("asks the next experience question in the SAME turn as the Yes", async () => {
    // A worker who taps Yes must not be handed an empty bubble and a second round trip.
    const { svc } = make({ turn: TURN({ reply_text: "Uske pehle kahan kaam kiya?" }) });
    const out = await svc.take(env({ llmGateOpen: true }), "Haan", [], CTX);
    expect(out).toMatchObject({ kind: "ask", reply: "Uske pehle kahan kaam kiya?" });
  });

  it("ends Phase A when the worker declines another experience", async () => {
    const { svc, ai } = make();
    const out = await svc.take(env({ llmGateOpen: true }), "Nahi", [], CTX);
    expect(out).toMatchObject({ kind: "done" });
    expect(out?.patch).toMatchObject({ llmStage: "done", llmGateOpen: false });
    expect(ai.llmTurn).not.toHaveBeenCalled();
  });

  it("treats an unreadable gate answer as 'no' rather than looping forever", async () => {
    const { svc } = make();
    expect((await svc.take(env({ llmGateOpen: true }), "^V", [], CTX))?.kind).toBe("done");
  });

  it("accepts a TYPED yes, because shipped clients still render the keyboard", async () => {
    // Until the Flutter client honours `input_mode`, an options_only turn still shows a
    // TextField. A typed "haan ji" has to work or the interview dead-ends on a rendering gap.
    const { svc } = make();
    expect((await svc.take(env({ llmGateOpen: true }), "haan ji", [], CTX))?.kind).toBe("ask");
  });

  it("reads a worker who just starts describing the next job as a Yes", async () => {
    const { svc } = make();
    const out = await svc.take(env({ llmGateOpen: true }), "uske pehle main helper tha", [], CTX);
    expect(out?.kind).toBe("ask");
  });

  it("closes the gate even when the cap ends Phase A on the same turn", async () => {
    // Leaving `llmGateOpen` set would make the worker's next sentence be read as a yes/no answer
    // to a question that is no longer on screen.
    const { svc } = make();
    const out = await svc.take(env({ llmGateOpen: true, llmAsks: MAX_LLM_ASKS }), "Haan", [], CTX);
    expect(out?.kind).toBe("done");
    expect(out?.patch).toMatchObject({ llmGateOpen: false, llmStage: "done" });
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

describe("the gate never opens on a trade nobody has named", () => {
  // #917. An `experience_entry` may arrive on ANY turn — the composite opener invites exactly
  // that — and it opens the Yes/No gate immediately. Nothing required a label first, so a worker
  // could be looking at "Aur koi experience jodna hai?" while the draft asserted no trade at all.
  // The entry already carries the role; borrowing it costs no turn and no token.
  const NAMELESS = {
    domain_label: null,
    role_label: null,
    skills: [],
    experiences: [],
  };

  it("borrows the entry's role when the turn and the draft both name nothing", async () => {
    const { svc } = make({ turn: TURN({ domain_label: null, experience_entry: ENTRY }) });
    const out = await svc.take(env({ llmDraft: NAMELESS }), "3 saal tandoor pe kaam kiya", [], CTX);
    // The gate IS what this turn serves — the point is that it no longer serves it nameless.
    expect(out).toMatchObject({ kind: "ask", reply: EXPERIENCE_GATE_PROMPT });
    expect(out?.patch.llmDraft?.role_label).toBe(ENTRY.role_label);
  });

  it("borrows nothing when there is no entry — an absent label stays absent", async () => {
    // The fallback must not invent a role on ordinary turns; `settleFromLlmDraft` treats a label
    // as the worker's answer of record, so a fabricated one is worse than the pack question.
    const { svc } = make({ turn: TURN({ domain_label: null }) });
    const out = await svc.take(env({ llmDraft: NAMELESS }), "haan", [], CTX);
    expect(out?.patch.llmDraft?.role_label).toBeNull();
  });

  it("lets the turn's OWN role_label beat the entry's — the model named it properly", async () => {
    const { svc } = make({
      turn: TURN({ role_label: "pipe fitter welder", experience_entry: ENTRY }),
    });
    const out = await svc.take(env({ llmDraft: NAMELESS }), "welding ka kaam", [], CTX);
    expect(out?.patch.llmDraft?.role_label).toBe("pipe fitter welder");
  });

  it("does not let an EARLIER job rename the worker's trade", async () => {
    // Entry two onwards is a previous job ("uske pehle main helper tha"). The draft already holds
    // a role by then, and that precedence is the whole reason the fallback sits last.
    const { svc } = make({
      turn: TURN({ role_label: null, experience_entry: { ...ENTRY, role_label: "helper" } }),
    });
    const out = await svc.take(
      env({
        llmDraft: { ...NAMELESS, role_label: "tandoor cook", experiences: [ENTRY] },
      }),
      "uske pehle main helper tha",
      [],
      CTX,
    );
    expect(out?.patch.llmDraft?.role_label).toBe("tandoor cook");
  });

  it("borrows the ROLE only — the domain is not something an entry can answer", async () => {
    const { svc } = make({ turn: TURN({ domain_label: null, experience_entry: ENTRY }) });
    const out = await svc.take(env({ llmDraft: NAMELESS }), "3 saal", [], CTX);
    expect(out?.patch.llmDraft?.domain_label).toBeNull();
  });
});

describe("every Phase A turn is a billable call, and the ledger has to say so", () => {
  const META = {
    ai_call_id: "77777777-7777-4777-8777-777777777777",
    task_type: "profiling_chat_turn",
    model_name: "claude-haiku-4-5",
    provider: "anthropic",
    real_call: true,
    input_tokens: 897,
    output_tokens: 112,
    estimated_cost_inr: 0.157,
    latency_ms: 2863,
    success: true,
    created_at: "2026-08-12T05:04:02.270Z",
  };

  it("records the spend under `profiling_chat_turn` with no ai_job behind it", async () => {
    // MEASURED, NOT IMAGINED. The first live interview made twelve real calls and emitted zero
    // cost events: the ai-service logged them into its own ledger and the platform's cost spine
    // never heard. An interview turn is synchronous, so `ai_job_id` is null by design.
    const { svc, cost } = make({ turn: TURN({ ai_metadata: META }) });
    await svc.take(env(), "cook hu", [], CTX);
    expect(cost.record).toHaveBeenCalledWith(
      META,
      "profiling_chat_turn",
      null,
      CTX.correlationId,
      CTX.requestId,
    );
  });

  it("still records a turn whose reply we could NOT use", async () => {
    // A reply that failed the contract burned the same tokens as one that passed. Charging it to
    // nobody is how a broken parser looks free.
    const { svc, cost } = make({ turn: null });
    await svc.take(env(), "cook hu", [], CTX);
    expect(cost.record).toHaveBeenCalledWith(
      null,
      "profiling_chat_turn",
      null,
      CTX.correlationId,
      CTX.requestId,
    );
  });

  it("records nothing when a cap ended Phase A without calling", async () => {
    const { svc, cost } = make();
    await svc.take(env({ llmAsks: MAX_LLM_ASKS }), "haan", [], CTX);
    expect(cost.record).not.toHaveBeenCalled();
  });
});
