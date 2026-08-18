import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { AnswerRecord, QuestionPackItem, QuestionPackOption } from "@badabhai/ai-contracts";

import { DISAMBIGUATION_ESCAPE_LABEL } from "@badabhai/config";

import type { ChatTurnOutcome } from "../chat/chat.service";
import { TURN_KINDS } from "./conversation-state";
import type { Lookahead, LookaheadEntry } from "./lookahead";
import type { ServedQuestion, SessionView, TurnResult } from "./orchestrator.service";
import { ProfilingSessionService } from "./profiling-session.service";
import { ProfilingStepSchema, type ProfilingStep } from "./profiling.dto";
import { clipId } from "./reply-closure";

const SESSION = "22222222-2222-4222-8222-222222222222";
const OTHER_SESSION = "33333333-3333-4333-8333-333333333333";
const WORKER = "11111111-1111-4111-8111-111111111111";
const INTRUDER = "44444444-4444-4444-8444-444444444444";
const CTX = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req_1" } as never;

const option = (option_key: string, label_text: string): QuestionPackOption => ({
  option_key,
  label_text,
  value: null,
  implies_skill_id: null,
  is_none_of_above: false,
});

const MATERIALS = [option("mild_steel", "Mild steel"), option("stainless", "Stainless steel")];

const served = (partial: Partial<ServedQuestion> = {}): ServedQuestion => ({
  questionKey: "q_material",
  promptText: "Kaunsa material?",
  answerType: "multi_select",
  options: MATERIALS,
  whyText: null,
  progress: { answered: 3, total: 11 },
  ...partial,
});

const turn = (partial: Partial<TurnResult> = {}): TurnResult => ({
  reply: "Kitne saal ka tajurba hai?",
  kind: "ask",
  questionKey: "q_years",
  options: [],
  progress: { answered: 4, total: 11 },
  whyText: null,
  answerType: "number",
  unansweredEssentials: [],
  complete: false,
  completionReason: null,
  replayed: false,
  excludeFromParse: false,
  unavailable: false,
  checkpointDue: false,
  ...partial,
});

const item = (question_key: string, prompt_text: string): QuestionPackItem =>
  ({
    question_key,
    prompt_text,
    display_order: 0,
    target_kind: "rfs",
    target_field: question_key,
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
  }) as QuestionPackItem;

const answer = (partial: Partial<AnswerRecord> & { question_key: string }): AnswerRecord =>
  ({
    target_field: partial.question_key,
    value_raw: null,
    value_normalized: null,
    status: "answered",
    evidence: null,
    turn: 1,
    history: [],
    ...partial,
  }) as AnswerRecord;

function makeWorld(
  opts: {
    session?: { id: string; workerId: string; status: string } | null;
    latest?: { id: string; workerId: string; status: string } | null;
    view?: SessionView | null;
    outcome?: ChatTurnOutcome;
    opened?: TurnResult;
    /** `worker_pack_answer` rows, as the flush leaves them. */
    flushed?: Record<string, unknown>[];
    transcribed?:
      | { ok: true; text: string; durationSeconds: number | null }
      | { ok: false; errorCode: string };
    recordThrows?: boolean;
    /** What `viewSettled` reports — the FINISHED interview the correction path reads. */
    settled?: {
      packId: string;
      packVersion: number;
      items: QuestionPackItem[];
      answers: Record<string, AnswerRecord>;
      state: Record<string, unknown>;
      correctionCount: number;
    } | null;
    corrected?:
      | { kind: "corrected"; value: unknown; correctionCount: number; answerSetHash: string }
      | { kind: "unreadable" }
      | { kind: "capped"; cap: number };
    /** A profile row already exists for this worker — i.e. the correction is landing late. */
    profile?: { id: string } | null;
    /** What `rebuildAfterCorrection` reports. `null` = the rebuild could not be queued. */
    rebuild?: { ai_job_id: string; status: string } | null;
  } = {},
) {
  const session =
    opts.session === undefined ? { id: SESSION, workerId: WORKER, status: "active" } : opts.session;
  const chat = {
    findSession: vi.fn(async () => session),
    findLatestSessionByWorker: vi.fn(async () => opts.latest ?? undefined),
    listPackAnswers: vi.fn(async () => opts.flushed ?? []),
  };
  const chatService = {
    startSession: vi.fn(async () => ({ session_id: OTHER_SESSION })),
    runTurn: vi.fn(
      async (_w: string, _s: string, _t: string, _c: unknown): Promise<ChatTurnOutcome> =>
        opts.outcome ?? { kind: "turn", turn: turn(), buffered: {} as never, terminal: false },
    ),
  };
  const orchestrator = {
    openTurn: vi.fn(async () => opts.opened ?? turn({ questionKey: "q_city" })),
    viewSettled: vi.fn(async () => (opts.settled === undefined ? null : opts.settled)),
    correctAnswer: vi.fn(
      async () =>
        opts.corrected ?? {
          kind: "corrected" as const,
          value: "Pune",
          correctionCount: 1,
          answerSetHash: "a".repeat(64),
        },
    ),
    viewSession: vi.fn(
      async (): Promise<SessionView | null> =>
        opts.view === undefined
          ? { buffer: {} as never, envelope: {} as never, items: [], served: served() }
          : opts.view,
    ),
  };
  const transcription = {
    transcribeNow: vi.fn(
      async () => opts.transcribed ?? { ok: true as const, text: "aath saal", durationSeconds: 6 },
    ),
  };
  const voiceAnswers = {
    recordAnswer: vi.fn(async () => {
      if (opts.recordThrows) throw new Error("connection terminated unexpectedly");
    }),
  };
  const workers = { latestProfile: vi.fn(async () => opts.profile ?? null) };
  const profiles = {
    rebuildAfterCorrection: vi.fn(async () =>
      opts.rebuild === undefined ? { ai_job_id: "job_1", status: "queued" } : opts.rebuild,
    ),
  };
  const service = new ProfilingSessionService(
    chat as never,
    chatService as never,
    orchestrator as never,
    transcription as never,
    voiceAnswers as never,
    workers as never,
    profiles as never,
  );
  return {
    service,
    chat,
    chatService,
    orchestrator,
    transcription,
    voiceAnswers,
    workers,
    profiles,
  };
}

/** The `answer` body for a chip tap on the material question. */
const chips = (...option_keys: string[]) =>
  ({
    session_id: SESSION,
    question_key: "q_material",
    answer: { kind: "chips" as const, option_keys },
  }) as never;

describe("start — reattach, never restart", () => {
  it("reattaches to the worker's live interview rather than minting a second one", async () => {
    // A cold app start calls this again. Minting here would ask a worker who answered nine
    // questions yesterday to begin from zero.
    const { service, chatService } = makeWorld({
      latest: { id: SESSION, workerId: WORKER, status: "active" },
    });

    const result = await service.start(WORKER, CTX);

    expect(result.session_id).toBe(SESSION);
    expect(chatService.startSession).not.toHaveBeenCalled();
  });

  it("opens a new session when the last one has ENDED", async () => {
    const { service, chatService } = makeWorld({
      latest: { id: SESSION, workerId: WORKER, status: "ended" },
    });

    const result = await service.start(WORKER, CTX);

    expect(chatService.startSession).toHaveBeenCalledOnce();
    expect(result.session_id).toBe(OTHER_SESSION);
  });

  it("serves the first question through openTurn, never through a turn", async () => {
    const { service, chatService, orchestrator } = makeWorld({
      latest: { id: SESSION, workerId: WORKER, status: "active" },
    });

    const result = await service.start(WORKER, CTX);

    expect(orchestrator.openTurn).toHaveBeenCalledOnce();
    // An empty message through the turn machinery would record a worker line saying nothing.
    expect(chatService.runTurn).not.toHaveBeenCalled();
    expect(result.step).toMatchObject({ kind: "question" });
  });
});

describe("the server maps option keys to labels — never the client", () => {
  it("sends the LABEL of the single chip the worker tapped", async () => {
    const { service, chatService } = makeWorld();

    await service.answer(WORKER, chips("stainless"), CTX);

    // A label is the worker's answer of record verbatim. If the client sent it, the client would
    // be choosing what gets stored.
    //
    // THE TRAILING `null` IS THE SUBMISSION ID (#931). None of the DTOs in this file carry one, so
    // every turn they drive reaches the reply gate as "no id" and is judged by the hash and the
    // time windows exactly as it was before that argument existed — which is the legacy path this
    // whole file already pins, now stated rather than implied.
    expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, "Stainless steel", CTX, null);
  });

  it("carries the client submission id from the DTO through to the reply gate (#931)", async () => {
    // WHAT THIS PINS, AND WHY IT IS NOT COVERED BY ANYTHING ABOVE. Every other assertion in this
    // file asserts the trailing `null`, so the server could accept `submission_id`, validate it,
    // and then drop it on the floor — the exact pre-#931 behaviour — with this whole suite green.
    // It was measured: replacing the argument with a literal `null` at all three service call
    // sites left 4592 tests passing. The on-device defect would be back for every worker while
    // CI reported success, and the telemetry would read `inbound_had_id: false` universally,
    // which looks like `the client has not rolled out` rather than `the server is dropping it`.
    // That is the same silent-strip failure that already happened once, when neither Zod schema
    // declared the key.
    const { service, chatService } = makeWorld();

    await service.answer(
      WORKER,
      {
        session_id: SESSION,
        question_key: "q_material",
        answer: { kind: "chips" as const, option_keys: ["stainless"] },
        submission_id: "cccccccc-3333-4333-8333-cccccccccccc",
      } as never,
      CTX,
    );

    expect(chatService.runTurn).toHaveBeenCalledWith(
      WORKER,
      SESSION,
      "Stainless steel",
      CTX,
      "cccccccc-3333-4333-8333-cccccccccccc",
    );
  });

  it("joins several labels for a multi-select, in the order they were tapped", async () => {
    const { service, chatService } = makeWorld();

    await service.answer(WORKER, chips("mild_steel", "stainless"), CTX);

    expect(chatService.runTurn).toHaveBeenCalledWith(
      WORKER,
      SESSION,
      "Mild steel, Stainless steel",
      CTX,
      null,
    );
  });

  it("rejects a key the engine did not serve, rather than capturing the rest", async () => {
    // A partial capture would store an answer the worker never gave.
    const { service, chatService } = makeWorld();

    await expect(
      service.answer(WORKER, chips("mild_steel", "titanium"), CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chatService.runTurn).not.toHaveBeenCalled();
  });

  it("refuses two chips on a single-select", async () => {
    const { service } = makeWorld({
      view: {
        buffer: {} as never,
        envelope: {} as never,
        items: [],
        served: served({ answerType: "single_select" }),
      },
    });

    await expect(
      service.answer(WORKER, chips("mild_steel", "stainless"), CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("maps a Haan/Nahi tap to the WORDS the yes/no lexicon reads", async () => {
    // Not to a stored `true`: `parseAffirmation` stays the one thing that decides what yes means,
    // and the 236 boolean items carry no chip to look up.
    for (const [value, expected] of [
      [true, "haan"],
      [false, "nahi"],
    ] as const) {
      const { service, chatService } = makeWorld({
        view: {
          buffer: {} as never,
          envelope: {} as never,
          items: [],
          served: served({ questionKey: "q_cert", answerType: "boolean", options: [] }),
        },
      });
      await service.answer(
        WORKER,
        {
          session_id: SESSION,
          question_key: "q_cert",
          answer: { kind: "boolean", value },
        } as never,
        CTX,
      );
      expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, expected, CTX, null);
    }
  });

  it("passes free text through verbatim, including 'Nahi pata'", async () => {
    // There is no client-side skip concept — the ENGINE maps this to `declined`.
    const { service, chatService } = makeWorld();

    await service.answer(
      WORKER,
      {
        session_id: SESSION,
        question_key: "q_material",
        answer: { kind: "text", text: "Nahi pata" },
      } as never,
      CTX,
    );

    expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, "Nahi pata", CTX, null);
  });
});

describe("the guards that stop an answer landing on the wrong question", () => {
  it("409s when the engine has already moved on", async () => {
    // The retry-after-timeout case: without this, the retry is captured as the answer to the
    // question the engine advanced to.
    const { service, chatService } = makeWorld({
      view: {
        buffer: {} as never,
        envelope: {} as never,
        items: [],
        served: served({ questionKey: "q_years" }),
      },
    });

    await expect(service.answer(WORKER, chips("stainless"), CTX)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(chatService.runTurn).not.toHaveBeenCalled();
  });

  describe("the 409 says WHICH kind of stale it is (#779)", () => {
    /**
     * A stale view whose answer map is under this test's control. `q_material` is the question
     * `chips()` answers, so putting a record on it is what makes "the worker's first submit
     * landed" true rather than merely asserted.
     */
    const staleWorld = (answerMap: unknown[]) =>
      makeWorld({
        view: {
          buffer: {} as never,
          envelope: { answerMap } as never,
          items: [],
          served: served({ questionKey: "q_years" }),
        },
      });

    /** The `stale_reason` off the thrown 409's body, via the shape the filter serialises. */
    const reasonOf = async (world: ReturnType<typeof staleWorld>) => {
      const error = await world.service
        .answer(WORKER, chips("stainless"), CTX)
        .then(() => null)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ConflictException);
      return (error as ConflictException).getResponse() as Record<string, unknown>;
    };

    it("`answer_already_landed` when the engine DID take the earlier answer", async () => {
      // THE CASE THE FIELD EXISTS FOR. The first submit landed and only the RESPONSE was lost,
      // so the client may count `profiling_answer_spoken` for a question it knows it spoke —
      // exactly, and without the extra round trip #782 spends on a link that is already failing.
      const body = await reasonOf(
        staleWorld([{ question_key: "q_material", status: "answered", value_normalized: "steel" }]),
      );

      expect(body.stale_reason).toBe("answer_already_landed");
    });

    it("`other` when nothing landed — the world moved for some other reason", async () => {
      // A reopen mid-offer, a correction, a closed interview. The client's answer was NOT taken,
      // so counting engagement here would OVER-count, which is the failure the guard prevents.
      const body = await reasonOf(staleWorld([]));

      expect(body.stale_reason).toBe("other");
    });

    it("`other` on a DECLINED question — settled is not the same as answered", async () => {
      // `isSettled` admits "declined" and this deliberately does not: the engine moved on, but
      // the worker's ANSWER was never taken, so "landed" would be a false claim. Under-counting
      // by one is the correct trade against banking engagement for an answer that does not exist.
      const body = await reasonOf(
        staleWorld([{ question_key: "q_material", status: "declined", value_normalized: null }]),
      );

      expect(body.stale_reason).toBe("other");
    });

    it("still carries every key a client reads today", async () => {
      // Passing an OBJECT to ConflictException REPLACES Nest's default body wholesale, so the
      // three keys it would have generated are restated by hand. A client that never learns
      // about `stale_reason` must be unable to tell this release from the last one.
      const body = await reasonOf(staleWorld([]));

      expect(body.statusCode).toBe(409);
      expect(body.error).toBe("Conflict");
      expect(body.message).toContain("is no longer on screen");
    });

    it("degrades to `other` — never throws — on a malformed answer map", async () => {
      // THIS RUNS INSIDE THE CONSTRUCTION OF THE 409. A throw here would return a 500 instead,
      // turning a routine, recoverable staleness into a hard failure on the exact connection
      // that is already failing. The envelope is rehydrated from jsonb, so the shape is checked.
      const body = await reasonOf(staleWorld(undefined as never));

      expect(body.stale_reason).toBe("other");
    });
  });

  it("404s — never 403 — on another worker's session", async () => {
    // A 403 would confirm the id exists and turn this route into an existence oracle.
    const { service, chatService } = makeWorld();

    await expect(service.answer(INTRUDER, chips("stainless"), CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(chatService.runTurn).not.toHaveBeenCalled();
  });

  it("proves ownership from the SESSION ROW, before reading any cache", async () => {
    const { service, orchestrator } = makeWorld();

    await expect(service.answer(INTRUDER, chips("stainless"), CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // An absent or poisoned cache key must never be able to answer an authorization question.
    expect(orchestrator.viewSession).not.toHaveBeenCalled();
  });
});

describe("the step a client draws", () => {
  it("carries the option KEYS and nothing else off the option", async () => {
    const { service } = makeWorld({
      outcome: {
        kind: "turn",
        turn: turn({ questionKey: "q_material", options: MATERIALS, answerType: "multi_select" }),
        buffered: {} as never,
        terminal: false,
      },
    });

    const { step } = await service.answer(WORKER, chips("stainless"), CTX);

    expect(step).toMatchObject({ kind: "question" });
    if (step.kind !== "question") throw new Error("unreachable");
    // `value` and `implies_skill_id` stay off: engine business. `is_none_of_above` is on, because
    // it describes how the option should be PRESENTED (#706).
    expect(step.question.options).toEqual([
      { option_key: "mild_steel", label_text: "Mild steel", is_none_of_above: false },
      { option_key: "stainless", label_text: "Stainless steel", is_none_of_above: false },
    ]);
    expect(step.question.answer_type).toBe("multi_select");
  });

  it("an ordinary pack question is `ask`", async () => {
    const { service } = makeWorld();
    const { step } = await service.answer(WORKER, chips("stainless"), CTX);
    if (step.kind !== "question") throw new Error("unreachable");
    expect(step.question.question_kind).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// The lookahead on the VOICE surface (#765)
// ---------------------------------------------------------------------------

/**
 * THE SAME PREDICTION, PROJECTED DIFFERENTLY — and the differences are the reason this needs its
 * own coverage rather than trusting the chat tests.
 *
 * This surface adds a `tts_clip_id` per prediction (the whole point here: a client that knows the
 * next clip id can have the audio ready before the tap, so a worker who cannot read hears the next
 * question instead of silence), reports `index`/`total` where chat reports `progress`, and DROPS a
 * predicted close because this union models "the interview is over" as its own `done` step.
 *
 * The stakes are also different. On chat a stale prediction is repainted; here it is SPOKEN.
 */
describe("the lookahead on the voice form (#765)", () => {
  const predicted = (over: Partial<LookaheadEntry> = {}): LookaheadEntry => ({
    questionKey: "q_years",
    kind: "ask",
    promptText: "Kitne saal ka tajurba hai?",
    whyText: null,
    answerType: "number",
    options: [],
    progress: { answered: 4, total: 11 },
    // #766 item 4 — the turn this prediction is for.
    turn: 5,
    ...over,
  });

  const withLookahead = (lookahead: Lookahead | null): ChatTurnOutcome =>
    ({
      kind: "turn",
      turn: turn({ lookahead }),
      buffered: {} as never,
      terminal: false,
    }) as never;

  /**
   * The prediction filed under `key`, or a failing test.
   *
   * `noUncheckedIndexedAccess` types every record lookup as possibly-undefined, which is right —
   * an absent key is the documented "no prediction here" case. Asserting through this keeps a
   * MISSING entry a loud failure rather than a chain of `?.` that silently compares undefined to
   * undefined and passes.
   */
  const predictionFor = (step: ProfilingStep, key: string) => {
    if (step.kind !== "question") throw new Error(`expected a question step, got ${step.kind}`);
    const entry = step.lookahead?.[key];
    if (!entry) throw new Error(`no prediction filed under ${key}`);
    return entry;
  };

  it("carries a content-addressed clip id per prediction, so the audio can be warmed", async () => {
    const { service } = makeWorld({
      outcome: withLookahead({ __declined: predicted(), stainless: predicted() }),
    });

    const { step } = await service.answer(WORKER, chips("stainless"), CTX);

    // The SAME addressing the served question uses — so a prediction and the real question that
    // follows it resolve to the same asset, and the client cannot warm the wrong clip.
    expect(predictionFor(step, "stainless").tts_clip_id).toBe(clipId("Kitne saal ka tajurba hai?"));
    expect(predictionFor(step, "stainless").tts_clip_id).toBe(
      predictionFor(step, "__declined").tts_clip_id,
    );
  });

  it("reports 1-based index/total, exactly like the question above it", async () => {
    const { service } = makeWorld({
      outcome: withLookahead({ stainless: predicted({ progress: { answered: 4, total: 11 } }) }),
    });

    const { step } = await service.answer(WORKER, chips("stainless"), CTX);

    // `answered` is how many are BEHIND the worker, so the predicted one in front of them is +1.
    expect(predictionFor(step, "stainless").index).toBe(5);
    expect(predictionFor(step, "stainless").total).toBe(11);
  });

  it("DROPS a predicted close rather than drawing a question that does not exist", async () => {
    const { service } = makeWorld({
      outcome: withLookahead({
        stainless: predicted(),
        mild_steel: predicted({ kind: "close", questionKey: null, promptText: "Shukriya!" }),
      }),
    });

    const { step } = await service.answer(WORKER, chips("stainless"), CTX);
    if (step.kind !== "question") throw new Error("unreachable");

    // A `close` entry has no question to draw on a surface whose union models the end of the
    // interview as its own `done` step. Dropping it leaves the client with the round trip, which
    // moves the worker to the review screen — rendering it would have spoken a closing line as
    // though it were the next question.
    expect(Object.keys(step.lookahead ?? {})).toEqual(["stainless"]);
  });

  it("projects predicted options to key/label/flag, like the served question", async () => {
    const { service } = makeWorld({
      outcome: withLookahead({
        stainless: predicted({ answerType: "single_select", options: MATERIALS }),
      }),
    });

    const { step } = await service.answer(WORKER, chips("stainless"), CTX);

    expect(predictionFor(step, "stainless").options).toEqual([
      { option_key: "mild_steel", label_text: "Mild steel", is_none_of_above: false },
      { option_key: "stainless", label_text: "Stainless steel", is_none_of_above: false },
    ]);
  });

  it("a step with no prediction still validates, and an older one without the key does too", async () => {
    const { service } = makeWorld({ outcome: withLookahead(null) });
    const { step } = await service.answer(WORKER, chips("stainless"), CTX);
    if (step.kind !== "question") throw new Error("unreachable");
    expect(step.lookahead).toBeNull();

    // BACKWARD COMPATIBILITY (CLAUDE.md §3): the voice form is the surface with the slowest
    // client rollout, so a step shaped before this field existed must keep parsing.
    const { lookahead: _dropped, ...older } = step;
    const reparsed = ProfilingStepSchema.safeParse(older);
    expect(reparsed.success).toBe(true);
    expect(reparsed.success && reparsed.data.kind === "question" && reparsed.data.lookahead).toBe(
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// The disambiguation offer on the LOW-LITERACY surface (#706)
// ---------------------------------------------------------------------------

/** What the orchestrator's offer branch produces, built the way `identify.service.ts` builds it. */
const OFFER_TURN = turn({
  kind: "disambiguate",
  reply: "Aap in mein se kaun sa kaam karte hain?",
  questionKey: null,
  answerType: "single_select",
  options: [
    option("occ_a", "Welder"),
    { ...option("kuch_aur", DISAMBIGUATION_ESCAPE_LABEL), is_none_of_above: true },
  ],
});

const offerOutcome = {
  kind: "turn" as const,
  turn: OFFER_TURN,
  buffered: {} as never,
  terminal: false,
};

describe("a disambiguation offer announces itself on the voice form (#706)", () => {
  it("carries question_kind `disambiguate` instead of leaving it to be inferred", async () => {
    // `question_key === null` was the only signal, which is an implicit contract a client had to
    // reverse-engineer from a comment — and the exact shape that let the CHAT surface ship the
    // wrong widget until #695. Here the worker is being read to, so "which of these did you mean?"
    // and "what work do you do?" have to be speakable differently.
    const { service } = makeWorld({ outcome: offerOutcome });
    const { step } = await service.answer(WORKER, chips("stainless"), CTX);
    if (step.kind !== "question") throw new Error("unreachable");
    expect(step.question.question_kind).toBe("disambiguate");
    expect(step.question.question_key).toBeNull();
  });

  it("flags the escape option, so the client stops matching on display copy", async () => {
    const { service } = makeWorld({ outcome: offerOutcome });
    const { step } = await service.answer(WORKER, chips("stainless"), CTX);
    if (step.kind !== "question") throw new Error("unreachable");
    const escapes = step.question.options.filter((o) => o.is_none_of_above);
    expect(escapes).toHaveLength(1);
    // Bound to the constant the server built it from — a copy change now moves the label without
    // stranding the client's branch.
    expect(escapes[0]?.label_text).toBe(DISAMBIGUATION_ESCAPE_LABEL);
  });

  it("declares the ENGINE's kinds, not a second copy of them", () => {
    // The chat surface declares a superset only because `question_kind` shipped there before
    // `TurnKind` existed. Here the schema IS the enum, so there is nothing to drift — this asserts
    // that, rather than a containment that a hand-written literal array could quietly break.
    const parse = (question_kind: string) =>
      ProfilingStepSchema.safeParse({
        kind: "question",
        index: 1,
        total: 11,
        question: {
          question_key: null,
          question_kind,
          prompt_text: "x",
          answer_type: "single_select",
          options: [],
          why_text: null,
          tts_clip_id: "a".repeat(16),
        },
      }).success;

    for (const kind of TURN_KINDS) expect(parse(kind), `${kind} is not on the wire`).toBe(true);
    expect(parse("interrogate")).toBe(false);
  });

  it("DEFAULTS both new fields, so a payload predating them still parses", () => {
    // Additive to a contract a shipped client already reads (#698): the absent fields must read as
    // today's behaviour rather than failing the parse.
    const parsed = ProfilingStepSchema.safeParse({
      kind: "question",
      index: 1,
      total: 11,
      question: {
        question_key: "q_city",
        prompt_text: "Aap kis sheher mein rehte hain?",
        answer_type: "single_select",
        options: [{ option_key: "pune", label_text: "Pune" }],
        why_text: null,
        tts_clip_id: "a".repeat(16),
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.kind !== "question") throw new Error("unreachable");
    expect(parsed.data.question.question_kind).toBe("ask");
    expect(parsed.data.question.options[0]?.is_none_of_above).toBe(false);
  });

  it("addresses the audio by CONTENT, so a clip can never be the wrong question's", async () => {
    const { service } = makeWorld();

    const { step } = await service.answer(WORKER, chips("stainless"), CTX);

    if (step.kind !== "question") throw new Error("unreachable");
    expect(step.question.tts_clip_id).toBe(clipId("Kitne saal ka tajurba hai?"));
  });

  it("says DONE when the interview closed, and when it was already over", async () => {
    for (const outcome of [
      { kind: "turn", turn: turn({ complete: true }), buffered: {} as never, terminal: true },
      { kind: "session_over" },
      { kind: "reflushed", flushed: true },
    ] as ChatTurnOutcome[]) {
      const { service } = makeWorld({ outcome });
      const { step } = await service.answer(WORKER, chips("stainless"), CTX);
      expect(step.kind).toBe("done");
    }
  });

  it("says UNAVAILABLE — not an HTTP error — when nothing was written", async () => {
    // A lost CAS is recoverable and is not the client's fault. A 5xx would make an offline queue
    // treat a retryable turn as a dead letter.
    const { service } = makeWorld({ outcome: { kind: "unavailable", reply: "Abhi dikkat hai" } });

    const { step } = await service.answer(WORKER, chips("stainless"), CTX);

    expect(step).toEqual({ kind: "unavailable", reply: "Abhi dikkat hai" });
  });
});

describe("the review the worker confirms", () => {
  const view = (): SessionView => ({
    buffer: { completedAt: "2026-08-08T10:00:00.000Z" } as never,
    envelope: {
      answerMap: [
        answer({ question_key: "q_city", value_normalized: "Pune" }),
        answer({ question_key: "q_cert", status: "declined" }),
        answer({ question_key: "q_years", status: "superseded", value_normalized: 3 }),
        answer({ question_key: "q_years", value_normalized: 8 }),
      ],
    } as never,
    items: [item("q_city", "Aap kis sheher mein rehte hain?"), item("q_years", "Kitne saal?")],
    served: null,
  });

  it("shows what was UNDERSTOOD, paired with the question that produced it", async () => {
    const { service } = makeWorld({ view: view() });

    const result = await service.review(WORKER, SESSION);

    expect(result.rows[0]).toEqual({
      question_key: "q_city",
      prompt_text: "Aap kis sheher mein rehte hain?",
      status: "answered",
      display_value: "Pune",
    });
  });

  it("renders a declined answer as no value — 'nahi pata' is an ANSWER, not a gap", async () => {
    const { service } = makeWorld({ view: view() });

    const result = await service.review(WORKER, SESSION);

    expect(result.rows.find((r) => r.question_key === "q_cert")).toMatchObject({
      status: "declined",
      display_value: null,
    });
  });

  it("hides superseded history — a correction's old value is not a row", async () => {
    const { service } = makeWorld({ view: view() });

    const result = await service.review(WORKER, SESSION);

    const years = result.rows.filter((r) => r.question_key === "q_years");
    expect(years).toHaveLength(1);
    expect(years[0]?.display_value).toBe("8");
  });

  it("404s on another worker's session before reading anything", async () => {
    const { service, orchestrator } = makeWorld({ view: view() });

    await expect(service.review(INTRUDER, SESSION)).rejects.toBeInstanceOf(NotFoundException);
    expect(orchestrator.viewSession).not.toHaveBeenCalled();
  });

  it("is an empty review, not an error, when the buffer has lapsed", async () => {
    const { service } = makeWorld({ view: null });

    await expect(service.review(WORKER, SESSION)).resolves.toMatchObject({ rows: [] });
  });
});

describe("finalize — durable, never a completion decision", () => {
  it("409s while the engine has not closed the interview", async () => {
    // Completion stays engine-authoritative: a client may confirm, never declare.
    const { service, chatService } = makeWorld({
      view: { buffer: {} as never, envelope: {} as never, items: [], served: served() },
    });

    await expect(service.finalize(WORKER, SESSION, CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(chatService.runTurn).not.toHaveBeenCalled();
  });

  it("re-drives the flush when the engine HAS closed it", async () => {
    const { service, chatService } = makeWorld({
      view: {
        buffer: { completedAt: "2026-08-08T10:00:00.000Z" } as never,
        envelope: {} as never,
        items: [],
        served: null,
      },
      outcome: { kind: "reflushed", flushed: true },
    });

    await expect(service.finalize(WORKER, SESSION, CTX)).resolves.toEqual({
      session_id: SESSION,
      committed: true,
    });
    expect(chatService.runTurn).toHaveBeenCalledOnce();
  });

  it("is idempotent on an already-finalized session, without touching the engine", async () => {
    // A retried finalize over a bad connection must not read as a failure for something that
    // already succeeded.
    const { service, chatService } = makeWorld({
      session: { id: SESSION, workerId: WORKER, status: "ended" },
    });

    await expect(service.finalize(WORKER, SESSION, CTX)).resolves.toEqual({
      session_id: SESSION,
      committed: true,
    });
    expect(chatService.runTurn).not.toHaveBeenCalled();
  });

  it("reports NOT committed when the flush failed again", async () => {
    // The worker's interview is not lost — the buffer survives — but saying "committed" here
    // would tell them a profile exists when none does.
    const { service } = makeWorld({
      view: {
        buffer: { completedAt: "2026-08-08T10:00:00.000Z" } as never,
        envelope: {} as never,
        items: [],
        served: null,
      },
      outcome: { kind: "reflushed", flushed: false },
    });

    await expect(service.finalize(WORKER, SESSION, CTX)).resolves.toMatchObject({
      committed: false,
    });
  });

  it("404s on another worker's session", async () => {
    const { service } = makeWorld();
    await expect(service.finalize(INTRUDER, SESSION, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

/** The `answer` body for a spoken clip against the material question. */
const spoken = (voice_note_id = "55555555-5555-4555-8555-555555555555") =>
  ({
    session_id: SESSION,
    question_key: "q_material",
    answer: { kind: "spoken" as const, voice_note_id },
  }) as never;

describe("a spoken answer", () => {
  it("transcribes SYNCHRONOUSLY and feeds the words to the turn", async () => {
    // The engine cannot choose question n+1 without answer n's text, so there is nothing a queue
    // hop would buy — only a poll loop and a strand.
    const { service, chatService, transcription } = makeWorld();

    await service.answer(WORKER, spoken(), CTX);

    expect(transcription.transcribeNow).toHaveBeenCalledOnce();
    expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, "aath saal", CTX, null);
  });

  it("caps the clip at 30 seconds, which is what keeps it a single provider call", async () => {
    const { service, transcription } = makeWorld();

    await service.answer(WORKER, spoken(), CTX);

    expect(transcription.transcribeNow).toHaveBeenCalledWith(
      expect.objectContaining({ maxSeconds: 30 }),
    );
  });

  it("takes NO turn when the transcript did not arrive — the answer must not vanish", async () => {
    // The failure this exists to prevent: a worker speaks into a noisy yard and their answer
    // disappears behind a green tick. Capturing an empty transcript would spend the question's
    // ask budget on a silence they did not choose.
    const { service, chatService } = makeWorld({
      transcribed: { ok: false, errorCode: "stt_call_failed" },
    });

    const { step } = await service.answer(WORKER, spoken(), CTX);

    expect(chatService.runTurn).not.toHaveBeenCalled();
    expect(step).toMatchObject({ kind: "unavailable" });
  });

  it("records the evidence row on SUCCESS, with the pack pinned per row", async () => {
    const { service, voiceAnswers } = makeWorld({
      view: {
        buffer: {} as never,
        envelope: { packId: "qp_welding", packVersion: 3 } as never,
        items: [],
        served: served(),
      },
    });

    await service.answer(WORKER, spoken(), CTX);

    expect(voiceAnswers.recordAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        questionKey: "q_material",
        packId: "qp_welding",
        packVersion: 3,
        transcriptStatus: "succeeded",
        transcriptErrorCode: null,
        durationSeconds: 6,
      }),
    );
  });

  it("records the evidence row on FAILURE too — that is the half nothing else can see", async () => {
    // A clip recorded, uploaded, paid for and never transcribed is otherwise invisible.
    const { service, voiceAnswers } = makeWorld({
      view: {
        buffer: {} as never,
        envelope: { packId: "qp_welding", packVersion: 3 } as never,
        items: [],
        served: served(),
      },
      transcribed: { ok: false, errorCode: "stt_budget_blocked" },
    });

    await service.answer(WORKER, spoken(), CTX);

    expect(voiceAnswers.recordAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptStatus: "failed",
        transcriptErrorCode: "stt_budget_blocked",
      }),
    );
  });

  it("does NOT lose the worker's answer when the evidence write fails", async () => {
    // The row is an audit fact; the answer is already durable in the transcript buffer.
    const { service, chatService } = makeWorld({
      view: {
        buffer: {} as never,
        envelope: { packId: "qp_welding", packVersion: 3 } as never,
        items: [],
        served: served(),
      },
      recordThrows: true,
    });

    const { step } = await service.answer(WORKER, spoken(), CTX);

    expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, "aath saal", CTX, null);
    expect(step).toMatchObject({ kind: "question" });
  });

  it("still enforces the stale-question guard before spending a provider call", async () => {
    const { service, transcription } = makeWorld({
      view: {
        buffer: {} as never,
        envelope: {} as never,
        items: [],
        served: served({ questionKey: "q_years" }),
      },
    });

    await expect(service.answer(WORKER, spoken(), CTX)).rejects.toBeInstanceOf(ConflictException);
    // A 409 that had already paid Sarvam would be the worst of both.
    expect(transcription.transcribeNow).not.toHaveBeenCalled();
  });

  it("404s on another worker's session before touching the clip", async () => {
    const { service, transcription } = makeWorld();

    await expect(service.answer(INTRUDER, spoken(), CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(transcription.transcribeNow).not.toHaveBeenCalled();
  });
});

describe("the review reads what SURVIVED the interview, not what is still in Redis", () => {
  const FLUSHED = [
    {
      questionKey: "q_city",
      status: "answered",
      answerText: "Pune",
      answerNumber: null,
      answerBool: null,
      answerOptionKeys: null,
    },
    {
      questionKey: "q_cert",
      status: "declined",
      answerText: null,
      answerNumber: null,
      answerBool: null,
      answerOptionKeys: null,
    },
    {
      questionKey: "q_safety",
      status: "answered",
      answerText: null,
      answerNumber: null,
      answerBool: true,
      answerOptionKeys: null,
    },
    {
      questionKey: "q_material",
      status: "answered",
      answerText: null,
      answerNumber: null,
      answerBool: null,
      answerOptionKeys: ["mild_steel", "stainless"],
    },
  ];

  it("reads the FLUSHED rows — the envelope is gone by the time the review is shown", async () => {
    // THE DEFECT THIS PINS, found by running the product: the engine closing the interview
    // triggers the flush, and the flush drops the Redis key the instant its transaction commits.
    // A review built from the envelope therefore returned ZERO rows at exactly the moment the
    // review exists for — measured live against twelve durable `worker_pack_answer` rows.
    const { service } = makeWorld({
      view: null,
      session: { id: SESSION, workerId: WORKER, status: "ended" },
      flushed: FLUSHED,
    });

    const result = await service.review(WORKER, SESSION);

    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({ question_key: "q_city", display_value: "Pune" });
  });

  it("renders each stored shape the way a worker reads it", async () => {
    const { service } = makeWorld({
      view: null,
      session: { id: SESSION, workerId: WORKER, status: "ended" },
      flushed: FLUSHED,
    });

    const rows = (await service.review(WORKER, SESSION)).rows;

    expect(rows.find((r) => r.question_key === "q_safety")?.display_value).toBe("Haan");
    expect(rows.find((r) => r.question_key === "q_material")?.display_value).toBe(
      "mild_steel, stainless",
    );
    // "nahi pata" is a COMPLETE answer, and it renders as no value rather than as a gap.
    expect(rows.find((r) => r.question_key === "q_cert")?.display_value).toBeNull();
  });

  it("falls back to the live envelope MID-interview, when nothing has been flushed yet", async () => {
    const { service } = makeWorld({
      flushed: [],
      view: {
        buffer: {} as never,
        envelope: {
          answerMap: [answer({ question_key: "q_city", value_normalized: "Pune" })],
        } as never,
        items: [item("q_city", "Aap kis sheher mein rehte hain?")],
        served: served(),
      },
    });

    const result = await service.review(WORKER, SESSION);

    expect(result.rows).toEqual([
      {
        question_key: "q_city",
        prompt_text: "Aap kis sheher mein rehte hain?",
        status: "answered",
        display_value: "Pune",
      },
    ]);
  });
});

/**
 * THE CORRECTION PATH (#700), AND WHY IT NEEDS ITS OWN PROOF.
 *
 * This write bypasses `nextQuestion` entirely, so every guarantee the turn loop hands a caller for
 * free has to be re-established by hand — and a test per guarantee is the only thing that says it
 * WAS. Owner ruling 2026-08-08: targeted write, not re-serve.
 */
describe("correcting a settled answer", () => {
  const settledWorld = (over: Record<string, unknown> = {}) => ({
    packId: "qp_universal",
    packVersion: 1,
    items: [item("q_city", "Aap kis sheher mein rehte hain?")],
    answers: { q_city: answer({ question_key: "q_city", value_normalized: "Mumbai" }) },
    state: {},
    correctionCount: 0,
    ...over,
  });

  const dto = {
    session_id: SESSION,
    question_key: "q_city",
    answer: { kind: "text" as const, text: "Pune" },
  };

  it("writes the correction and hands back the redrawn row", async () => {
    const { service, orchestrator } = makeWorld({ settled: settledWorld() });

    const result = await service.correct(WORKER, dto, CTX);

    expect(orchestrator.correctAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ questionKey: "q_city", text: "Pune", method: "text" }),
    );
    expect(result.row).toEqual({
      question_key: "q_city",
      prompt_text: "Aap kis sheher mein rehte hain?",
      status: "answered",
      display_value: "Pune",
    });
    expect(result.correction_count).toBe(1);
  });

  it("404s another worker's session — the id is never an existence oracle", async () => {
    const { service, orchestrator } = makeWorld({
      session: { id: SESSION, workerId: "someone-else", status: "ended" },
      settled: settledWorld(),
    });

    await expect(service.correct(WORKER, dto, CTX)).rejects.toThrow(/not found/i);
    expect(orchestrator.correctAnswer).not.toHaveBeenCalled();
  });

  it("400s a question that is not in this session's pack", async () => {
    // The guard that stops a client naming an arbitrary key. The question is resolved from the
    // PINNED pack, never from the request.
    const { service, orchestrator } = makeWorld({ settled: settledWorld() });

    await expect(
      service.correct(WORKER, { ...dto, question_key: "q_not_in_pack" }, CTX),
    ).rejects.toThrow(/not in this session's pack/i);
    expect(orchestrator.correctAnswer).not.toHaveBeenCalled();
  });

  it("409s a question that is NOT YET SETTLED — that one belongs to the turn loop", async () => {
    // The mirror of the answer route's stale guard. Correcting a question still on screen would
    // write the answer without spending its ask budget, so the engine would serve it again.
    const { service, orchestrator } = makeWorld({ settled: settledWorld({ answers: {} }) });

    await expect(service.correct(WORKER, dto, CTX)).rejects.toThrow(/not settled/i);
    expect(orchestrator.correctAnswer).not.toHaveBeenCalled();
  });

  it("409s when the session never pinned a pack", async () => {
    const { service } = makeWorld({ settled: null });
    await expect(service.correct(WORKER, dto, CTX)).rejects.toThrow(/nothing settled/i);
  });

  it("422s when the words parse to no value — nothing is stored", async () => {
    // FAIL CLOSED. The turn loop can re-ask; this path cannot, and storing an unparsed sentence
    // where a typed value belongs would confirm a correction that corrected nothing.
    const { service } = makeWorld({ settled: settledWorld(), corrected: { kind: "unreadable" } });
    await expect(service.correct(WORKER, dto, CTX)).rejects.toThrow(/could not read/i);
  });

  it("409s once the session has taken its cap of corrections", async () => {
    const { service } = makeWorld({
      settled: settledWorld(),
      corrected: { kind: "capped", cap: 20 },
    });
    await expect(service.correct(WORKER, dto, CTX)).rejects.toThrow(/already taken 20/i);
  });

  it("resolves chips to LABELS server-side, and rejects a key this question does not carry", async () => {
    const chipItem = {
      ...item("q_city", "Aap kis sheher mein rehte hain?"),
      answer_type: "single_select",
      options: [
        {
          option_key: "pune",
          label_text: "Pune",
          value: null,
          implies_skill_id: null,
          is_none_of_above: false,
        },
      ],
    } as unknown as QuestionPackItem;
    const { service, orchestrator } = makeWorld({ settled: settledWorld({ items: [chipItem] }) });

    await service.correct(
      WORKER,
      { ...dto, answer: { kind: "chips", option_keys: ["pune"] } },
      CTX,
    );
    expect(orchestrator.correctAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Pune", method: "chips" }),
    );

    await expect(
      service.correct(WORKER, { ...dto, answer: { kind: "chips", option_keys: ["nagpur"] } }, CTX),
    ).rejects.toThrow(/unknown option/i);
  });

  /**
   * THE BOUNDARY THE OWNER NAMED (ruling 2026-08-08), and it is exactly where this and #420 could
   * otherwise blur into each other.
   *
   * #420 was TWO triggers firing on UNCHANGED data. This is ONE trigger firing because the data
   * CHANGED. The line between them is whether an extraction has already READ the answers:
   *
   *   not yet extracted -> the queued extraction reads `conversation_state` when it RUNS, which is
   *                        after this correction committed, so it builds from the corrected
   *                        answers by itself. Firing here would be #420's shape exactly.
   *   already extracted -> nothing will ever read them again. Rebuild.
   */
  describe("the rebuild boundary", () => {
    it("does NOT take the rebuild path when the session was never extracted", async () => {
      const { service, profiles } = makeWorld({ settled: settledWorld(), profile: null });

      const result = await service.correct(WORKER, dto, CTX);

      expect(profiles.rebuildAfterCorrection).not.toHaveBeenCalled();
      // FALSE means "no rebuild is underway", and here that is correct rather than a gap: the
      // ordinary extraction has not run yet and will pick the correction up on its own.
      expect(result.profile_rebuild_required).toBe(false);
    });

    it("DOES take it when a profile has already been built", async () => {
      const { service, profiles } = makeWorld({
        settled: settledWorld(),
        profile: { id: "prof_1" },
      });

      const result = await service.correct(WORKER, dto, CTX);

      expect(profiles.rebuildAfterCorrection).toHaveBeenCalledWith(
        {
          worker_id: WORKER,
          session_id: SESSION,
          // KEYED ON THE DATA, not on the session — that is what makes it structurally
          // incapable of colliding with #420's session-scoped guards.
          answer_set_hash: "a".repeat(64),
        },
        CTX,
      );
      expect(result.profile_rebuild_required).toBe(true);
    });

    it("passes the hash of the map that was JUST WRITTEN, not a recomputed one", async () => {
      const { service, profiles } = makeWorld({
        settled: settledWorld(),
        profile: { id: "prof_1" },
        corrected: {
          kind: "corrected",
          value: "Pune",
          correctionCount: 3,
          answerSetHash: "b".repeat(64),
        },
      });

      await service.correct(WORKER, dto, CTX);

      expect(profiles.rebuildAfterCorrection).toHaveBeenCalledWith(
        expect.objectContaining({ answer_set_hash: "b".repeat(64) }),
        CTX,
      );
    });

    it("still reports the correction as stored when the rebuild could not be queued", async () => {
      // The correction is durable in both stores before this runs. Failing the worker's call
      // because a QUEUE was unreachable would report it as lost when it is not.
      const { service } = makeWorld({
        settled: settledWorld(),
        profile: { id: "prof_1" },
        rebuild: null,
      });

      const result = await service.correct(WORKER, dto, CTX);

      expect(result.row.display_value).toBe("Pune");
      expect(result.profile_rebuild_required).toBe(false);
    });
  });

  it("422s a spoken correction whose clip could not be transcribed — never a silent no-op", async () => {
    // Deliberately UNLIKE the answer route, which degrades to `unavailable` against a question
    // still on screen. Here there is no question on screen to record against again, so a soft
    // failure would leave the review showing the old value with no sign the correction was lost.
    const { service, orchestrator } = makeWorld({
      settled: settledWorld(),
      transcribed: { ok: false, errorCode: "stt_call_failed" },
    });

    await expect(
      service.correct(WORKER, { ...dto, answer: { kind: "spoken", voice_note_id: SESSION } }, CTX),
    ).rejects.toThrow(/could not be transcribed/i);
    expect(orchestrator.correctAnswer).not.toHaveBeenCalled();
  });
});
