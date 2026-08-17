/**
 * `ChatService` after the OIE Phase 8 cutover.
 *
 * CONSCIOUSLY REWRITTEN, not repaired. The previous file was ~1,250 lines and most of it
 * asserted properties of a turn loop that no longer exists: the windowed history sent to the
 * model, `force_complete` on the capped turn, `updated_state.turn_count` being distrusted, the
 * R32 name redaction applied to every outbound leg. All of those were true statements about
 * calling an LLM once per turn, and the whole point of this phase is that the turn calls
 * nothing.
 *
 * WHAT SURVIVED, because it was never about the model:
 *   - a turn writes NOTHING to Postgres; the flush is the only write;
 *   - the flush is one transaction, with the original per-message timestamps and stable
 *     idempotency keys, and a rollback keeps the buffer so the next POST retries;
 *   - a session that is not yours is 404, never 403;
 *   - the worker's real name reaches the client reply and nothing durable.
 *
 * WHAT IS NEW HERE: the answer map landing in `worker_pack_answer` as ONE statement, and the
 * plan's headline acceptance criterion — ZERO LLM calls between session start and completion,
 * asserted structurally by the fact that `ChatService` no longer holds an `AiService` at all.
 */
import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { ChatService } from "./chat.service";
import { PostMessageResponseSchema } from "./chat.dto";
import type { TranscriptBuffer } from "./chat-transcript.buffer";
import {
  emptyTurnLatency,
  TURN_KINDS,
  type ProfilingEnvelope,
} from "../profiling/conversation-state";
import { DISAMBIGUATION_ESCAPE_KEY, DISAMBIGUATION_ESCAPE_LABEL } from "@badabhai/config";

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CTX = { correlationId: "33333333-3333-4333-8333-333333333333", requestId: "req-1" } as never;
const DTO = { session_id: SESSION, worker_id: WORKER, text: "silai ka kaam karta hoon" };
const T0 = "2026-07-22T00:00:00.000Z";

/** A pinned occupation, as the envelope carries it once retrieval settles. */
const PIN = {
  job_domain_id: "jd_nco_7531_0100",
  label: "darzi",
  isco_unit_code: "7531",
  match_status: "matched_lexical" as const,
  match_score: 0.97,
  match_layer: "l0_exact" as const,
  pack_id: null,
  pack_version: null,
  catalog_version: "cat_2026_08",
};

/** The engine's envelope at the end of a complete interview. */
function envelope(over: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope {
  return {
    rev: 4,
    phase: "close",
    occupation: PIN,
    answerMap: [],
    engineAsks: 3,
    askCounts: {},
    servedQuestionKey: null,
    clarifyCount: 0,
    abusiveTurns: 0,
    silentTurns: 0,
    hardshipTurns: 0,
    needsDisambiguation: false,
    disambiguationOffer: [],
    identifyAttempts: 0,
    packId: "qp_tailoring",
    packVersion: 2,
    catalogVersion: "cat_2026_08",
    lastTurn: null,
    turnLatency: emptyTurnLatency(),
    occupationFamilyId: "fam_tailoring",
    occupationRepins: 0,
    llmStage: "domain",
    llmDraft: { domain_label: null, role_label: null, skills: [], experiences: [] },
    llmAsks: 0,
    llmFallback: false,
    llmGateOpen: false,
    ...over,
  };
}

/** One `AnswerRecord`, defaulted to a plain answered string. */
function answer(over: Record<string, unknown> = {}) {
  return {
    question_key: "trade",
    target_field: "trade",
    value_raw: "silai",
    value_normalized: "silai",
    status: "answered",
    evidence: null,
    turn: 1,
    history: [],
    ...over,
  };
}

function make(
  opts: {
    /** What the buffer holds BEFORE the turn. `null` = no buffer yet (first turn). */
    buffer?: Partial<TranscriptBuffer> | null;
    /** What the buffer holds AFTER the orchestrator's CAS write. Defaults to `buffer`. */
    written?: Partial<TranscriptBuffer> | null;
    /** The orchestrator's TurnResult, merged over a benign default. */
    turn?: Record<string, unknown>;
    latestProfile?: unknown;
    extractThrows?: boolean;
    workerName?: string | null;
    decryptThrows?: boolean;
    sessionStatus?: string;
    /** `endSession` loses the conditional update: another request flushed first. */
    flushLost?: boolean;
    /** The flush transaction throws (rolled back). */
    flushThrows?: boolean;
    /** The bulk answer INSERT throws — the flush must roll back with it. */
    answersThrow?: boolean;
    oneShotOpener?: boolean;
  } = {},
) {
  const session = {
    id: SESSION,
    workerId: WORKER,
    status: opts.sessionStatus ?? "active",
    conversationState: null,
    startedAt: new Date(),
  };

  let nextMessageId = 0;
  const chat = {
    findSession: vi.fn().mockResolvedValue(session),
    createSession: vi.fn().mockResolvedValue({ id: SESSION, status: "active", startedAt: T0 }),
    insertMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    listMessages: vi.fn().mockResolvedValue([]),
    saveConversationState: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      if (opts.flushThrows) throw new Error("deadlock detected");
      return work({ __tx: true });
    }),
    endSession: vi.fn().mockResolvedValue(!opts.flushLost),
    insertMessages: vi.fn(async (_tx: unknown, rows: { direction: string }[]) =>
      rows.map((r) => ({ ...r, id: `msg-${++nextMessageId}` })),
    ),
    insertPackAnswers: vi.fn(async () => {
      if (opts.answersThrow) throw new Error("wpa_answer_shape_chk violated");
    }),
  };

  const workers = {
    latestProfile: vi.fn().mockResolvedValue(opts.latestProfile ?? undefined),
    findById: vi.fn().mockResolvedValue({
      id: WORKER,
      fullName: opts.workerName == null ? null : "ENC_FULL_NAME_TOKEN",
    }),
  };
  const pii = {
    decrypt: vi.fn((_token: string) => {
      if (opts.decryptThrows) throw new Error("bad/rotated key");
      return opts.workerName ?? "";
    }),
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const profiles = {
    extract: opts.extractThrows
      ? vi.fn().mockRejectedValue(new Error("redis down"))
      : vi.fn().mockResolvedValue({ ai_job_id: "job-1", status: "queued" }),
  };

  const hydrate = (v: Partial<TranscriptBuffer> | null | undefined): TranscriptBuffer | null =>
    v === undefined || v === null
      ? null
      : (JSON.parse(
          JSON.stringify({
            workerId: WORKER,
            turnCount: 0,
            captured: {},
            roleFamily: "",
            messages: [],
            startedAt: T0,
            ...v,
          }),
        ) as TranscriptBuffer);

  // TWO STATES, because that is what really happens: `postMessage` loads once for the
  // ownership/terminal checks, the orchestrator writes under CAS, and `postMessage` RE-READS
  // what actually landed. Modelling them as one object would hide exactly the case this split
  // exists for — a competing writer whose turn won.
  // DEFAULTS TO AN EXISTING BUFFER, not to absent. A missing buffer on the RE-READ is the
  // "vanished after the CAS write" branch, which short-circuits the whole response — so leaving
  // it as the default would make most assertions below silently test that branch instead.
  const before = hydrate(opts.buffer === undefined ? {} : opts.buffer);
  const after = opts.written === undefined ? before : hydrate(opts.written);
  let loads = 0;
  const buffer = {
    load: vi.fn(async () => (loads++ === 0 ? before : after)),
    save: vi.fn(async () => undefined),
    drop: vi.fn(async () => undefined),
  };

  const orchestrator = {
    takeTurn: vi.fn(async () => ({
      reply: "Aap kis sheher mein rehte hain?",
      kind: "ask",
      questionKey: "current_city",
      options: [{ option_key: "pune", label_text: "Pune", value: "Pune", is_none_of_above: false }],
      progress: { answered: 3, total: 12 },
      unansweredEssentials: ["salary_expected"],
      complete: false,
      completionReason: null,
      replayed: false,
      excludeFromParse: false,
      unavailable: false,
      checkpointDue: false,
      ...opts.turn,
    })),
  };

  const config = {
    CHAT_ONE_SHOT_OPENER_ENABLED: opts.oneShotOpener ?? false,
    CHAT_MAX_TURNS: 30,
    CHAT_HISTORY_WINDOW_TURNS: 20,
    CHAT_TRANSCRIPT_TTL_SECONDS: 86_400,
  };

  const svc = new ChatService(
    config as never,
    chat as never,
    workers as never,
    pii as never,
    events as never,
    buffer as never,
    profiles as never,
    orchestrator as never,
  );
  return { svc, chat, workers, pii, events, buffer, profiles, config, orchestrator };
}

async function run(opts: Parameters<typeof make>[0] = {}) {
  const h = make(opts);
  const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
  return { ...h, res };
}

const emittedNames = (events: { emit: ReturnType<typeof vi.fn> }): string[] =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

const flushedRows = (chat: { insertMessages: ReturnType<typeof vi.fn> }) =>
  (chat.insertMessages.mock.calls[0]?.[1] ?? []) as {
    direction: string;
    bodyText: string;
    createdAt: Date;
  }[];

const answerRows = (chat: { insertPackAnswers: ReturnType<typeof vi.fn> }) =>
  (chat.insertPackAnswers.mock.calls[0]?.[1] ?? []) as Record<string, unknown>[];

function profileRow(over: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    workerId: WORKER,
    profileStatus: "draft",
    canonicalTradeId: null,
    canonicalRoleId: null,
    skills: [],
    machines: [],
    experience: {},
    salaryExpectation: {},
    locationPreference: { preferred_cities: [] },
    availability: { status: "unknown" },
    richProfileDraft: null,
    ...over,
  };
}

/** A completed interview: two messages, `completedAt` set, a pack pinned, answers recorded. */
const COMPLETED: Partial<TranscriptBuffer> = {
  turnCount: 3,
  completedAt: T0,
  completionReason: "fields_complete",
  captured: { trade: "silai" },
  messages: [
    { role: "worker", text: "silai ka kaam karta hoon", at: T0 },
    { role: "assistant", text: "Aap kis sheher mein rehte hain?", at: "2026-07-22T00:00:05.000Z" },
  ],
  profiling: envelope({ answerMap: [answer()] as never }),
};

// ---------------------------------------------------------------------------
// The headline: a turn calls no model and writes no row.
// ---------------------------------------------------------------------------

describe("ChatService.postMessage — deterministic, in-process, zero LLM calls", () => {
  it("has no AI seam at all — the acceptance criterion, asserted structurally", () => {
    // THE PLAN'S GATE IS "zero LLM calls between session start and completion", and the
    // strongest possible form of that assertion is that the class cannot make one: there is no
    // `AiService` in the constructor to call. A spy asserting `expect(ai.x).not.toHaveBeenCalled()`
    // would keep passing while someone added a second seam beside it.
    const { svc } = make();
    expect(Object.values(svc as unknown as Record<string, unknown>)).not.toContainEqual(
      expect.objectContaining({ profilingRespond: expect.anything() }),
    );
    expect(ChatService.length).toBe(8);
  });

  it("writes NO transcript, NO answers and NO events to Postgres mid-interview", async () => {
    // NARROWED FROM "writes NOTHING" IN PHASE 9, deliberately. The buffer design's promise was
    // never "no writes" — it was "no PER-TURN write amplification", which is what the ~150 rows
    // per interview actually were. Phase 9 adds ONE small state UPDATE every five asks (risk #10)
    // so a Redis TTL lapse costs at most four answers instead of the whole interview. That write
    // is asserted on its own below; what must stay absent is everything that scales with turns.
    const { chat, events } = await run();
    expect(chat.insertMessage).not.toHaveBeenCalled();
    expect(chat.insertMessages).not.toHaveBeenCalled();
    expect(chat.insertPackAnswers).not.toHaveBeenCalled();
    expect(chat.withTransaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // Not due on this turn, so not written: the checkpoint is paced, not per-turn.
    expect(chat.saveConversationState).not.toHaveBeenCalled();
  });

  describe("the mid-interview checkpoint (Phase 9, risk #10)", () => {
    it("persists the state — and ONLY the state — when the orchestrator says a boundary was crossed", async () => {
      const { chat } = await run({
        turn: { checkpointDue: true },
        written: { profiling: envelope({ phase: "occupation_specific", engineAsks: 5 }) },
      });

      expect(chat.saveConversationState).toHaveBeenCalledTimes(1);
      const [sessionId, state] = chat.saveConversationState.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(sessionId).toBe(SESSION);
      // The same projection the flush writes — phase, occupation, answer map, counters.
      expect(state).toMatchObject({ phase: "occupation_specific", engine_asks: 5 });
      // THE TRANSCRIPT MUST NOT BE IN IT. This is the line that keeps the checkpoint ~2 UPDATEs
      // per interview rather than a second copy of every message, and it is also the privacy
      // boundary: `chat_messages` is the only home of raw worker text before the flush.
      expect(state).not.toHaveProperty("messages");
      expect(JSON.stringify(state)).not.toContain(DTO.text);
      // Still no transcript rows and no transaction — the checkpoint is a bare UPDATE.
      expect(chat.insertMessages).not.toHaveBeenCalled();
      expect(chat.withTransaction).not.toHaveBeenCalled();
    });

    it("does NOT double-write when the same turn also completes the interview", async () => {
      // `finalizeInterview` writes the identical state through `endSession` INSIDE the flush
      // transaction. Checkpointing as well would be a second UPDATE of one column with one value,
      // outside that transaction — pure cost, and a write that could outlive a rolled-back flush.
      const { chat } = await run({
        turn: { checkpointDue: true, complete: true },
        written: { profiling: envelope(), completedAt: T0 },
      });

      expect(chat.endSession).toHaveBeenCalledTimes(1);
      expect(chat.saveConversationState).not.toHaveBeenCalled();
    });

    it("still checkpoints when the interview WANTED to end but the flush ROLLED BACK", async () => {
      // `complete` says the engine closed; `flushed` says it landed. When they differ, nothing
      // was written and the interview still exists only in Redis — which is exactly when losing
      // the buffer hurts most, because the worker has answered every question. Keying the skip on
      // `terminal` rather than on `turn.complete` is what keeps the checkpoint reachable here.
      //
      // `flushThrows`, NOT `flushLost`: the latter models another request having already
      // finalized the session, where the transcript IS durable and `finalizeInterview` correctly
      // reports success. Checkpointing an already-ended session would be the bug, not the fix.
      const { chat } = await run({
        turn: { checkpointDue: true, complete: true },
        written: { profiling: envelope({ engineAsks: 10 }) },
        flushThrows: true,
      });

      expect(chat.saveConversationState).toHaveBeenCalledTimes(1);
    });

    it("does NOT checkpoint when another request already finalized the session", async () => {
      // The mirror of the case above, and the reason `terminal` is not simply `!flushThrows`:
      // a lost conditional update means the session row is already `ended`, so this state write
      // would land on a finished interview.
      const { chat } = await run({
        turn: { checkpointDue: true, complete: true },
        written: { profiling: envelope({ engineAsks: 10 }) },
        flushLost: true,
      });

      expect(chat.saveConversationState).not.toHaveBeenCalled();
    });

    it("a failing checkpoint does not fail the worker's turn", async () => {
      // The record is the Redis buffer, already durable by this point; the checkpoint is a
      // backup. A worker who just answered a question gets the next question, not a 500 because
      // a redundant copy did not land.
      const { chat, svc } = make({
        turn: { checkpointDue: true },
        written: { profiling: envelope({ engineAsks: 5 }) },
      });
      chat.saveConversationState.mockRejectedValue(new Error("deadlock detected"));

      const res = await svc.postMessage(WORKER, DTO as never, CTX);

      expect(chat.saveConversationState).toHaveBeenCalledTimes(1);
      expect(res.reply).toBe("Aap kis sheher mein rehte hain?");
      expect(res.blocked).toBe(false);
    });
  });

  it("delegates the whole turn — the orchestrator owns the buffer write, not this service", async () => {
    const { buffer, orchestrator } = await run();
    expect(orchestrator.takeTurn).toHaveBeenCalledTimes(1);
    // NOT `save`. The orchestrator writes under a compare-and-swap on the envelope's `rev`;
    // a `save` here would be a second, unguarded writer and reintroduce the lost update the
    // CAS exists to remove.
    expect(buffer.save).not.toHaveBeenCalled();
  });

  it("threads the request context through, so a placement is traceable to its request", async () => {
    const { orchestrator } = await run();
    const input = (orchestrator.takeTurn.mock.calls as unknown[][])[0]?.[0] as {
      ctx: unknown;
      text: string;
    };
    expect(input.ctx).toBe(CTX);
    expect(input.text).toBe(DTO.text);
  });

  it("issues a BOUNDED, constant set of reads per turn (no N+1)", async () => {
    const { chat, buffer, workers } = await run();
    expect(chat.findSession).toHaveBeenCalledTimes(1);
    // TWO loads, and both are necessary: one before the turn for the ownership and terminal
    // checks, one after to read what the CAS actually wrote.
    expect(buffer.load).toHaveBeenCalledTimes(2);
    expect(workers.findById).toHaveBeenCalledTimes(1);
  });

  it("returns the progress bar and the pinned occupation label", async () => {
    const { res } = await run({ buffer: {}, written: { profiling: envelope() } });
    expect(res.progress).toEqual({ answered: 3, total: 12 });
    // The "you have been understood" moment — vernacular, never `label_en`.
    expect(res.occupation_label).toBe("darzi");
    expect(res.question_kind).toBe("ask");
    expect(res.is_mock).toBe(false);
  });

  it("surfaces the pack's reviewed option LABELS as the chips", async () => {
    const { res } = await run();
    expect(res.suggested_followups).toEqual(["Pune"]);
    expect(res.asked_question_id).toBe("current_city");
  });

  it("reports the mandatory questions still outstanding", async () => {
    const { res } = await run();
    expect(res.unanswered_essentials).toEqual(["salary_expected"]);
  });

  it("marks the closing turn as `close`", async () => {
    const { res } = await run({
      buffer: {},
      written: COMPLETED,
      turn: {
        complete: true,
        kind: "close",
        questionKey: null,
        completionReason: "fields_complete",
      },
    });
    expect(res.question_kind).toBe("close");
    expect(res.session_ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The disambiguation offer, and the option shape (#695 / #649)
// ---------------------------------------------------------------------------

/** What the orchestrator's offer branch actually produces: no pack key, chips, and the escape. */
const OFFER = {
  kind: "disambiguate" as const,
  reply: "Aap in mein se kaun sa kaam karte hain?",
  questionKey: null,
  options: [
    { option_key: "occ_0", label_text: "Welder", value: "Welder", is_none_of_above: false },
    { option_key: "occ_1", label_text: "Fitter", value: "Fitter", is_none_of_above: false },
    {
      option_key: DISAMBIGUATION_ESCAPE_KEY,
      label_text: DISAMBIGUATION_ESCAPE_LABEL,
      value: DISAMBIGUATION_ESCAPE_LABEL,
      is_none_of_above: true,
    },
  ],
};

describe("a disambiguation offer is not an ordinary ask", () => {
  it("serialises with question_kind `disambiguate`", async () => {
    // THE WHOLE POINT OF #695. `turn.complete ? "close" : "ask"` could never produce this, so a
    // real offer reached the worker app as an ordinary ask and rendered in the horizontal chip
    // scroller — the failure #649 was raised to fix, with its vertical single-select correct,
    // merged, and unreachable.
    const { res } = await run({ turn: OFFER });
    expect(res.question_kind).toBe("disambiguate");
  });

  it("still serialises an ordinary ask as `ask` — the existing value is unchanged", async () => {
    const { res } = await run();
    expect(res.question_kind).toBe("ask");
  });

  it("carries the option KEY and the escape FLAG, not just the label", async () => {
    const { res } = await run({ turn: OFFER });
    expect(res.suggested_options).toEqual([
      { option_key: "occ_0", label_text: "Welder", is_none_of_above: false },
      { option_key: "occ_1", label_text: "Fitter", is_none_of_above: false },
      {
        option_key: DISAMBIGUATION_ESCAPE_KEY,
        label_text: DISAMBIGUATION_ESCAPE_LABEL,
        is_none_of_above: true,
      },
    ]);
  });

  it("BINDS the escape to the config constant, so the client can stop matching on copy", async () => {
    // The client matched "none of these" against a hardcoded `'Kuch aur'` literal — a duplicate of
    // `DISAMBIGUATION_ESCAPE_LABEL` with no shared source and no test tying the two together. This
    // is that test: exactly one option is flagged, and it is the one the server built from the
    // constant. A copy change now moves the label without stranding the client's branch.
    const { res } = await run({ turn: OFFER });
    const escapes = res.suggested_options.filter((o) => o.is_none_of_above);
    expect(escapes).toHaveLength(1);
    expect(escapes[0]?.label_text).toBe(DISAMBIGUATION_ESCAPE_LABEL);
    expect(escapes[0]?.option_key).toBe(DISAMBIGUATION_ESCAPE_KEY);
  });

  it("leaves `value` and `implies_skill_id` off the wire — neither is renderable", async () => {
    const { res } = await run({ turn: OFFER });
    for (const option of res.suggested_options) {
      expect(Object.keys(option).sort()).toEqual(["is_none_of_above", "label_text", "option_key"]);
    }

    // ASSERTED AT THE SCHEMA, because the schema is what actually holds it. `res` has already been
    // through `PostMessageResponseSchema.parse`, whose default strip mode removes any key the
    // shape does not declare — so the loop above passes whether or not `toWireOption` forwards
    // `value`, and on its own it pins nothing. What can really regress is someone DECLARING one of
    // these on the DTO, and this is the assertion that fails when they do.
    const parsed = PostMessageResponseSchema.shape.suggested_options.parse([
      {
        option_key: "occ_a",
        label_text: "Welder",
        is_none_of_above: false,
        value: "Welder",
        implies_skill_id: "sk_welding",
      },
    ]);
    expect(Object.keys(parsed[0] ?? {}).sort()).toEqual([
      "is_none_of_above",
      "label_text",
      "option_key",
    ]);
  });

  it("keeps `suggested_followups` unchanged, so a client predating the field sees no difference", async () => {
    const { res } = await run({ turn: OFFER });
    expect(res.suggested_followups).toEqual(["Welder", "Fitter", DISAMBIGUATION_ESCAPE_LABEL]);
  });

  it("every kind the engine can produce is a value the wire enum declares", () => {
    // The engine's set is deliberately NARROWER than the schema's — `clarify` is declared and
    // never produced. This asserts the containment rather than the equality, so the two can only
    // drift in the direction that cannot serve a client a value it has never seen.
    const declared = PostMessageResponseSchema.shape.question_kind;
    for (const kind of TURN_KINDS) {
      expect(declared.safeParse(kind).success, `${kind} is not on the wire`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Degradation, replay, and the terminal session
// ---------------------------------------------------------------------------

describe("ChatService.postMessage — degradation is a true no-op", () => {
  it("orchestrator wrote nothing → nothing is flushed and the worker may retry", async () => {
    const { res, chat } = await run({ turn: { unavailable: true, reply: "Abhi thodi dikkat" } });
    expect(res.session_ended).toBe(false);
    expect(res.extraction_ready).toBe(false);
    expect(res.progress).toBeNull();
    expect(chat.withTransaction).not.toHaveBeenCalled();
  });

  it("a replayed turn returns the previous reply and changes nothing", async () => {
    const { res, chat, buffer } = await run({
      turn: { replayed: true, reply: "Aap kis sheher mein rehte hain?" },
    });
    expect(res.reply).toBe("Aap kis sheher mein rehte hain?");
    expect(res.session_ended).toBe(false);
    expect(chat.withTransaction).not.toHaveBeenCalled();
    // The replay short-circuits BEFORE the re-read: there is nothing new to read.
    expect(buffer.load).toHaveBeenCalledTimes(1);
  });

  it("a REPLAYED disambiguation stays a disambiguation, with its chips (#695)", async () => {
    // The orchestrator caches the options precisely so a replay is the response it claims to
    // repeat; this site then dropped them and hardcoded `question_kind: "ask"`. Together those
    // made the second delivery of an offer strictly worse than the first — and with the kind now
    // real, dropping the chips would tell the client to draw a single-select with nothing in it.
    // A worker resubmitting over a bad 2G link gets what they got the first time.
    const { res } = await run({ turn: { ...OFFER, replayed: true } });
    expect(res.question_kind).toBe("disambiguate");
    expect(res.suggested_followups).toEqual(["Welder", "Fitter", DISAMBIGUATION_ESCAPE_LABEL]);
    expect(res.suggested_options.filter((o) => o.is_none_of_above)).toHaveLength(1);
  });

  it("a degraded turn is `ask` with nothing to tap — the worker retries into a live session", async () => {
    const { res } = await run({ turn: { unavailable: true, reply: "Abhi thodi dikkat" } });
    expect(res.question_kind).toBe("ask");
    expect(res.suggested_options).toEqual([]);
  });

  it("a message posted to an ALREADY FINALIZED session is terminal, free, and idempotent", async () => {
    const { res, orchestrator, chat } = await run({ sessionStatus: "ended" });
    expect(res.session_ended).toBe(true);
    expect(res.extraction_ready).toBe(true);
    expect(orchestrator.takeTurn).not.toHaveBeenCalled();
    expect(chat.withTransaction).not.toHaveBeenCalled();
  });

  it("a session that is not yours is 404, never 403 — no existence oracle", async () => {
    const h = make();
    h.chat.findSession.mockResolvedValue({
      id: SESSION,
      workerId: "someone-else",
      status: "active",
    });
    await expect(h.svc.postMessage(WORKER, DTO as never, CTX)).rejects.toThrow(/not found/i);
    expect(h.orchestrator.takeTurn).not.toHaveBeenCalled();
  });

  it("a buffer that vanishes after the CAS write still serves the reply", async () => {
    // A TTL lapse at the worst possible instant. The turn happened; the interview restarts on
    // the next POST. Serving a 500 here would show an error for something that succeeded.
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { res } = await run({ buffer: {}, written: null });
    expect(res.session_ended).toBe(false);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// The flush — still the only write
// ---------------------------------------------------------------------------

describe("ChatService — flush at end", () => {
  const complete = { complete: true, questionKey: null, completionReason: "fields_complete" };

  it("writes the WHOLE transcript in one transaction, then drops the buffer", async () => {
    const { chat, buffer, res } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    expect(chat.withTransaction).toHaveBeenCalledTimes(1);
    expect(flushedRows(chat)).toHaveLength(2);
    expect(buffer.drop).toHaveBeenCalledTimes(1);
    expect(res.session_ended).toBe(true);
  });

  it("preserves each message's ORIGINAL time, not the flush time", async () => {
    const { chat } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    const rows = flushedRows(chat);
    expect(rows[0]?.createdAt).toEqual(new Date(T0));
    expect(rows[1]?.createdAt).toEqual(new Date("2026-07-22T00:00:05.000Z"));
  });

  it("maps worker→inbound and assistant→outbound", async () => {
    const { chat } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    expect(flushedRows(chat).map((r) => r.direction)).toEqual(["inbound", "outbound"]);
  });

  it("emits one event per message plus the readiness signal and the interview record, all inside the tx", async () => {
    const { chat, events } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    expect(emittedNames(events)).toEqual([
      "chat.message_received",
      "chat.message_sent",
      "profile.extraction_ready",
      "profile.interview_completed",
    ]);
    for (const call of events.emit.mock.calls) {
      expect((call[0] as { tx: unknown }).tx).toEqual({ __tx: true });
    }
    expect(chat.withTransaction).toHaveBeenCalledTimes(1);
  });

  describe("profile.interview_completed — the engine's own telemetry (Phase 9)", () => {
    const payloadOf = (events: { emit: ReturnType<typeof vi.fn> }) =>
      (
        events.emit.mock.calls.find(
          (c) => (c[0] as { event_name: string }).event_name === "profile.interview_completed",
        )?.[0] as { payload: Record<string, unknown> } | undefined
      )?.payload;

    it("carries the latency histogram, the ask count and the pin — the three the plan gates on", async () => {
      const { events } = await run({
        buffer: {},
        turn: complete,
        written: {
          ...COMPLETED,
          turnCount: 14,
          profiling: envelope({
            engineAsks: 12,
            turnLatency: { le_100: 8, le_200: 3, le_400: 2, le_800: 1, gt_800: 0, max_ms: 612 },
          }),
        },
      });

      expect(payloadOf(events)).toMatchObject({
        turn_count: 14,
        ask_count: 12,
        occupation_pinned: true,
        match_layer: "l0_exact",
        pack_id: "qp_tailoring",
        pack_version: 2,
        turn_latency_ms: { le_100: 8, le_200: 3, le_400: 2, le_800: 1, gt_800: 0, max_ms: 612 },
      });
    });

    it("counts declined SEPARATELY from unanswered", async () => {
      // "nahi pata" is a COMPLETE answer. Folding it into `unanswered` would erase the
      // difference between a worker who told us they do not know and a question that never
      // settled — a question-quality problem versus an engine problem.
      const { events } = await run({
        buffer: {},
        turn: complete,
        written: {
          ...COMPLETED,
          profiling: envelope({
            answerMap: [
              answer({ question_key: "q_a" }),
              answer({ question_key: "q_b", status: "declined", value_raw: "nahi pata" }),
              answer({ question_key: "q_c", status: "unanswered", value_raw: "" }),
              answer({ question_key: "q_d", status: "superseded", value_raw: "5 saal" }),
            ] as never,
          }),
        },
      });

      expect(payloadOf(events)).toMatchObject({
        answered_count: 1,
        declined_count: 1,
        unanswered_count: 1, // and `superseded` counted under none of them — it is history
      });
    });

    it("drops a completion_reason that is not a slug rather than rolling back the interview", async () => {
      // The emit is INSIDE the flush transaction, so an unvalidated reason would trade a
      // worker's entire completed interview for an observability field. Same asymmetry as
      // `slugFieldIds`.
      const { events } = await run({
        buffer: {},
        turn: complete,
        written: {
          ...COMPLETED,
          completionReason: "worker Ramesh gave up" as never,
          profiling: envelope(),
        },
      });

      expect(payloadOf(events)).toMatchObject({ completion_reason: null });
    });

    it("is NOT emitted when the flush rolls back — no telemetry claims a completion that did not happen", async () => {
      const { events } = await run({
        buffer: {},
        turn: complete,
        written: COMPLETED,
        flushThrows: true,
      });
      expect(emittedNames(events)).not.toContain("profile.interview_completed");
    });
  });

  it("every event carries a stable idempotency key", async () => {
    const { events } = await run({ buffer: {}, written: COMPLETED, turn: complete });
    for (const call of events.emit.mock.calls) {
      expect((call[0] as { idempotencyKey?: string }).idempotencyKey).toBeTruthy();
    }
  });

  it("IDEMPOTENT: a lost conditional update writes no messages and no answers", async () => {
    const { chat, events, buffer } = await run({
      buffer: {},
      written: COMPLETED,
      turn: complete,
      flushLost: true,
    });
    expect(chat.insertMessages).not.toHaveBeenCalled();
    expect(chat.insertPackAnswers).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // The transcript is durable — somebody else wrote it — so the key is ours to clear.
    expect(buffer.drop).toHaveBeenCalledTimes(1);
  });

  it("a FAILED flush keeps the buffer and never 500s the worker", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { res, buffer } = await run({
      buffer: {},
      written: COMPLETED,
      turn: complete,
      flushThrows: true,
    });
    expect(res.session_ended).toBe(false);
    expect(res.extraction_ready).toBe(false);
    // NOT dropped. Dropping on a failed flush would destroy the only copy of the interview.
    expect(buffer.drop).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("RETRIES a completed-but-unflushed buffer on the next POST, taking no new turn", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { res, chat, orchestrator } = await run({ buffer: COMPLETED });
    expect(chat.withTransaction).toHaveBeenCalledTimes(1);
    expect(res.session_ended).toBe(true);
    // The interview is already over. Spending another turn on it would be pure waste.
    expect(orchestrator.takeTurn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("the readiness payload carries slug field ids only — never PII, never a value", async () => {
    const { events } = await run({
      buffer: {},
      written: {
        ...COMPLETED,
        captured: { trade: "silai", "Ramesh Kumar": "x", experience_years: "7" },
      },
      turn: complete,
    });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const ready = events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "profile.extraction_ready",
    );
    const topics = (ready?.[0] as { payload: { answered_topics: string[] } }).payload
      .answered_topics;
    expect(topics).toEqual(["experience_years", "trade"]);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// worker_pack_answer — the Phase 8 addition
// ---------------------------------------------------------------------------

describe("ChatService — the answer map lands in worker_pack_answer", () => {
  const complete = { complete: true, questionKey: null, completionReason: "fields_complete" };

  const withAnswers = (records: Record<string, unknown>[], env: Partial<ProfilingEnvelope> = {}) =>
    run({
      buffer: {},
      written: { ...COMPLETED, profiling: envelope({ answerMap: records as never, ...env }) },
      turn: complete,
    });

  it("writes ONE multi-row INSERT, not one statement per question", async () => {
    const { chat } = await withAnswers([
      answer({ question_key: "trade" }),
      answer({ question_key: "current_city", value_normalized: "pune" }),
      answer({ question_key: "experience_years", value_normalized: 7 }),
    ]);
    expect(chat.insertPackAnswers).toHaveBeenCalledTimes(1);
    expect(answerRows(chat)).toHaveLength(3);
  });

  it("routes each value to the ONE typed column its type implies", async () => {
    const { chat } = await withAnswers([
      answer({ question_key: "trade", value_normalized: "silai" }),
      answer({ question_key: "experience_years", value_normalized: 7 }),
      answer({ question_key: "can_relocate", value_normalized: true }),
      answer({ question_key: "shifts", value_normalized: ["day", "night"] }),
    ]);
    const rows = answerRows(chat);
    expect(rows[0]).toMatchObject({ answerText: "silai", status: "answered" });
    expect(rows[1]).toMatchObject({ answerNumber: 7 });
    expect(rows[2]).toMatchObject({ answerBool: true });
    expect(rows[3]).toMatchObject({ answerOptionKeys: ["day", "night"] });
    // EXACTLY ONE value column per row — `wpa_answer_shape_chk` is a biconditional, so a row
    // with two would be rejected by Postgres and take the whole flush down with it.
    for (const row of rows) {
      const filled = ["answerText", "answerNumber", "answerBool", "answerOptionKeys"].filter(
        (k) => row[k] !== undefined,
      );
      expect(filled).toHaveLength(1);
    }
  });

  it("persists a DECLINED answer with no value — 'nahi pata' is a fact, not a gap", async () => {
    const { chat } = await withAnswers([
      answer({ question_key: "salary_expected", status: "declined", value_normalized: null }),
    ]);
    const row = answerRows(chat)[0];
    expect(row).toMatchObject({ status: "declined" });
    expect(row?.answerText).toBeUndefined();
    expect(row?.answerNumber).toBeUndefined();
  });

  it("skips `unanswered` records — that is a fact about the conversation, not the worker", async () => {
    const { chat } = await withAnswers([
      answer({ question_key: "trade" }),
      answer({ question_key: "shift_pref", status: "unanswered", value_normalized: null }),
    ]);
    expect(answerRows(chat).map((r) => r.questionKey)).toEqual(["trade"]);
  });

  it("downgrades an `answered` record with an unrepresentable value to `declined`", async () => {
    // Dropping it instead would make the question look never-asked, and a later re-interview
    // would ask it again. The honest reading is "settled, no value".
    const { chat } = await withAnswers([
      answer({ question_key: "trade", value_normalized: { weird: true } }),
    ]);
    expect(answerRows(chat)[0]).toMatchObject({ questionKey: "trade", status: "declined" });
  });

  it("drops a question key that would fail the payload's slug filter", async () => {
    // Inside the flush transaction, so a malformed key must not be allowed to roll the whole
    // interview back — the same asymmetry `slugFieldIds` exists for.
    const { chat } = await withAnswers([
      answer({ question_key: "trade" }),
      answer({ question_key: "Mera Naam Ramesh" }),
    ]);
    expect(answerRows(chat).map((r) => r.questionKey)).toEqual(["trade"]);
  });

  it("writes nothing at all when no pack was ever pinned", async () => {
    // Without a pack pointer a row is unreadable: two packs may legitimately own
    // `experience_years` with different wording.
    const { chat } = await withAnswers([answer()], { packId: null, packVersion: null });
    expect(chat.insertPackAnswers).not.toHaveBeenCalled();
    // …and the transcript still lands. The answers are a projection of it, not a precondition.
    expect(chat.insertMessages).toHaveBeenCalledTimes(1);
  });

  it("stamps the pack pointer and the session on every row", async () => {
    const { chat } = await withAnswers([answer()]);
    expect(answerRows(chat)[0]).toMatchObject({
      workerId: WORKER,
      chatSessionId: SESSION,
      packId: "qp_tailoring",
      packVersion: 2,
      source: "chat",
    });
  });

  it("a failing answer INSERT rolls the WHOLE flush back — no orphan transcript", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const h = make({
      buffer: {},
      written: COMPLETED,
      turn: complete,
      answersThrow: true,
    });
    // `withTransaction` here runs the work inline, so the throw propagates exactly as a real
    // rollback would — and `finalizeInterview` must swallow it into `false`, not a 500.
    const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
    expect(res.session_ended).toBe(false);
    expect(h.buffer.drop).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Extraction auto-trigger — unchanged behaviour, new turn loop
// ---------------------------------------------------------------------------

describe("ChatService — auto-trigger extraction on completion", () => {
  const complete = { complete: true, questionKey: null, completionReason: "fields_complete" };
  const done = { buffer: {}, written: COMPLETED, turn: complete };

  it("triggers extraction exactly once", async () => {
    const { profiles } = await run(done);
    expect(profiles.extract).toHaveBeenCalledTimes(1);
  });

  it("does not trigger while the interview is not yet complete", async () => {
    const { profiles } = await run();
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("skips extraction if the worker already has a REAL profile", async () => {
    const { profiles } = await run({
      ...done,
      latestProfile: profileRow({ skills: [{ skill_id: "msk_stitching" }] }),
    });
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("RE-TRIGGERS when the stored profile is an empty placeholder (the poison heals)", async () => {
    const { profiles } = await run({ ...done, latestProfile: profileRow() });
    expect(profiles.extract).toHaveBeenCalledTimes(1);
  });

  it("never breaks the chat reply if the extraction trigger throws", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { res } = await run({ ...done, extractThrows: true });
    expect(res.session_ended).toBe(true);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// The worker-name seam (SG-1) — still the client reply only
// ---------------------------------------------------------------------------

describe("ChatService — AI-PERSONA-2 worker-name seam (SG-1 PII boundary)", () => {
  const named = (over: Record<string, unknown> = {}) => ({
    workerName: "Suresh Kumar",
    turn: { reply: "{{worker_name}} ji, aap kis sheher mein rehte hain?" },
    ...over,
  });

  it("interpolates the real FIRST name into the client reply only", async () => {
    const { res, buffer } = await run(named());
    expect(res.reply).toBe("Suresh ji, aap kis sheher mein rehte hain?");
    // Nothing durable was rewritten: the orchestrator buffered the RAW reply, and this service
    // never writes the buffer at all.
    expect(buffer.save).not.toHaveBeenCalled();
  });

  it("inserts a name with `$` special-replacement chars literally (no pattern expansion)", async () => {
    const { res } = await run(named({ workerName: "A$&B Kumar" }));
    expect(res.reply).toBe("A$&B ji, aap kis sheher mein rehte hain?");
  });

  it("null name → clean no-vocative reply, no residual {{ }} token", async () => {
    const { res } = await run(named({ workerName: null }));
    expect(res.reply).not.toContain("{{");
    expect(res.reply).toContain("aap kis sheher");
  });

  it("undecryptable name (rotated/tampered key) degrades to no-vocative, never 500s", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { res } = await run(named({ decryptThrows: true }));
    expect(res.reply).not.toContain("{{");
    vi.restoreAllMocks();
  });

  it("exactly ONE name read per turn", async () => {
    const { workers, pii } = await run(named());
    expect(workers.findById).toHaveBeenCalledTimes(1);
    expect(pii.decrypt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The lookahead on the wire (#765)
// ---------------------------------------------------------------------------

/**
 * THE ENGINE IS PROVEN ELSEWHERE; THIS IS THE WIRING, and it was the untested half.
 *
 * `lookahead.test.ts` and `lookahead.corpus.test.ts` cover `computeLookahead` against every
 * single-select chip in the shipped corpus — but both of them stop at a `Lookahead` value.
 * Everything between that value and a worker's screen was unasserted when the feature merged:
 * the name interpolation, the option projection, the null passthrough, and the outbound schema.
 *
 * That gap is worse here than it looks, because a wrong prediction is SILENT BY DESIGN. The
 * contract is advisory, so a client that renders a stale question simply repaints and nobody
 * files a bug — which is exactly the condition under which a regression survives to production.
 */
describe("ChatService — the lookahead reaches the client (#765)", () => {
  /** One predicted turn, in the engine's shape (`LookaheadEntry`), defaulted to a plain ask. */
  const entry = (over: Record<string, unknown> = {}) => ({
    questionKey: "years_experience",
    kind: "ask",
    promptText: "Kitne saal ka tajurba hai?",
    whyText: null,
    answerType: "number",
    options: [],
    progress: { answered: 4, total: 12 },
    ...over,
  });

  const at = (res: { lookahead: unknown }, key: string) =>
    (res.lookahead as Record<string, Record<string, unknown>> | null)?.[key];

  it("passes the prediction through, keyed by the answer that would produce it", async () => {
    const { res } = await run({
      turn: {
        lookahead: {
          __declined: entry(),
          pune: entry({ questionKey: "salary_expected", promptText: "Kitni salary chahiye?" }),
        },
      },
    });

    expect(Object.keys(res.lookahead ?? {}).sort()).toEqual(["__declined", "pune"]);
    expect(at(res, "pune")?.question_key).toBe("salary_expected");
    expect(at(res, "pune")?.prompt_text).toBe("Kitni salary chahiye?");
    expect(at(res, "__declined")?.question_kind).toBe("ask");
    expect(at(res, "__declined")?.progress).toEqual({ answered: 4, total: 12 });
  });

  it("interpolates {{worker_name}} into the PREDICTED prompt and why-text, not just the reply", async () => {
    // THE PLAN NAMED THIS ASSERTION and it was the one most worth having: `projectTurn`
    // interpolated `turn.reply` and nothing else for the whole of Phase 8, so a predicted
    // question carrying the token would reach a worker's screen as the literal characters
    // `{{worker_name}}` — on the one path that renders WITHOUT a round trip, and therefore
    // without anything downstream to catch it.
    const { res } = await run({
      workerName: "Suresh Kumar",
      turn: {
        lookahead: {
          pune: entry({
            promptText: "{{worker_name}} ji, kitne saal ka tajurba hai?",
            whyText: "{{worker_name}} ji, isse sahi kaam milega.",
          }),
        },
      },
    });

    expect(at(res, "pune")?.prompt_text).toBe("Suresh ji, kitne saal ka tajurba hai?");
    expect(at(res, "pune")?.why_text).toBe("Suresh ji, isse sahi kaam milega.");
  });

  it("leaves NO residual {{ }} token in any predicted string when the worker has no name", async () => {
    const { res } = await run({
      workerName: null,
      turn: {
        lookahead: {
          a: entry({ promptText: "{{worker_name}} ji, kitna tajurba?", whyText: "{{unknown}} ji." }),
          b: entry({ promptText: "Kaam kahan karte ho?" }),
        },
      },
    });

    // Serialized rather than field-by-field on purpose: this must hold for every string the
    // shape carries, including ones added later.
    expect(JSON.stringify(res.lookahead)).not.toContain("{{");
    // The WHOLE vocative goes, not just the token — a bare "ji, kitna tajurba?" would read as a
    // sentence missing its subject. Same treatment the reply gets.
    expect(at(res, "a")?.prompt_text).toBe("kitna tajurba?");
    // An UNRECOGNISED token takes the blunt path instead (`replace(/\{\{[^}]*\}\}/g, "")`), which
    // removes the token and leaves its surrounding whitespace — asserted trimmed rather than
    // exactly, because the residue is cosmetic and shared with the reply path. What matters is
    // that no unresolved token survives; tightening the spacing would be a behaviour change and
    // belongs with the reply, not in a coverage PR.
    expect(at(res, "a")?.why_text).not.toContain("unknown");
    expect(String(at(res, "a")?.why_text).trim()).toBe("ji.");
    // A prediction with no token at all is passed through byte-for-byte.
    expect(at(res, "b")?.prompt_text).toBe("Kaam kahan karte ho?");
  });

  it("projects predicted options to key/label/flag — never `value` or `implies_skill_id`", async () => {
    const { res } = await run({
      turn: {
        lookahead: {
          pune: entry({
            options: [
              {
                option_key: "mig",
                label_text: "MIG",
                value: "mig_welding",
                implies_skill_id: "skl_mig",
                is_none_of_above: false,
              },
            ],
          }),
        },
      },
    });

    // Same closed projection the served question gets. `implies_skill_id` is a taxonomy internal
    // with no business on a worker's device, and `value` is engine business — a client that could
    // see either would be tempted to answer with it.
    expect(at(res, "pune")?.options).toEqual([
      { option_key: "mig", label_text: "MIG", is_none_of_above: false },
    ]);
  });

  it("reads the worker's name ONCE no matter how many branches are predicted", async () => {
    // `renderPackText` runs per entry; the decrypt must not. A per-branch read would multiply
    // the PII decrypt on the hot path by the option count.
    const { pii, workers } = await run({
      workerName: "Suresh Kumar",
      turn: {
        lookahead: Object.fromEntries(
          ["a", "b", "c", "d", "e"].map((k) => [k, entry({ questionKey: `q_${k}` })]),
        ),
      },
    });

    expect(workers.findById).toHaveBeenCalledTimes(1);
    expect(pii.decrypt).toHaveBeenCalledTimes(1);
  });

  it("a turn with no exact prediction sends `lookahead: null`, with the key present", async () => {
    const { res } = await run({ turn: { lookahead: null } });
    // PRESENT-AND-NULL, not absent: `null` is the engine saying "prediction would not be exact
    // here" (a close, a disambiguation, free text), which the client must be able to read as a
    // fact rather than infer from a missing key.
    expect("lookahead" in res).toBe(true);
    expect(res.lookahead).toBeNull();
  });

  it("an old client's payload — no `lookahead` at all — still validates and defaults to null", async () => {
    // BACKWARD COMPATIBILITY (CLAUDE.md §3). The worker app ships slowly; a body produced before
    // this field existed must keep parsing, and must not arrive as `undefined` for a client
    // reading the parsed shape.
    const { res } = await run();
    const { lookahead: _dropped, ...withoutLookahead } = res;
    const reparsed = PostMessageResponseSchema.safeParse(withoutLookahead);

    expect(reparsed.success).toBe(true);
    expect(reparsed.success && reparsed.data.lookahead).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The opener
// ---------------------------------------------------------------------------

/**
 * #896 — the Devanagari read-aloud sibling.
 *
 * The premise of the whole feature is a worker who CANNOT READ THE SCREEN, so the failure these
 * tests guard is silent by construction: a missing or wrong `tts_text` produces a response that
 * looks perfect in a diff and is mispronounced on a phone. Every assertion below is therefore
 * about the WIRE — present, absent, or equal to a specific string — never about the lookup.
 */
describe("ChatService — tts_text, the read-aloud sibling (#896)", () => {
  const CLOSING = "Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.";
  const UNAVAILABLE = "Abhi thodi dikkat aa rahi hai. Ek minute baad dobara bhejiye.";

  it("carries the Devanagari twin of a CONSTANT reply", async () => {
    const { res } = await run({ turn: { unavailable: true, reply: UNAVAILABLE } });
    expect(res.reply).toBe(UNAVAILABLE);
    expect((res as Record<string, unknown>).tts_text).toBe(
      "अभी थोड़ी दिक्कत आ रही है। एक मिनट बाद दोबारा भेजिये।",
    );
  });

  it("OMITS the key entirely for an unauthored reply — the client then speaks the roman text", async () => {
    // A string NO pack contains — the corpus now covers the whole reply closure, so a real pack
    // question would resolve and this would assert nothing. `in` rather than a null check, because
    // `tts_text: null` would deserialize as a present-but-empty field on a client that treats null
    // as "speak nothing".
    const { res } = await run({ turn: { reply: "Kya aap chandrayaan udate hain?" } });
    expect("tts_text" in (res as Record<string, unknown>)).toBe(false);
  });

  it("a TERMINAL turn into a finished session still reads aloud", async () => {
    const { res } = await run({ sessionStatus: "ended" });
    expect(res.reply).toBe(CLOSING);
    expect((res as Record<string, unknown>).tts_text).toBe(
      "आपकी बात पूरी हो चुकी है। प्रोफ़ाइल तैयार हो रही है।",
    );
  });

  it("a REPLAYED turn repeats the twin along with the reply", async () => {
    const { res } = await run({ turn: { replayed: true, reply: CLOSING } });
    expect((res as Record<string, unknown>).tts_text).toBe(
      "आपकी बात पूरी हो चुकी है। प्रोफ़ाइल तैयार हो रही है।",
    );
  });

  it("never carries a raw {{worker_name}} — the twin is rendered through the same path as the reply", async () => {
    const { res } = await run({ turn: { unavailable: true, reply: UNAVAILABLE } });
    expect((res as Record<string, unknown>).tts_text).not.toContain("{{");
  });
});

describe("ChatService.listMessages — replayed questions read aloud too (#896)", () => {
  it("adds tts_text to OUTBOUND rows and never to inbound ones", async () => {
    // `buffer: null` forces the POSTGRES branch — no buffer, so hydration reads rows.
    const { svc, chat } = make({ buffer: null });
    chat.listMessages.mockResolvedValue([
      {
        direction: "outbound",
        bodyText: "Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.",
        createdAt: new Date("2026-08-17T05:00:00.000Z"),
      },
      // The worker's OWN words. Even when they coincide with an authored string, nothing reads a
      // worker's message back to them — so the key must be absent on this row.
      {
        direction: "inbound",
        bodyText: "Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.",
        createdAt: new Date("2026-08-17T05:00:01.000Z"),
      },
    ]);

    const res = await svc.listMessages(WORKER, SESSION);
    const [outbound, inbound] = res.messages as unknown as Record<string, unknown>[];

    expect(outbound!.tts_text).toBe("आपकी बात पूरी हो चुकी है। प्रोफ़ाइल तैयार हो रही है।");
    expect("tts_text" in inbound!).toBe(false);
  });

  it("resolves from the BUFFER branch on the same rule", async () => {
    // Through `make`, so the buffer is a REAL TranscriptBuffer (turnCount, captured, roleFamily,
    // startedAt) rather than the two fields this assertion happens to read.
    const { svc } = make({
      buffer: {
        messages: [
          {
            role: "assistant",
            text: "Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.",
            at: "2026-08-17T05:00:00.000Z",
          },
          { role: "worker", text: "haan", at: "2026-08-17T05:00:01.000Z" },
        ],
      },
    });

    const res = await svc.listMessages(WORKER, SESSION);
    const [assistant, worker] = res.messages as unknown as Record<string, unknown>[];

    expect(assistant!.tts_text).toBe("आपकी बात पूरी हो चुकी है। प्रोफ़ाइल तैयार हो रही है।");
    expect("tts_text" in worker!).toBe(false);
  });
});

describe("ChatService.startSession — the opener is reviewed copy, not a model call", () => {
  it("omits opening_text entirely when the flag is off", async () => {
    const { svc } = make();
    const res = (await svc.startSession(WORKER, CTX)) as Record<string, unknown>;
    expect("opening_text" in res).toBe(false);
  });

  it("serves the static opener when the flag is on, with no outbound call", async () => {
    const { svc } = make({ oneShotOpener: true });
    const res = (await svc.startSession(WORKER, CTX)) as Record<string, unknown>;
    expect(res.opening_text).toContain("Namaste");
    // ON-PERSONA, mechanically: one question mark, no exclamation, no emoji.
    const text = res.opening_text as string;
    expect((text.match(/\?/g) ?? []).length).toBe(1);
    expect(text).not.toMatch(/!/);
  });

  it("serves opening_tts_text beside it, so turn one reads aloud (#896)", async () => {
    const { svc } = make({ oneShotOpener: true });
    const res = (await svc.startSession(WORKER, CTX)) as Record<string, unknown>;
    expect(res.opening_tts_text).toBe(
      "नमस्ते। आप कौन सा काम करते हैं, कहाँ रहते हैं, और कितना तजुर्बा है?",
    );
  });

  it("omits opening_tts_text when the opener itself is omitted", async () => {
    const { svc } = make();
    const res = (await svc.startSession(WORKER, CTX)) as Record<string, unknown>;
    expect("opening_tts_text" in res).toBe(false);
  });

  it("still emits chat.session_started", async () => {
    const { svc, events } = make();
    await svc.startSession(WORKER, CTX);
    expect(emittedNames(events)).toEqual(["chat.session_started"]);
  });
});
