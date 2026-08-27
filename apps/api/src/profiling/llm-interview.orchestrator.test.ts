/**
 * The LLM-led opening, wired into the turn driver.
 *
 * WHAT THIS FILE IS FOR, as distinct from `llm-turn.service.test.ts`. That suite asserts the
 * caps, the gate and the fallback as a DECISION, against a stubbed model. This one asserts what
 * the orchestrator does with that decision — which is where the damage would be: a synthetic key
 * reaching `answerMap`, an answer dropped on the turn the model takes over, a fallback that ends
 * the interview instead of continuing it, or a cold start that silently swaps a conversation for
 * a form.
 *
 * THE STUB IS THE SERVICE'S OWN CONTRACT, not the model's. `take()` returns `ask`, `done` or
 * `null`, and every one of those three is exercised here.
 */
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import type { TranscriptBuffer } from "../chat/chat-transcript.buffer";
import {
  emptyProfilingEnvelope,
  narrowProfilingEnvelope,
  type ProfilingEnvelope,
} from "./conversation-state";
import type { LlmTurnResult } from "./llm-turn.service";
import {
  DE_ESCALATION_REPLY,
  HARDSHIP_REPLIES,
  ProfilingOrchestrator,
} from "./orchestrator.service";

const SESSION = "22222222-2222-4222-8222-222222222222";
const WORKER = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-08-06T10:00:00.000Z");

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "none",
    target_field: null,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: 2,
    min_turn: null,
    max_turn: null,
    ask_if: null,
    skip_if: null,
    parent_item_key: null,
    retry_text: null,
    why_text: null,
    options: [],
    ...partial,
  };
}

/** The template tail Phase A hands the interview to. `q_city` is what Phase B opens with here. */
const CITY = item({
  question_key: "q_city",
  target_kind: "rfs",
  target_field: "current_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
  is_mandatory: true,
});
const SHIFT = item({ question_key: "q_shift", prompt_text: "Din ya raat ki shift?" });
// The two the LLM-led opening covers in conversation. Ordered AFTER `q_city` and left
// non-mandatory so the tail's own priority order is unaffected by their presence.
const TRADE = item({
  question_key: "primary_trade",
  target_kind: "rfs",
  target_field: "trade",
  prompt_text: "Aap kaunsa kaam karte hain?",
});
const YEARS = item({
  question_key: "experience_years",
  target_kind: "rfs",
  target_field: "experience_years",
  prompt_text: "Is kaam mein aapko kitne saal ho gaye?",
});

/**
 * A trade's own skills question — `multi_select` over a CLOSED option list, which is what all 100
 * skills items in the corpus are. Used by the Phase A skills handoff tests below.
 */
const SKILLS = item({
  question_key: "welding_process",
  target_kind: "rfs",
  target_field: "skills",
  answer_type: "multi_select",
  prompt_text: "Aap kaunsi welding karte hain?",
  options: [
    { option_key: "mig", label_text: "MIG welding", value: "mig", implies_skill_id: null, is_none_of_above: false },
    { option_key: "tig", label_text: "TIG welding", value: "tig", implies_skill_id: null, is_none_of_above: false },
  ],
});

const UNIVERSAL_PACK: QuestionPack = {
  pack_id: "qp_universal",
  version: 1,
  family_id: "fam_welding",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash_universal",
  items: [CITY, SHIFT, TRADE, YEARS],
};

/** The same pack plus a skills question, for the tests that exercise the skills handoff. */
const PACK_WITH_SKILLS: QuestionPack = {
  ...UNIVERSAL_PACK,
  items: [CITY, SHIFT, TRADE, YEARS, SKILLS],
};

/**
 * THE TRADE PACK FROM THE REPORTED SESSION, shortened to the questions that made the point.
 *
 * A worker finished the LLM-led interview and was then asked `machine_type`, `programming`,
 * `drawing_reading` and `measuring_tools` — the whole of `qp_machining` — about a conversation
 * that had just covered it. Two rows are enough to prove the pack is off the table: one carrying
 * `skills`, because that one settles from the draft and would be skipped by ask accounting alone,
 * and one carrying nothing, which the engine has no reason not to serve.
 *
 * ITS OWN `pack_id`, because `resolvePacks` treats an "occupation" pack whose id matches the
 * universal one as absent — a fixture that reused `qp_universal` would be suppressed by that rule
 * rather than by the seam under test.
 */
const MACHINE_TYPE = item({
  question_key: "machine_type",
  target_kind: "rfs",
  target_field: "skills",
  answer_type: "multi_select",
  prompt_text: "Aap kaunsi machine chalate hain?",
  options: [
    { option_key: "cnc", label_text: "CNC lathe", value: "cnc", implies_skill_id: null, is_none_of_above: false },
    { option_key: "vmc", label_text: "VMC", value: "vmc", implies_skill_id: null, is_none_of_above: false },
  ],
});
const PROGRAMMING = item({
  question_key: "programming",
  prompt_text: "Aap programming bhi karte hain?",
});
const MACHINING_PACK: QuestionPack = {
  ...UNIVERSAL_PACK,
  pack_id: "qp_machining",
  family_id: "fam_machining",
  content_hash: "hash_machining",
  items: [MACHINE_TYPE, PROGRAMMING],
};

/** Retrieval's pin — the deterministic decision that chose the pack, not a model claim. */
const PIN = {
  job_domain_id: "jd_nco_7212_0100",
  label: "welder",
  isco_unit_code: "7212",
  match_status: "matched_lexical" as const,
  match_score: 0.94,
  match_layer: "l0_exact" as const,
  pack_id: null,
  pack_version: null,
  catalog_version: "cat_2026_08",
};

/** The same thing for the machinist whose interview is the reason the seam exists. */
const MACHINIST_PIN = {
  ...PIN,
  job_domain_id: "jd_nco_7223_0100",
  label: "machine operator",
  isco_unit_code: "7223",
};

/**
 * EVERY FIXTURE HERE CARRIES `llmLedTurns`, and the stub is exactly why it has to.
 *
 * `LlmTurnService` is the only writer of that counter in production — one increment per turn it
 * actually served — and this suite replaces the service with `opts.take`. A fixture that omitted
 * it would model a turn the model led while the envelope recorded that Phase A never ran, which
 * is a state the real writer cannot produce, and every trade-pack assertion built on it would be
 * asserting the wrong branch of {@link selectableEnginePacks}.
 */
const ASK: LlmTurnResult = {
  kind: "ask",
  reply: "Aap kaunsi cuisine banate hain?",
  chips: [],
  inputMode: "text",
  patch: {
    llmStage: "skills",
    llmAsks: 1,
    llmLedTurns: 1,
    llmDraft: { domain_label: "cooking", role_label: null, skills: [], experiences: [] },
  },
};

/** The gate turn — `llmAsks` deliberately unspent, `llmLedTurns` deliberately counted. */
const GATE: LlmTurnResult = {
  kind: "ask",
  reply: "Aur koi experience jodna hai?",
  chips: ["Haan", "Nahi"],
  inputMode: "options_only",
  patch: { llmStage: "experience", llmGateOpen: true, llmLedTurns: 1 },
};

/**
 * The draft a FINISHED Phase A leaves behind — the machinist session, as it actually happened.
 *
 * IT IS NO LONGER LOAD-BEARING FOR THE PACK SKIP, and that is the whole point of the change this
 * fixture survived. The first version of `selectableEnginePacks` required
 * `llmDraft.experiences.length > 0`, so this array WAS the suppression's trigger — and
 * `experience_entry` is the model's own output, which made the model the thing deciding whether a
 * worker's authored trade questions were asked. A model that simply never filled it re-armed the
 * whole pack: the reported welder. The trigger is now `llmLedTurns`, a counter this platform
 * increments, so the draft is back to being what it always should have been — the interview's
 * FINDINGS, asserted on where settlement is under test and irrelevant to selection.
 */
const FINISHED_DRAFT = {
  domain_label: "machining",
  role_label: null,
  skills: [] as string[],
  experiences: [
    {
      role_label: "CNC operator",
      duration_text: "6 mahine",
      duration_months: 6,
      work_done: "HCL mein CNC turning",
    },
  ],
};

const DONE: LlmTurnResult = {
  kind: "done",
  patch: {
    llmStage: "done",
    llmAsks: 6,
    llmLedTurns: 6,
    llmDraft: FINISHED_DRAFT,
  },
};

/**
 * THE WELDER. Phase A led the interview and closed having structured NOTHING.
 *
 * Reported from a real device: the model ran the experience stretch conversationally, wrote its
 * own gate-shaped question ("aur koi kaam jode?" — note "kaam", where the engine's
 * `EXPERIENCE_GATE_PROMPT` says "experience"), never emitted an `experience_entry`, and returned
 * `phase_a_done` on the worker's "Nahi". Identical on screen to the machinist session above, and
 * under the old `experiences.length > 0` floor it got the entire `qp_welding` pack asked back at
 * it. `llmAsks`/`llmLedTurns` are non-zero because the turns HAPPENED; the draft is empty because
 * the model chose not to fill it, which is precisely the thing that must not decide this.
 */
const DONE_EMPTY_HANDED: LlmTurnResult = {
  kind: "done",
  patch: {
    llmStage: "done",
    llmAsks: 5,
    llmLedTurns: 5,
    llmDraft: { domain_label: null, role_label: null, skills: [], experiences: [] },
  },
};

function makeWorld(
  opts: {
    leads?: boolean;
    take?: LlmTurnResult | null;
    pack?: QuestionPack;
    /**
     * The worker's own trade pack. Null everywhere else in this file, which is precisely why the
     * post-Phase-A handover had no coverage worth the name until now: with no occupation pack in
     * the world, "the tail takes over" and "the trade pack is skipped" are indistinguishable.
     */
    occupation?: QuestionPack;
  } = {},
) {
  const store = new Map<string, TranscriptBuffer>();

  const buffer = {
    // THROUGH THE REAL NARROWER, exactly as `ChatTranscriptBuffer.load` does — so a field this
    // change added to the envelope but forgot to narrow fails HERE rather than in production,
    // where it would simply reset every turn.
    load: vi.fn(async (id: string) => {
      const held = store.get(id);
      if (!held) return null;
      const raw = JSON.parse(JSON.stringify(held)) as TranscriptBuffer;
      const profiling = narrowProfilingEnvelope(raw.profiling);
      return { ...raw, ...(profiling ? { profiling } : { profiling: undefined }) };
    }),
    saveWithCas: vi.fn(async (id: string, next: TranscriptBuffer, expectedRev: number) => {
      const current = store.get(id)?.profiling?.rev ?? 0;
      if (current !== expectedRev) return false;
      store.set(id, {
        ...next,
        profiling: { ...(next.profiling as ProfilingEnvelope), rev: expectedRev + 1 },
      });
      return true;
    }),
  };
  const registry = {
    loadUniversal: vi.fn(async () => opts.pack ?? UNIVERSAL_PACK),
    loadPinned: vi.fn(async () => opts.occupation ?? null),
    resolveForOccupation: vi.fn(async () => opts.occupation ?? null),
  };
  const identify = {
    identify: vi.fn(async () => ({ patch: {}, offer: null, pinned: null })),
  };
  const chat = {
    findPackPin: vi.fn(async () => null),
    pinPack: vi.fn(async () => true),
  };
  const events = { emit: vi.fn(async (_params: unknown) => undefined) };
  const llm = {
    // MIRRORS `LlmTurnService.leads` MINUS THE FLAG. The stage is what stops the model being
    // consulted a second time, and a stub that answered "yes" forever would let a test drive an
    // interview past Phase A's close in a way production cannot — which matters here, because the
    // turns AFTER the handover are the ones the trade-pack skip is asserted over.
    leads: vi.fn(
      (envelope: ProfilingEnvelope) => (opts.leads ?? true) && envelope.llmStage !== "done",
    ),
    take: vi.fn(async () => ("take" in opts ? opts.take : ASK)),
  };

  const orchestrator = new ProfilingOrchestrator(
    buffer as never,
    registry as never,
    identify as never,
    chat as never,
    events as never,
    llm as never,
  );
  return { orchestrator, store, llm, events, identify };
}

function seed(store: Map<string, TranscriptBuffer>, envelope: Partial<ProfilingEnvelope> = {}) {
  store.set(SESSION, {
    workerId: WORKER,
    turnCount: 1,
    captured: {},
    roleFamily: "",
    messages: [],
    startedAt: T0.toISOString(),
    profiling: { ...emptyProfilingEnvelope(), rev: 1, ...envelope },
  });
}

const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" };
/**
 * An inbound turn, with NO client submission id (#931) — the legacy shape, deliberately.
 *
 * Every assertion in this file is about the model-led opening, not about the reply cache, and an
 * inbound with no id takes the hash + window path exactly as it did before that field existed.
 * The id's own behaviour is pinned in `orchestrator.service.test.ts`, where the cache lives.
 */
const say = (text: string, at: Date = T0) => ({
  sessionId: SESSION,
  workerId: WORKER,
  text,
  now: at,
  submissionId: null,
  voiceNoteId: null,
  ctx: CTX as never,
});

describe("the model's turn reaches the worker", () => {
  it("serves the model's question and spends no ENGINE ask on it", async () => {
    const { orchestrator, store } = makeWorld();
    const result = await orchestrator.takeTurn(say("cook hu"));

    expect(result.reply).toBe(ASK.reply);
    expect(result.kind).toBe("ask");
    // NO PACK KEY. Claiming one would make the next turn capture the answer as that question's.
    expect(result.questionKey).toBeNull();
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.engineAsks).toBe(0);
    expect(saved?.servedQuestionKey).toBeNull();
    expect(saved?.phase).toBe("llm_interview");
    expect(saved?.llmDraft.domain_label).toBe("cooking");
  });

  it("sends `options_only` and the two gate chips down the wire", async () => {
    const { orchestrator, store } = makeWorld({ take: GATE });
    const result = await orchestrator.takeTurn(say("3 saal tandoor pe"));

    expect(result.inputMode).toBe("options_only");
    expect(result.options.map((o) => o.label_text)).toEqual(["Haan", "Nahi"]);
    // DIGIT-FREE SLUGS. `option_key` is `slugKey`, and `narrowLastTurn` parses the cached list
    // all-or-nothing — one `llm_0` would empty the whole offer on a replay.
    expect(result.options.map((o) => o.option_key)).toEqual(["llm_a", "llm_b"]);
    expect(store.get(SESSION)?.profiling?.llmGateOpen).toBe(true);
  });

  it("replays a gate turn WITH its chips and its typing rule intact", async () => {
    // The reply cache promises the response it claims to repeat. A replayed gate that lost
    // `options_only` would show a keyboard where the first delivery showed two buttons.
    const { orchestrator, store } = makeWorld({ take: GATE });
    await orchestrator.takeTurn(say("3 saal tandoor pe"));
    const again = await orchestrator.takeTurn(say("3 saal tandoor pe", new Date(T0.getTime() + 1)));

    expect(again.replayed).toBe(true);
    expect(again.inputMode).toBe("options_only");
    expect(again.options.map((o) => o.label_text)).toEqual(["Haan", "Nahi"]);
    // A REV BUMP, DELIBERATELY (see `LastTurn.replays` on the orchestrator's reply-cache batch):
    // consuming one unit of the replay budget is a real write, so a further identical submission
    // cannot match this same stamp forever.
    expect(store.get(SESSION)?.profiling?.rev).toBe(2);
    expect(store.get(SESSION)?.profiling?.lastTurn?.replays).toBe(1);
  });

  it("names no question key anywhere in `answerMap` — the gate is not a question", async () => {
    // THE LEAK THIS DESIGN CLOSES. `^[a-z_]+$` would have accepted a synthetic key, so a gate
    // answer could be filed as an answer to a question no pack owns and re-read by the worker's
    // NEXT interview.
    const { orchestrator, store } = makeWorld({ take: GATE });
    await orchestrator.takeTurn(say("3 saal tandoor pe"));
    seed(store, {
      ...(store.get(SESSION)?.profiling as ProfilingEnvelope),
      rev: 1,
      llmGateOpen: true,
    });
    await orchestrator.takeTurn(say("Nahi"));

    const keys = (store.get(SESSION)?.profiling?.answerMap ?? []).map((a) => a.question_key);
    expect(keys.every((k) => /^[a-z_]{1,40}$/.test(k))).toBe(true);
    expect(keys).not.toContain("__experience_gate");
  });
});

describe("Phase A ends and the template tail takes over", () => {
  it("serves the pack's next question on the SAME turn Phase A finishes", async () => {
    // Not the model's closing words — that would cost the worker a round trip to see a bubble
    // with no question in it.
    const { orchestrator, store } = makeWorld({ take: DONE });
    const result = await orchestrator.takeTurn(say("bas itna hi"));

    expect(result.reply).toBe(CITY.prompt_text);
    expect(result.questionKey).toBe("q_city");
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.llmStage).toBe("done");
    expect(saved?.engineAsks).toBe(1);
  });

  it("settles what Phase A learned, so the tail does not re-ask the trade", async () => {
    const { orchestrator, store } = makeWorld({
      take: {
        kind: "done",
        patch: {
          llmStage: "done",
          llmDraft: {
            domain_label: "cooking",
            role_label: "tandoor cook",
            skills: [],
            experiences: [
              {
                role_label: "tandoor cook",
                duration_text: "3 saal",
                duration_months: 36,
                work_done: "naan",
              },
              {
                role_label: "helper",
                duration_text: "1 saal",
                duration_months: 12,
                work_done: "prep",
              },
            ],
          },
        },
      },
    });
    await orchestrator.takeTurn(say("bas itna hi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    // KEYED OFF `target_field`, so it lands on whichever pack question owns the RFS field.
    expect(map.find((a) => a.target_field === "trade")).toMatchObject({
      question_key: "primary_trade",
      value_normalized: "tandoor cook",
      status: "answered",
    });
    expect(map.find((a) => a.target_field === "experience_years")?.value_normalized).toBe(4);
  });

  it("leaves `experience_years` for the pack when an entry carries no duration", async () => {
    // Summing over an entry the model could not put a number on UNDERSTATES the worker, and
    // understating experience is the one direction that costs them jobs.
    const { orchestrator, store } = makeWorld({
      take: {
        kind: "done",
        patch: {
          llmStage: "done",
          llmDraft: {
            domain_label: "cooking",
            role_label: null,
            skills: [],
            experiences: [
              {
                role_label: "cook",
                duration_text: "kaafi saal",
                duration_months: null,
                work_done: "",
              },
            ],
          },
        },
      },
    });
    await orchestrator.takeTurn(say("bas itna hi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.target_field === "experience_years")).toBeUndefined();
    expect(map.find((a) => a.target_field === "trade")?.value_normalized).toBe("cooking");
  });

  /**
   * THE REPORTED BUG. A worker answers the composite opener with trade, city and experience in one
   * sentence; the model returns an `experience_entry` on that first turn with both labels still
   * null; the entry opens the Yes/No gate; the worker taps "Nahi". Before this, `trade` resolved to
   * "" and the very next line was "Aap kaunsa kaam karte hain?" — the question the conversation had
   * just been about.
   *
   * The patch below is EXACTLY what `LlmTurnService.take` returns on that path (the gate branch,
   * answered no): `llmGateOpen` closed, stage done, and NO `llmDraft` — because no model call was
   * made, so the draft on the envelope is the one that stands.
   */
  it("falls back to the PINNED occupation for the trade when the model never labelled it", async () => {
    const { orchestrator, store } = makeWorld({
      take: { kind: "done", patch: { llmGateOpen: false, llmStage: "done" } },
    });
    seed(store, {
      occupation: PIN,
      llmGateOpen: true,
      llmStage: "experience",
      llmDraft: {
        domain_label: null,
        role_label: null,
        skills: [],
        experiences: [
          { role_label: "welder", duration_text: "5 saal", duration_months: 60, work_done: "" },
        ],
      },
    });

    const result = await orchestrator.takeTurn(say("Nahi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.target_field === "trade")).toMatchObject({
      question_key: "primary_trade",
      value_normalized: "welder",
      status: "answered",
    });
    // The point of the whole fix: the tail must not open by re-asking the trade.
    expect(result.reply).not.toBe(TRADE.prompt_text);
    expect(result.questionKey).not.toBe("primary_trade");
  });

  it("prefers the MODEL's label over the pin — the pin is the last fallback, not the first", async () => {
    const { orchestrator, store } = makeWorld({
      take: { kind: "done", patch: { llmGateOpen: false, llmStage: "done" } },
    });
    seed(store, {
      occupation: PIN, // label "welder"
      llmGateOpen: true,
      llmDraft: {
        domain_label: "welding",
        role_label: "pipe fitter welder", // more specific than the pinned domain
        skills: [],
        experiences: [],
      },
    });
    await orchestrator.takeTurn(say("Nahi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.target_field === "trade")?.value_normalized).toBe("pipe fitter welder");
  });

  it("settles NOTHING for the trade when there is no label and no pin either", async () => {
    // Honest absence beats a fabricated trade: the pack question is the right way to find out.
    const { orchestrator, store } = makeWorld({
      take: { kind: "done", patch: { llmGateOpen: false, llmStage: "done" } },
    });
    seed(store, {
      occupation: null,
      llmGateOpen: true,
      llmDraft: { domain_label: null, role_label: null, skills: [], experiences: [] },
    });
    await orchestrator.takeTurn(say("Nahi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.target_field === "trade")).toBeUndefined();
  });

  it("settles the skills question from the draft, against the PACK's own vocabulary", async () => {
    const { orchestrator, store } = makeWorld({
      pack: PACK_WITH_SKILLS,
      take: { kind: "done", patch: { llmGateOpen: false, llmStage: "done" } },
    });
    seed(store, {
      occupation: PIN,
      llmGateOpen: true,
      llmDraft: {
        domain_label: "welding",
        role_label: null,
        skills: ["MIG welding", "TIG welding"],
        experiences: [],
      },
    });
    await orchestrator.takeTurn(say("Nahi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    // The OPTION VALUES, not the model's words — `answer_option_keys` is read as pack vocabulary.
    expect(map.find((a) => a.target_field === "skills")).toMatchObject({
      question_key: "welding_process",
      value_normalized: ["mig", "tig"],
      status: "answered",
    });
  });

  it("settles NO skill the pack's options do not contain — an unmatched draft is still asked", async () => {
    // §11: the model's output is untrusted input. A skill outside the closed vocabulary is not a
    // value this question can hold, and writing it through would put a non-option in a column the
    // matcher reads as options.
    const { orchestrator, store } = makeWorld({
      pack: PACK_WITH_SKILLS,
      take: { kind: "done", patch: { llmGateOpen: false, llmStage: "done" } },
    });
    seed(store, {
      occupation: PIN,
      llmGateOpen: true,
      llmDraft: {
        domain_label: "welding",
        role_label: null,
        skills: ["underwater basket weaving"],
        experiences: [],
      },
    });
    await orchestrator.takeTurn(say("Nahi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.target_field === "skills")).toBeUndefined();
  });

  it("never overwrites a skills answer the worker gave against the real question", async () => {
    const { orchestrator, store } = makeWorld({
      pack: PACK_WITH_SKILLS,
      take: { kind: "done", patch: { llmGateOpen: false, llmStage: "done" } },
    });
    seed(store, {
      occupation: PIN,
      llmGateOpen: true,
      answerMap: [
        {
          question_key: "welding_process",
          target_field: "skills",
          value_raw: "sirf TIG",
          value_normalized: ["tig"],
          status: "answered",
          evidence: null,
          turn: 1,
          history: [],
        },
      ],
      llmDraft: {
        domain_label: "welding",
        role_label: null,
        skills: ["MIG welding"],
        experiences: [],
      },
    });
    await orchestrator.takeTurn(say("Nahi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.target_field === "skills")?.value_normalized).toEqual(["tig"]);
  });

  it("never overwrites an answer the worker gave against a real question", async () => {
    const { orchestrator, store } = makeWorld({
      take: {
        kind: "done",
        patch: {
          llmStage: "done",
          llmDraft: {
            domain_label: "catering",
            role_label: null,
            skills: [],
            experiences: [],
          },
        },
      },
    });
    // NOTHING ON SCREEN, so this turn captures nothing of its own: what is under test is the
    // projection, not the ordinary capture path that would legitimately overwrite an answer the
    // worker is being re-asked.
    seed(store, {
      servedQuestionKey: null,
      engineAsks: 1,
      askCounts: { primary_trade: 1 },
      answerMap: [
        {
          question_key: "primary_trade",
          target_field: "trade",
          value_raw: "halwai",
          value_normalized: "halwai",
          status: "answered",
          evidence: null,
          turn: 1,
          history: [],
        },
      ],
    });
    await orchestrator.takeTurn(say("bas itna hi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.question_key === "primary_trade")?.value_normalized).toBe("halwai");
  });

  it("stops consulting the model once the stage is done", async () => {
    const { orchestrator, store, llm } = makeWorld({ leads: false });
    seed(store, { llmStage: "done", servedQuestionKey: "q_city", engineAsks: 1 });
    await orchestrator.takeTurn(say("pune"));
    expect(llm.take).not.toHaveBeenCalled();
  });
});

/**
 * THE REPORTED SESSION, and the ruling that came out of it. A worker finished the LLM-led
 * interview — trade, jobs and skills in conversation, then the experience gate, then "Nahi" — and
 * the next four things on screen were `machine_type`, `programming`, `drawing_reading` and
 * `measuring_tools`: the whole of `qp_machining`, asked one authored row at a time about the
 * conversation that had just happened. Keep the LLM interview only, for now.
 *
 * EVERY TEST HERE PUTS A REAL OCCUPATION PACK IN THE WORLD, which no other suite in this file does
 * — and that absence is why the behaviour had no coverage before. With `loadPinned` and
 * `resolveForOccupation` both null, "Phase A hands over to the tail" is true whether or not the
 * trade pack is skipped, so a green run proved nothing about either.
 */
describe("an interview the model led never re-interrogates the trade pack", () => {
  it("reports ONE progress denominator, on every kind of turn", async () => {
    // THE BAR MUST NOT MOVE BACKWARDS WHEN A WORKER HESITATES. `decision.progress` counts the
    // questions that will actually be asked, but every non-decision branch — silence, hardship,
    // de-escalation, clarify — used to count the full pinned union instead. A post-Phase-A
    // machinist therefore saw 1/8 on an ask turn and 1/12 the moment they went quiet, then 2/8
    // again. `progress.fraction` is a wire field both surfaces render straight into a progress
    // bar, and the pack skip was signed off on losing the pack's QUESTIONS, not on a bar that
    // retreats. Asserted as equality rather than a literal, so it pins the invariant and not the
    // fixture's current arithmetic.
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, take: DONE });
    seed(store, { occupation: MACHINIST_PIN });

    const asked = await orchestrator.takeTurn(say("bas itna hi"));
    // A silent turn: same session, same packs, nothing answered.
    const silent = await orchestrator.takeTurn(
      say(".", new Date(T0.getTime() + 60_000)),
    );

    expect(silent.progress.total).toBe(asked.progress.total);
  });

  it("REFUSES to skip for a session where Phase A never led a turn — the pre-field envelope", async () => {
    // AN ENVELOPE WRITTEN BEFORE `llmLedTurns` EXISTED reads it back as 0, and there are a great
    // many of them in flight behind the 24 h Redis TTL on the day this deploys. Zero has to mean
    // "Phase A never ran here", because the alternative default deletes a worker's authored trade
    // questions on the strength of a field nothing ever wrote — for a welder that would drop
    // `welding_process`, the only mandatory occupation item in the corpus.
    //
    // `llmStage: "done"` WITHOUT `llmLedTurns` is otherwise unreachable: every `done` the real
    // `LlmTurnService` writes either increments the counter on the same patch or is a cap that
    // could not have fired at zero. This test is therefore about the deploy window and about the
    // narrower's default, not about a live control-flow branch.
    const { orchestrator, store } = makeWorld({
      occupation: MACHINING_PACK,
      take: { kind: "done", patch: { llmStage: "done", llmAsks: 1 } },
    });
    seed(store, { occupation: MACHINIST_PIN });

    const result = await orchestrator.takeTurn(say("pata nahi"));

    expect(result.questionKey).toBe("machine_type");
    // The pack is not merely present, it is what the worker is looking at.
    expect(result.reply).toBe("Aap kaunsi machine chalate hain?");
  });

  it("skips the pack for the WELDER: Phase A led, then closed having structured nothing", async () => {
    // THE REPORTED REGRESSION, and the reason the suppression's trigger moved off the draft.
    //
    // The old floor was `llmDraft.experiences.length > 0`. It was added as a §3 guard and it read
    // the wrong field: `experiences` is filled from `out.experience_entry`, WHICH IS THE MODEL'S
    // OWN OUTPUT. So the floor did not take the decision away from the model, it handed the model
    // the same decision with the polarity flipped — never emit an entry and the entire trade pack
    // comes back. On a real device that produced a welder who talked through their jobs in Hindi
    // and was then asked `welding_process` from the top.
    //
    // Five turns were led here. That is the fact the platform owns and this is what it now
    // decides on.
    const { orchestrator, store } = makeWorld({
      occupation: MACHINING_PACK,
      take: DONE_EMPTY_HANDED,
    });
    seed(store, { occupation: MACHINIST_PIN });

    const result = await orchestrator.takeTurn(say("nahi"));

    expect(result.questionKey).toBe("q_city");
    expect(result.reply).not.toBe("Aap kaunsi machine chalate hain?");
  });

  it("skips the pack for the SHORTEST real interview, whose `llmAsks` never left zero", async () => {
    // WHY THE OBVIOUS EXISTING COUNTER IS NOT THE SIGNAL. `llmAsks` is the runaway budget, and the
    // turn that opens the experience gate deliberately does not spend it — the model's reply is
    // discarded in favour of the gate, so charging a worker for a question they never saw would
    // be wrong. An interview of one composite opener answered with a whole job, the gate, and
    // "Nahi" therefore ends Phase A having asked about the worker's trade and recorded the answer,
    // with `llmAsks === 0`. Keyed on `llmAsks > 0` this worker gets the full trade pack: the
    // reported bug, reintroduced from the other side.
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seed(store, {
      occupation: MACHINIST_PIN,
      packId: "qp_machining",
      packVersion: 1,
      llmStage: "done",
      llmAsks: 0,
      llmLedTurns: 1,
      llmDraft: FINISHED_DRAFT,
      servedQuestionKey: null,
    });

    const result = await orchestrator.takeTurn(say("theek hai"));

    expect(result.questionKey).toBe("q_city");
  });

  it("decides on the record that Phase A RAN, never on what the model put in its draft (§3)", async () => {
    // THE INVARIANT, ASSERTED AS ONE. Two sessions identical in everything the platform recorded
    // — same pin, same pack, same `llmLedTurns`, same closed stage — differing only in a field the
    // MODEL controls. §3 says the model does not decide which authored questions a worker is
    // asked, so the two must be indistinguishable here. Under the old floor they were opposites.
    const full = makeWorld({ occupation: MACHINING_PACK, take: DONE });
    seed(full.store, { occupation: MACHINIST_PIN });
    const withDraft = await full.orchestrator.takeTurn(say("bas itna hi"));

    const empty = makeWorld({ occupation: MACHINING_PACK, take: DONE_EMPTY_HANDED });
    seed(empty.store, { occupation: MACHINIST_PIN });
    const withoutDraft = await empty.orchestrator.takeTurn(say("bas itna hi"));

    expect(withoutDraft.questionKey).toBe(withDraft.questionKey);
    expect(withDraft.questionKey).toBe("q_city");
  });

  it("predicts the tail too — the lookahead never SPEAKS a question the engine will not serve", async () => {
    // THE AMPLIFIER. `computeLookahead` is handed the same narrowed pair `nextQuestion` is, and on
    // the voice form each prediction is pre-resolved to a `tts_clip_id` and SPOKEN before the real
    // turn lands. A lookahead computed over the un-narrowed pair would say `machine_type` out loud
    // to a worker the engine has stopped asking it — worse than the round trip it exists to save,
    // because there is no correction the worker can hear.
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, take: DONE });
    seed(store, { occupation: MACHINIST_PIN });

    const result = await orchestrator.takeTurn(say("bas itna hi"));

    const predicted = Object.values(result.lookahead ?? {}).map((entry) => entry.questionKey);
    expect(predicted.length).toBeGreaterThan(0);
    expect(predicted).not.toContain("machine_type");
    expect(predicted).not.toContain("programming");
  });

  it("hands Phase A's close straight to the universal tail", async () => {
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, take: DONE });
    seed(store, { occupation: MACHINIST_PIN });
    const result = await orchestrator.takeTurn(say("bas itna hi"));

    expect(result.questionKey).toBe("q_city");
    // AND THE PACK IS STILL PINNED. Suppressing SELECTION is the whole change; a version of it
    // that nulled the pack where `resolvePacks` derives the pin would have written zero
    // `worker_pack_answer` rows for the entire interview, the tail's answers included.
    const saved = store.get(SESSION)?.profiling;
    expect(saved?.packId).toBe("qp_machining");
    expect(saved?.packVersion).toBe(1);
  });

  it("reaches `complete` on the tail alone, having served no trade-pack question at all", async () => {
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, take: DONE });
    seed(store, { occupation: MACHINIST_PIN });

    const served: (string | null)[] = [];
    let result = await orchestrator.takeTurn(say("bas itna hi"));
    served.push(result.questionKey);
    // Distinct words and a moving clock, so Layer A replays nothing and every turn is a real one.
    const replies = ["pune me rehta hu", "din ki shift", "nahi pata", "5 saal", "haan", "theek hai"];
    for (let i = 0; !result.complete && i < replies.length; i++) {
      result = await orchestrator.takeTurn(
        say(replies[i] as string, new Date(T0.getTime() + (i + 1) * 60_000)),
      );
      served.push(result.questionKey);
    }

    expect(result.complete).toBe(true);
    // `complete`, not `ask_budget` or `turn_cap`: the tail drained on its own terms.
    expect(result.completionReason).toBe("complete");
    expect(served).not.toContain("machine_type");
    expect(served).not.toContain("programming");
  });

  it("still settles what Phase A learned onto the pinned pack's OWN rows", async () => {
    // SELECTION IS SUPPRESSED; THE PACK IS NOT ERASED. Every `skills` question in the corpus lives
    // in an occupation pack, so a skip that also dropped the pack's rows out of the item list
    // would take the model's skills out of `answer_map` — and out of the matching inputs behind
    // it — in exchange for a tidier progress denominator.
    const { orchestrator, store } = makeWorld({
      occupation: MACHINING_PACK,
      take: { kind: "done", patch: { llmGateOpen: false, llmStage: "done" } },
    });
    seed(store, {
      occupation: MACHINIST_PIN,
      llmGateOpen: true,
      // The gate cannot be on screen unless a turn put it there, and that turn incremented this.
      llmLedTurns: 1,
      llmDraft: {
        domain_label: "machining",
        role_label: null,
        skills: ["CNC lathe"],
        experiences: [],
      },
    });
    await orchestrator.takeTurn(say("Nahi"));

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    expect(map.find((a) => a.question_key === "machine_type")).toMatchObject({
      target_field: "skills",
      value_normalized: ["cnc"],
      status: "answered",
    });
  });

  it("re-opens a post-Phase-A session on the tail, not on the trade pack", async () => {
    // `openTurn` runs on every cold start and every resume-after-kill, and it resolves its own
    // packs and calls `nextQuestion` itself. A seam applied only in the turn loop would let the
    // screen re-open on the exact question the turn loop has been declining to ask — and a closed
    // interview, which carries no `servedQuestionKey`, reaches that fall-through every time.
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK });
    seed(store, {
      occupation: MACHINIST_PIN,
      packId: "qp_machining",
      packVersion: 1,
      llmStage: "done",
      llmLedTurns: 6,
      llmDraft: FINISHED_DRAFT,
      servedQuestionKey: null,
    });
    const opened = await orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: new Date(T0.getTime() + 60_000),
      ctx: CTX as never,
    });

    expect(opened.questionKey).toBe("q_city");
  });

  it("keeps skipping the pack once the flag reads OFF — the envelope remembers, the flag cannot", async () => {
    // `CHAT_LLM_INTERVIEW_ENABLED` is parsed once at boot; the envelope outlives a restart behind
    // a 24 h idle TTL. So a worker who finished Phase A can take their next turn against a process
    // where the flag reads off, and a skip keyed on the flag would re-interrogate precisely them.
    const { orchestrator, store, llm } = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seed(store, {
      occupation: MACHINIST_PIN,
      packId: "qp_machining",
      packVersion: 1,
      llmStage: "done",
      llmLedTurns: 6,
      llmDraft: FINISHED_DRAFT,
      servedQuestionKey: null,
    });
    const result = await orchestrator.takeTurn(say("theek hai"));

    expect(llm.take).not.toHaveBeenCalled();
    expect(result.questionKey).toBe("q_city");
  });
});

describe("the fallback is a fall-through, not a second engine", () => {
  it("serves a pack question on the turn the model goes away", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld({ take: null });
    const result = await orchestrator.takeTurn(say("cook hu"));

    expect(result.unavailable).toBe(false);
    expect(result.questionKey).toBe("q_city");
    expect(store.get(SESSION)?.profiling?.llmFallback).toBe(true);
  });

  it("still serves the TRADE pack when the model was never there — Phase A led NOTHING", async () => {
    // THE FLOOR UNDER THE FALLBACK, and it is the same one test as everywhere else:
    // `llmLedTurns === 0`. The model was unreachable on turn one, so no question was ever put to
    // this worker conversationally, nothing was gathered, and the trade pack is the only thing
    // that will describe them. Suppressing it here would leave them with neither the model's
    // answers nor the pack's questions.
    //
    // Distinguish this from the test below, where the model DID lead several turns before it went
    // away. Those two used to be one case (all fallbacks kept their pack, because none could reach
    // `llmStage: "done"`); they are now separated by the fact the platform recorded.
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, take: null });
    seed(store, { occupation: MACHINIST_PIN });
    const result = await orchestrator.takeTurn(say("cnc chalata hu"));

    expect(store.get(SESSION)?.profiling?.llmFallback).toBe(true);
    expect(result.questionKey).toBe("machine_type");
    // AND NOTHING WAS SETTLED FROM A DRAFT THAT DOES NOT EXIST. `settleFromLlmDraft` falls `trade`
    // back to the retrieval PIN when the draft has no label, so running it here would have filled
    // `primary_trade` from a guess this interview never got to test — an answer for a conversation
    // that never happened.
    expect(store.get(SESSION)?.profiling?.answerMap).toEqual([]);
  });

  it("SKIPS the trade pack when the model went away MID-interview, and settles what it gathered", async () => {
    // THE SECOND CARVE-OUT, CLOSED. `llmFallback` is sticky and `leads()` requires
    // `llmStage !== "done"`, so a fallen-back interview could never reach the stage the skip was
    // keyed on — which meant a worker who spent five turns describing their welding to a model
    // that then timed out got `welding_process` asked from the top, exactly as though the
    // conversation had not happened. Indistinguishable on screen from the welder bug above, and
    // impossible to tell apart from the repo, so both are closed.
    //
    // THE SETTLE IS WHAT PAYS FOR IT. The pack is only suppressed because the draft is now written
    // into `answer_map` on this branch too, under the same `llmLedTurns > 0` test — so the trade,
    // the skills and the experience survive the model's disappearance instead of living only in
    // the transcript.
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, take: null });
    seed(store, {
      occupation: MACHINIST_PIN,
      llmStage: "experience",
      llmLedTurns: 3,
      llmDraft: {
        domain_label: "machining",
        role_label: "CNC operator",
        skills: ["VMC"],
        experiences: [],
      },
    });

    const result = await orchestrator.takeTurn(say("uske baad kuch nahi"));

    expect(store.get(SESSION)?.profiling?.llmFallback).toBe(true);
    expect(result.questionKey).toBe("q_city");

    const map = store.get(SESSION)?.profiling?.answerMap ?? [];
    // The worker's own role, not the pin's label — Phase A's finding, kept.
    expect(map.find((a) => a.question_key === "primary_trade")?.value_normalized).toBe(
      "CNC operator",
    );
    // ...onto the SUPPRESSED pack's own row, which is why `items` stays the full union.
    expect(map.find((a) => a.question_key === "machine_type")?.value_normalized).toEqual(["vmc"]);
  });

  it("records the switch, because nothing else about it is visible", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, events } = makeWorld({ take: null });
    await orchestrator.takeTurn(say("cook hu"));

    const emitted = events.emit.mock.calls[0]?.[0] as { event_name: string; payload: unknown };
    expect(emitted.event_name).toBe("profile.llm_interview_fallback");
    expect(emitted.payload).toMatchObject({ reason: "unavailable", stage: "domain", asks: 0 });
  });

  it("closes the gate on the way out, so a stale Yes/No cannot swallow a real answer", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld({ take: null });
    seed(store, { llmGateOpen: true, llmStage: "experience", llmAsks: 3 });
    await orchestrator.takeTurn(say("Haan"));
    expect(store.get(SESSION)?.profiling?.llmGateOpen).toBe(false);
  });

  it("keeps the answers Phase A had already captured", async () => {
    // A mid-interview fallback must not restart from nothing: the deterministic map is what both
    // the remaining pack questions and the final extraction read.
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { orchestrator, store } = makeWorld({ take: null });
    seed(store, {
      servedQuestionKey: "q_city",
      engineAsks: 1,
      askCounts: { q_city: 1 },
      llmAsks: 2,
    });
    await orchestrator.takeTurn(say("main pune me rehta hu"));

    const saved = store.get(SESSION)?.profiling;
    expect(saved?.answerMap.find((a) => a.question_key === "q_city")?.status).toBe("answered");
  });
});

describe("reopening mid-Phase-A", () => {
  it("re-serves the MODEL's question rather than falling through to a pack one", async () => {
    // Without this, every cold start and resume-after-kill swapped the conversation for a form.
    const { orchestrator, store } = makeWorld();
    await orchestrator.takeTurn(say("cook hu"));
    const revBefore = store.get(SESSION)?.profiling?.rev;

    const reopened = await orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: new Date(T0.getTime() + 60_000),
      ctx: CTX as never,
    });

    expect(reopened.reply).toBe(ASK.reply);
    expect(reopened.questionKey).toBeNull();
    expect(reopened.replayed).toBe(true);
    // NOTHING WRITTEN. Re-serving is not a turn.
    expect(store.get(SESSION)?.profiling?.rev).toBe(revBefore);
  });

  it("and `viewSession` agrees with it about what is on screen", async () => {
    const { orchestrator } = makeWorld();
    await orchestrator.takeTurn(say("cook hu"));
    const view = await orchestrator.viewSession(SESSION, new Date(T0.getTime() + 60_000));
    expect(view?.served?.promptText).toBe(ASK.reply);
    expect(view?.served?.questionKey).toBeNull();
  });

  it("still opens a BRAND-NEW session on the pack, because the model has nothing to answer yet", async () => {
    const { orchestrator, store } = makeWorld();
    const opened = await orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: T0,
      ctx: CTX as never,
    });
    expect(opened.reply).toBe(CITY.prompt_text);
    expect(store.get(SESSION)?.profiling?.engineAsks).toBe(1);
  });
});

/**
 * EVERY OTHER DOOR ONTO THE TRADE PACK, held shut.
 *
 * `selectableEnginePacks` narrows what `nextQuestion` may CHOOSE, and for a while that was read as
 * "the trade pack is off the table". It was not. Five readers resolve a question WITHOUT asking
 * the engine to choose one — they look up `servedQuestionKey` and put it back on screen — and
 * every one of them was resolving it against the full pinned union. The owner's requirement is
 * total: no occupation question served, re-served, predicted or spoken after Phase A.
 *
 * THE STATE THEY ALL SHARE. A session carrying a suppressed occupation key in
 * `servedQuestionKey` — which is what an envelope written by the PREVIOUS build resumes as, since
 * that build served `machine_type` and this one will not. Bounded to a deploy window and cheaper
 * to close than to remember, and the lookup is identical whatever put the key there.
 */
describe("no reader can put a suppressed trade question back on screen", () => {
  /** A post-Phase-A session sitting on a trade question this build will never serve again. */
  const seedStale = (store: Map<string, TranscriptBuffer>) =>
    seed(store, {
      occupation: MACHINIST_PIN,
      packId: "qp_machining",
      packVersion: 1,
      llmStage: "done",
      llmLedTurns: 6,
      llmDraft: FINISHED_DRAFT,
      servedQuestionKey: "machine_type",
      engineAsks: 1,
      askCounts: { machine_type: 1 },
    });

  const MACHINE_TYPE_PROMPT = "Aap kaunsi machine chalate hain?";

  it("a worker who asks back does not get it re-served under a why-text", async () => {
    // `clarify` was handed `packs.engine`, the UN-narrowed pair, so "sir job milegi kya?" answered
    // the question and then RE-ASKED it. Handed the narrowed pair it finds nothing, the branch
    // falls through, and the interview moves on — which is the honest answer for a question that
    // is not on screen.
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seedStale(store);

    const result = await orchestrator.takeTurn(say("sir job milegi kya?"));

    expect(result.reply).not.toContain(MACHINE_TYPE_PROMPT);
    expect(result.questionKey).toBe("q_city");
  });

  it("a silent turn does not re-serve it", async () => {
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seedStale(store);

    const result = await orchestrator.takeTurn(say("."));

    expect(result.reply).not.toContain(MACHINE_TYPE_PROMPT);
    expect(result.questionKey).toBe("q_city");
  });

  it("an abusive turn de-escalates ABOVE nothing, rather than above the trade question", async () => {
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seedStale(store);

    const result = await orchestrator.takeTurn(say("chutiya"));

    // The de-escalation line still lands — this branch is about the worker, not about the pack.
    expect(result.reply).toBe(DE_ESCALATION_REPLY);
    // But it names no question, because the one it used to name is not on screen.
    expect(result.questionKey).toBeNull();
    expect(result.options).toEqual([]);
  });

  it("a hardship turn acknowledges without re-asking it", async () => {
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seedStale(store);

    const result = await orchestrator.takeTurn(say("ghar chalana mushkil hai"));

    expect(HARDSHIP_REPLIES as readonly string[]).toContain(result.reply);
    expect(result.questionKey).toBeNull();
  });

  it("`viewSession` and `openTurn` agree that it is not on screen", async () => {
    // THE ONE THAT IS NOT A DISPLAY ARTEFACT. `ProfilingSessionService.answer` guards on
    // `served?.questionKey !== dto.question_key`, so this lookup decides whether a voice form's
    // answer is ACCEPTED. `openTurn` was narrowed when the pack skip shipped and this reader was
    // not, so the two readers of one reopened session disagreed — the exact class of bug
    // `outstandingOffer` was written to close.
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seedStale(store);
    const later = new Date(T0.getTime() + 60_000);

    const view = await orchestrator.viewSession(SESSION, later);
    const opened = await orchestrator.openTurn({
      sessionId: SESSION,
      workerId: WORKER,
      now: later,
      ctx: CTX as never,
    });

    expect(view?.served).toBeNull();
    expect(opened.questionKey).toBe("q_city");
  });
});

/**
 * THE MAJORITY PATH, PINNED.
 *
 * `CHAT_LLM_INTERVIEW_ENABLED` is default OFF and most interviews are wholly deterministic. Every
 * narrowing above must be an identity for them: `llmLedTurns` is 0, so `selectableEnginePacks`
 * returns the object it was handed and the trade pack behaves exactly as it did before any of this
 * existed. These are the tests that fail if a narrowing is applied one condition too widely.
 */
describe("a deterministic interview is untouched", () => {
  const seedDeterministic = (store: Map<string, TranscriptBuffer>) =>
    seed(store, {
      occupation: MACHINIST_PIN,
      packId: "qp_machining",
      packVersion: 1,
      servedQuestionKey: "machine_type",
      engineAsks: 1,
      askCounts: { machine_type: 1 },
    });

  it("opens on the trade pack", async () => {
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seed(store, { occupation: MACHINIST_PIN });

    const result = await orchestrator.takeTurn(say("cnc chalata hu"));

    expect(result.questionKey).toBe("machine_type");
  });

  it("still re-serves the trade question after a clarify, a silence and a hardship", async () => {
    const clarified = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seedDeterministic(clarified.store);
    const back = await clarified.orchestrator.takeTurn(say("sir job milegi kya?"));

    const quiet = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seedDeterministic(quiet.store);
    const silent = await quiet.orchestrator.takeTurn(say("."));

    const hard = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seedDeterministic(hard.store);
    const hardship = await hard.orchestrator.takeTurn(say("ghar chalana mushkil hai"));

    expect(back.questionKey).toBe("machine_type");
    expect(silent.questionKey).toBe("machine_type");
    expect(hardship.questionKey).toBe("machine_type");
  });

  it("`viewSession` still reports the trade question as the one on screen", async () => {
    const { orchestrator, store } = makeWorld({ occupation: MACHINING_PACK, leads: false });
    seedDeterministic(store);

    const view = await orchestrator.viewSession(SESSION, new Date(T0.getTime() + 60_000));

    expect(view?.served?.questionKey).toBe("machine_type");
  });
});
