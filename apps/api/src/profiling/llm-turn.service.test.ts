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
  // The interview this turn belongs to — carried so the turn's spend lands on a session total.
  sessionId: "22222222-2222-4222-8222-222222222222",
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
  it("refuses the model's own `stage: \"done\"` on a turn that is still asking (§3)", async () => {
    // THE FOURTH WRITER OF `done`, and the only one with nothing deterministic behind it.
    // `"done"` is a legal member of LLM_INTERVIEW_STAGES, so the model can return it while also
    // returning a question to ask — and this service used to write it straight into the envelope.
    // Because the turn is an ASK, `settleFromLlmDraft` never runs on it; and because `leads()`
    // then reads `done`, Phase A is skipped from that point on, so it never runs later either.
    // Everything the interview had gathered stayed in the draft and was never written down.
    //
    // That was survivable while the engine still asked the trade pack afterwards. It is not
    // survivable now `selectableEnginePacks` suppresses that pack for a finished interview: the
    // two together produce a worker with no trade signal anywhere. The ai-service router already
    // documents the rule this restores — "the API owns progression regardless: `LlmTurnService`
    // decides `done` from its own caps, never from this".
    const { svc } = make({ turn: TURN({ stage: "done" }) });

    const out = await svc.take(env(), "abhi bhi kaam chal raha hai", [], CTX);

    // Still an ask — the model gave a question, so the worker gets it.
    expect(out?.kind).toBe("ask");
    // ...but the interview is NOT over, and the stage says so.
    expect(out?.patch?.llmStage).toBe("experience");
  });

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
    // `llmGateAsked: true` because this case is about the CLOSE, not the gate. #1016 put the
    // engine's own gate in front of the FIRST `phase_a_done` of an interview, so an envelope that
    // has never shown the gate answers "ask" here — correctly, and for a different reason than the
    // one this case exists to pin. Gate-before-close has its own describe block below.
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    expect((await svc.take(env({ llmGateAsked: true }), "bas", [], CTX))?.kind).toBe("done");
  });

  it("keeps the model's findings on the turn that ends Phase A", async () => {
    // The last turn is still a turn: dropping its draft would lose whatever the worker said in
    // the sentence that finished the phase.
    const { svc } = make({ turn: TURN({ phase_a_done: true, skills: ["tandoor"] }) });
    const out = await svc.take(env({ llmGateAsked: true }), "bas itna hi", [], CTX);
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

/**
 * `llmLedTurns` — the record that Phase A RAN, and the §3 floor under the trade-pack skip.
 *
 * WHAT DEPENDS ON THIS BEING RIGHT. `selectableEnginePacks` in the orchestrator deletes a worker's
 * entire occupation pack once Phase A is over, and `llmLedTurns > 0` is the evidence it demands
 * before doing so. It has to be a fact this platform owns: §3 forbids letting an LLM decide which
 * authored business questions a worker is asked, and the field the first version read
 * (`llmDraft.experiences.length`) was the MODEL'S OWN OUTPUT, so a model that simply never emitted
 * an `experience_entry` re-armed the whole pack. That shipped, and it re-interrogated a welder.
 *
 * THIS SERVICE IS THE ONLY WRITER. These tests pin both halves of that: every turn it actually put
 * in front of a worker counts, and every outcome where the worker saw nothing does not.
 */
describe("`llmLedTurns` — what the platform recorded, not what the model claimed", () => {
  it("counts an ordinary ask turn", async () => {
    const { svc } = make();
    const out = await svc.take(env({ llmLedTurns: 2 }), "cook hu", [], CTX);
    expect(out?.patch.llmLedTurns).toBe(3);
  });

  it("counts the GATE turn, which `llmAsks` deliberately does not", async () => {
    // THE DIVERGENCE THAT MAKES TWO COUNTERS NECESSARY. The gate discards the model's question, so
    // spending a worker's ask budget on it would be charging them for something they never saw —
    // but the turn absolutely happened: the worker described a job and it was structured. This is
    // the single most substantive turn Phase A takes, and it is the one `llmAsks` cannot see.
    const { svc } = make({ turn: TURN({ experience_entry: ENTRY }) });
    const out = await svc.take(env({ llmAsks: 0, llmLedTurns: 0 }), "3 saal tandoor pe", [], CTX);
    expect(out?.kind).toBe("ask");
    expect(out?.patch.llmAsks).toBeUndefined();
    expect(out?.patch.llmLedTurns).toBe(1);
  });

  it("counts the turn that closes Phase A on the model's advice", async () => {
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    // `llmGateAsked: true` — see the note in "honours the model's phase_a_done as advice".
    const out = await svc.take(env({ llmLedTurns: 4, llmGateAsked: true }), "bas itna hi", [], CTX);
    expect(out?.kind).toBe("done");
    expect(out?.patch.llmLedTurns).toBe(5);
  });

  it("THE SHORTEST REAL INTERVIEW ends with `llmAsks` at zero and `llmLedTurns` at one", async () => {
    // WHY THE TRADE-PACK SKIP CANNOT BE KEYED ON `llmAsks > 0`. Driven end to end through the real
    // service: one composite opener answered with a whole job, the engine's gate, "Nahi". Phase A
    // is over, the worker has been asked about their work and the answer is structured — and the
    // budget counter never moved. A skip keyed on it would serve this worker their full trade pack.
    const { svc } = make({ turn: TURN({ experience_entry: ENTRY }) });

    const gate = await svc.take(env(), "welder hu, HCL me 6 mahine", [], CTX);
    const after = env({ ...gate?.patch });
    const closed = await svc.take(after, "Nahi", [], CTX);

    expect(gate?.kind === "ask" && gate.reply).toBe(EXPERIENCE_GATE_PROMPT);
    expect(closed?.patch.llmStage).toBe("done");
    expect(after.llmAsks).toBe(0);
    expect(after.llmLedTurns).toBe(1);
  });

  it("counts NOTHING when the model was unavailable — the worker saw no Phase A turn", async () => {
    // `null` is the fallback trigger, and a fallback on turn one must leave the record at zero:
    // the orchestrator reads exactly this to decide whether the worker keeps their trade pack.
    const { svc } = make({ turn: null });
    expect(await svc.take(env(), "cook hu", [], CTX)).toBeNull();
  });

  it("counts nothing when a cap ended Phase A without a call", async () => {
    // No call, no question, nothing on screen. The counter is already past zero by construction —
    // the cap could not have fired otherwise — so leaving it alone is both correct and honest.
    const { svc, ai } = make();
    const out = await svc.take(env({ llmAsks: MAX_LLM_ASKS, llmLedTurns: 20 }), "haan", [], CTX);
    expect(ai.llmTurn).not.toHaveBeenCalled();
    expect(out?.patch.llmLedTurns).toBeUndefined();
  });

  it("counts nothing for the tap that answers the gate, which costs no model turn", async () => {
    // The gate is engine-served and engine-read. The turn that OPENED it was already counted; the
    // "Nahi" that closes it is a worker's tap, not a question anyone asked.
    const { svc } = make();
    const out = await svc.take(env({ llmGateOpen: true, llmLedTurns: 1 }), "Nahi", [], CTX);
    expect(out?.kind).toBe("done");
    expect(out?.patch.llmLedTurns).toBeUndefined();
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
      // THE ATTRIBUTION IS THE POINT OF THIS ARGUMENT, not decoration. With `ai_job_id` null
      // there is no `ai_jobs.input_ref` to join through, so without this pair the dominant
      // per-profile cost on the platform belongs to nobody and "cost per worker" reads ₹0.
      { workerId: CTX.workerId, sessionId: CTX.sessionId },
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
      { workerId: CTX.workerId, sessionId: CTX.sessionId },
    );
  });

  it("records nothing when a cap ended Phase A without calling", async () => {
    const { svc, cost } = make();
    await svc.take(env({ llmAsks: MAX_LLM_ASKS }), "haan", [], CTX);
    expect(cost.record).not.toHaveBeenCalled();
  });
});

/**
 * #1016 — "the experience gate is never asked in the worker app", reported from a real device.
 *
 * THE GATE IS DETERMINISTIC BUT ITS TRIGGER IS NOT. The engine owns the question, the chips and
 * the `options_only` mode, and none of that is ever asked of the model — but the ONE condition
 * that opens it is `out.experience_entry !== null`, which is the model's own output. So a model
 * that runs the experience stretch conversationally and never fills the field takes the gate off
 * the air for every session, without erroring, without falling back, and without anything in the
 * logs that names it. That is exactly what the reported welder session did: it wrote its own
 * gate-shaped question ("aur koi kaam jode?"), emitted no entry, and closed Phase A on the
 * worker's "Nahi".
 *
 * These two tests are the coupling stated out loud, in the file that owns the branch. The fix
 * for #1016 is in the ai-service PROMPT (`interview_system_prompt`, whose own tests pin the
 * three instructions) — nothing here can be fixed by trying harder, because the API cannot
 * invent a job the model did not report without fabricating a line on a worker's resume.
 */
describe("#1016 — what actually decides whether the worker sees the experience gate", () => {
  it("serves the gate on the turn an entry arrives, whatever the model wrote as its reply", async () => {
    // The model's own `reply_text` is DISCARDED here — this is the engine's turn, not its.
    const { svc } = make({
      turn: TURN({ experience_entry: ENTRY, reply_text: "aur koi kaam jode?" }),
    });

    const out = await svc.take(env(), "3 saal tandoor pe kaam kiya", [], CTX);

    expect(out).toMatchObject({
      kind: "ask",
      reply: EXPERIENCE_GATE_PROMPT,
      inputMode: "options_only",
    });
    expect(out?.kind === "ask" && out.chips).toEqual(["Haan", "Nahi"]);
    expect(out?.patch.llmGateOpen).toBe(true);
  });

  it("NEVER serves it when the model omits the entry — the whole of #1016 in one assertion", async () => {
    // The reported session: the model asks its own loop question and reports no entry. Every
    // field the worker sees comes from the model, so the gate simply does not exist for them.
    const { svc } = make({
      turn: TURN({ experience_entry: null, reply_text: "aur koi kaam jode?" }),
    });

    const out = await svc.take(env(), "3 saal tandoor pe kaam kiya", [], CTX);

    expect(out?.kind).toBe("ask");
    expect(out?.kind === "ask" && out.reply).not.toBe(EXPERIENCE_GATE_PROMPT);
    expect(out?.patch.llmGateOpen).toBeFalsy();
  });
});

describe("#1016 — the engine asks the gate before it accepts a close", () => {
  // THE REPORTED BUG, as a suite. The gate was served on exactly one condition — the turn the
  // model returned a non-null `experience_entry` — so a model that never filled that field took
  // the question off the air for the whole session, and Phase A closed on `phase_a_done` having
  // never asked. Both triggers were the model's own output, which is what §3 forbids: whether a
  // worker is asked "do you have another job?" is a business decision.
  //
  // #1017 sharpened the prompt and said in its own commit message that the API "cannot invent a
  // job the model did not report". True — and beside the point. These cases pin that the engine
  // does not need the job in order to ask the QUESTION.

  it("THE WELDER SESSION: no entry, phase_a_done — the worker is asked anyway", async () => {
    // The session recorded in `llm-interview.orchestrator.test.ts`: the model ran the experience
    // stretch conversationally, wrote its own gate-shaped question, emitted no `experience_entry`,
    // and returned `phase_a_done`. Before this fix that closed Phase A in silence.
    const { svc } = make({ turn: TURN({ phase_a_done: true, experience_entry: null }) });
    const out = await svc.take(env(), "bas itna hi", [], CTX);
    expect(out).toMatchObject({
      kind: "ask",
      reply: EXPERIENCE_GATE_PROMPT,
      inputMode: "options_only",
    });
    expect(out?.patch).toMatchObject({ llmGateOpen: true, llmGateAsked: true });
  });

  it("the gate carries BOTH chips — a question with one answer is not a gate", async () => {
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    const out = await svc.take(env(), "bas", [], CTX);
    expect(out?.kind === "ask" ? out.chips : null).toEqual(["Haan", "Nahi"]);
  });

  it("the model's closing words are DROPPED — the gate stands alone", async () => {
    // Branch 4's rule, applied here: two closing sentences and a Yes/No question in one bubble is
    // not a question, and the reply the model wrote was for a turn that is not happening.
    const { svc } = make({
      turn: TURN({ phase_a_done: true, reply_text: "Shukriya! Aapka profile ban gaya." }),
    });
    const out = await svc.take(env(), "bas", [], CTX);
    expect(out?.kind === "ask" ? out.reply : null).toBe(EXPERIENCE_GATE_PROMPT);
  });

  it("ONCE PER INTERVIEW — a second phase_a_done closes instead of re-asking", async () => {
    // The bound that matters. Without it a model that keeps returning `phase_a_done` is handed
    // the gate on every one of those turns, and a worker who already answered is asked again —
    // the "asked twice" failure the prompt itself warns the model about.
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    const out = await svc.take(env({ llmGateAsked: true }), "bas", [], CTX);
    expect(out?.kind).toBe("done");
    expect(out?.patch.llmStage).toBe("done");
  });

  it("a worker who already saw the gate after an entry is not asked twice", async () => {
    // The ordinary path, end to end: branch 3 serves the gate when an entry lands and sets the
    // flag, so the model's later `phase_a_done` closes rather than re-opening it. This is the
    // case that proves the two branches share ONE bound rather than each having their own.
    const { svc } = make({ turn: TURN({ experience_entry: ENTRY }) });
    const first = await svc.take(env(), "3 saal tandoor pe", [], CTX);
    expect(first?.patch.llmGateAsked).toBe(true);

    const { svc: svc2 } = make({ turn: TURN({ phase_a_done: true }) });
    const second = await svc2.take(
      env({ ...first?.patch, llmGateOpen: false }),
      "bas itna hi",
      [],
      CTX,
    );
    expect(second?.kind).toBe("done");
  });

  it("AT THE ENTRY CAP the gate is NOT offered — there is no second job to add", async () => {
    // Offering it would be a lie: a "Haan" cannot produce another entry, so the worker would be
    // asked a question whose only honest answer the engine is about to ignore.
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    const out = await svc.take(env(withEntries(MAX_EXPERIENCE_ENTRIES)), "bas", [], CTX);
    expect(out?.kind).toBe("done");
  });

  it("A CAP CLOSE IS NOT A phase_a_done CLOSE — the ask budget ends it outright", async () => {
    // Branch 2 returns before the model is even called, so there is no `phase_a_done` to gate on
    // and nothing to offer: a "Haan" would hit the same cap on the next turn. The engine closes.
    const { svc } = make({ turn: TURN({ phase_a_done: false }) });
    const out = await svc.take(env({ llmAsks: MAX_LLM_ASKS }), "aur bhi kaam kiya hai", [], CTX);
    expect(out?.kind).toBe("done");
    expect(out?.patch.llmGateOpen).toBeFalsy();
  });

  it("`llmAsks` IS NOT SPENT on the gate — a Haan is guaranteed a real model turn", async () => {
    // Branch 3's reasoning verbatim: the model's reply is discarded in favour of the gate, so the
    // question it wrote was never asked. Charging for it would let the budget run out on the turn
    // AFTER a worker says "Haan", which is the one case the gate exists to make possible.
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    const out = await svc.take(env({ llmAsks: 3 }), "bas", [], CTX);
    expect(out?.patch.llmAsks).toBeUndefined();
  });

  it("`llmLedTurns` IS counted — the gate is a turn Phase A put on screen", async () => {
    // The counter `selectableEnginePacks` reads to answer "did the platform already interview
    // this worker about their work?". A gate the worker saw and answered is such a turn.
    const { svc } = make({ turn: TURN({ phase_a_done: true }) });
    const out = await svc.take(env({ llmLedTurns: 4 }), "bas", [], CTX);
    expect(out?.patch.llmLedTurns).toBe(5);
  });

  it("the stage is clamped to `experience`, so a Haan lands the model on the right rung", async () => {
    const { svc } = make({ turn: TURN({ phase_a_done: true, stage: "domain" }) });
    const out = await svc.take(env(), "bas", [], CTX);
    expect(out?.patch.llmStage).toBe("experience");
  });

  it("the draft the model gathered on the closing turn is KEPT", async () => {
    // The turn still happened. Dropping its findings would lose whatever the worker said in the
    // sentence that triggered the close — the same rule branch 4 already follows.
    const { svc } = make({ turn: TURN({ phase_a_done: true, skills: ["welding", "grinding"] }) });
    const out = await svc.take(env(), "bas itna hi", [], CTX);
    expect(out?.patch.llmDraft?.skills).toEqual(["welding", "grinding"]);
  });

  it("HAAN AT THE ENGINE-SERVED GATE reopens the interview, exactly as after an entry", async () => {
    // The whole point: the gate is only worth serving if answering it yes actually buys another
    // experience question. Same branch-1 path an entry-served gate uses.
    const { svc } = make({ turn: TURN({ reply_text: "Us kaam mein kya karte the?" }) });
    const out = await svc.take(env({ llmGateOpen: true, llmGateAsked: true }), "Haan", [], CTX);
    expect(out?.kind).toBe("ask");
    expect(out?.kind === "ask" ? out.reply : null).toBe("Us kaam mein kya karte the?");
    expect(out?.patch.llmGateOpen).toBe(false);
  });

  it("NAHI closes Phase A, and the flag stays set for the rest of the interview", async () => {
    const { svc } = make({ turn: TURN() });
    const out = await svc.take(env({ llmGateOpen: true, llmGateAsked: true }), "Nahi", [], CTX);
    expect(out?.kind).toBe("done");
    // Not cleared: it records that the question WAS asked, which stays true afterwards. Clearing
    // it would let a later `phase_a_done` re-open the gate on a worker who already said no.
    expect(out?.patch.llmGateAsked).toBeUndefined();
  });
});
