import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { AnswerRecord, QuestionPackItem, QuestionPackOption } from "@badabhai/ai-contracts";

import type { ChatTurnOutcome } from "../chat/chat.service";
import type { ServedQuestion, SessionView, TurnResult } from "./orchestrator.service";
import { ProfilingSessionService } from "./profiling-session.service";
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
    transcribed?:
      | { ok: true; text: string; durationSeconds: number | null }
      | { ok: false; errorCode: string };
    recordThrows?: boolean;
  } = {},
) {
  const session =
    opts.session === undefined ? { id: SESSION, workerId: WORKER, status: "active" } : opts.session;
  const chat = {
    findSession: vi.fn(async () => session),
    findLatestSessionByWorker: vi.fn(async () => opts.latest ?? undefined),
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
  const service = new ProfilingSessionService(
    chat as never,
    chatService as never,
    orchestrator as never,
    transcription as never,
    voiceAnswers as never,
  );
  return { service, chat, chatService, orchestrator, transcription, voiceAnswers };
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
    expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, "Stainless steel", CTX);
  });

  it("joins several labels for a multi-select, in the order they were tapped", async () => {
    const { service, chatService } = makeWorld();

    await service.answer(WORKER, chips("mild_steel", "stainless"), CTX);

    expect(chatService.runTurn).toHaveBeenCalledWith(
      WORKER,
      SESSION,
      "Mild steel, Stainless steel",
      CTX,
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
      expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, expected, CTX);
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

    expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, "Nahi pata", CTX);
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
    expect(step.question.options).toEqual([
      { option_key: "mild_steel", label_text: "Mild steel" },
      { option_key: "stainless", label_text: "Stainless steel" },
    ]);
    expect(step.question.answer_type).toBe("multi_select");
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
    expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, "aath saal", CTX);
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

    expect(chatService.runTurn).toHaveBeenCalledWith(WORKER, SESSION, "aath saal", CTX);
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
