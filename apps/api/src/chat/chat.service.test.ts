import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { ChatService } from "./chat.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CTX = { correlationId: "33333333-3333-4333-8333-333333333333", requestId: "req-1" } as never;
const DTO = { session_id: SESSION, worker_id: WORKER, text: "I run a VMC, 5 years in Pune" };

// A state where all essential topics are answered → the interview is ready.
const READY_STATE = {
  role_family: "cnc_vmc",
  turn_count: 4,
  answered_topics: ["role", "machines", "experience", "location"],
  asked_question_ids: ["q_role", "q_machines"],
  collected: {},
};

function make(
  opts: {
    conversationState?: unknown;
    extractionReady?: boolean;
    latestProfile?: unknown;
    extractThrows?: boolean;
    // AI-PERSONA-2: reply_text the (mock) ai-service returns; the DECRYPTED name to
    // simulate (null = not set), and whether decrypt throws (rotated/tampered key).
    replyText?: string;
    workerName?: string | null;
    decryptThrows?: boolean;
    // CHAT-UE-1: exact updated_state the ai seam returns — including explicitly
    // `null` (the REAL service's blocked/fail-closed leg; the mock fallback never
    // returns null) or a MALFORMED value.
    updatedState?: unknown;
    /** One-shot opener: the flag, and what the ai seam returns for it. */
    oneShotOpener?: boolean;
    openingText?: string | null;
  } = {},
) {
  const session = {
    id: SESSION,
    workerId: WORKER,
    status: "active",
    conversationState: opts.conversationState ?? null,
  };
  const chat = {
    findSession: vi.fn().mockResolvedValue(session),
    createSession: vi.fn().mockResolvedValue({
      id: SESSION,
      status: "active",
      startedAt: "2026-07-22T00:00:00.000Z",
    }),
    insertMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    listMessages: vi.fn().mockResolvedValue([]),
    saveConversationState: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
  };
  const workers = {
    latestProfile: vi.fn().mockResolvedValue(opts.latestProfile ?? undefined),
    // full_name is stored ENCRYPTED (TD21); the plaintext lives only behind pii.decrypt.
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
  const ai = {
    profilingOpening: vi.fn().mockResolvedValue(
      opts.openingText === undefined ? "OPENER TEXT" : opts.openingText,
    ),
    profilingRespond: vi.fn().mockResolvedValue({
      reply_text: opts.replyText ?? "Thanks!",
      blocked: false,
      is_mock: true,
      suggested_followups: [],
      asked_question_id: "q_machines",
      extraction_ready: opts.extractionReady ?? false,
      updated_state:
        opts.updatedState !== undefined
          ? opts.updatedState
          : opts.extractionReady
            ? READY_STATE
            : { ...READY_STATE, answered_topics: ["role"] },
    }),
  };
  const profiles = {
    extract: opts.extractThrows
      ? vi.fn().mockRejectedValue(new Error("redis down"))
      : vi.fn().mockResolvedValue({ ai_job_id: "job-1", status: "queued" }),
  };
  const config = { CHAT_ONE_SHOT_OPENER_ENABLED: opts.oneShotOpener ?? false };
  const svc = new ChatService(
    config as never,
    chat as never,
    workers as never,
    pii as never,
    events as never,
    ai as never,
    profiles as never,
  );
  return { svc, chat, workers, pii, events, ai, profiles, config };
}

const emittedNames = (events: { emit: ReturnType<typeof vi.fn> }): string[] =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

/**
 * A persisted `worker_profiles` row as `WorkersRepository.latestProfile` returns it
 * (a `select()` of the whole row).
 *
 * DEFAULTS TO THE PLACEHOLDER (T3): every content column at its schema default —
 * byte-for-byte what the processor persists when `AiService.extractProfile`
 * fabricates `DraftProfileSchema.parse({})` because the ai-service was unreachable.
 * That is deliberately the default, because the auto-trigger guard's whole job is now
 * to tell that row apart from a real extraction. Pass an override for a real one.
 */
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

describe("ChatService — auto-trigger extraction on the readiness flip", () => {
  it("triggers extraction exactly once on the flip (no manual /profile/extract)", async () => {
    const { svc, profiles, events } = make({ extractionReady: true });
    const res = await svc.postMessage(WORKER, DTO as never, CTX);
    expect(res.extraction_ready).toBe(true);
    expect(emittedNames(events)).toContain("profile.extraction_ready");
    expect(profiles.extract).toHaveBeenCalledOnce();
    expect(profiles.extract).toHaveBeenCalledWith({ worker_id: WORKER, session_id: SESSION }, CTX);
  });

  it("does not trigger while the interview is not yet ready", async () => {
    const { svc, profiles, events } = make({ extractionReady: false });
    await svc.postMessage(WORKER, DTO as never, CTX);
    expect(emittedNames(events)).not.toContain("profile.extraction_ready");
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("does not re-trigger on later ready turns (extraction_ready_emitted marker)", async () => {
    const { svc, profiles, events } = make({
      extractionReady: true,
      conversationState: { ...READY_STATE, extraction_ready_emitted: true },
    });
    await svc.postMessage(WORKER, DTO as never, CTX);
    expect(emittedNames(events)).not.toContain("profile.extraction_ready");
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("skips extraction if the worker already has a REAL profile (no duplicate)", async () => {
    // The no-duplicate guarantee, unchanged — but the fixture now has to be a profile
    // that actually extracted something. It previously read `{ id: "profile-1" }`,
    // i.e. it asserted that the mere EXISTENCE of a row suppresses extraction, which
    // is the T3 bug itself: an empty row fabricated during an ai-service outage
    // satisfied that guard and became the worker's permanent profile. Same intent
    // (never extract twice for a worker who is already profiled), honest fixture.
    const { svc, profiles, events } = make({
      extractionReady: true,
      latestProfile: profileRow({
        profileStatus: "extracted",
        canonicalRoleId: "vmc_operator",
        skills: ["skill_milling"],
      }),
    });
    await svc.postMessage(WORKER, DTO as never, CTX);
    expect(emittedNames(events)).toContain("profile.extraction_ready"); // signal still emitted
    expect(profiles.extract).not.toHaveBeenCalled(); // but no second extraction
  });

  it("T3: RE-TRIGGERS when the stored profile is an empty placeholder (the poison heals)", async () => {
    // The production bug, from the chat side: an interview that completed while the
    // ai-service was down left a contentless profile row, and this guard then treated
    // it as "already profiled" forever — no later turn and no re-completed interview
    // ever produced another extraction. The worker was permanently unprofiled AND
    // permanently unable to become profiled.
    const { svc, profiles, events } = make({ extractionReady: true, latestProfile: profileRow() });
    await svc.postMessage(WORKER, DTO as never, CTX);

    expect(emittedNames(events)).toContain("profile.extraction_ready");
    expect(profiles.extract).toHaveBeenCalledOnce();
    expect(profiles.extract).toHaveBeenCalledWith({ worker_id: WORKER, session_id: SESSION }, CTX);
  });

  it("T3: a content-poor but REAL extraction (TD94) still counts — no re-trigger, no spend loop", async () => {
    // The other half of the predicate, and the reason it is `hasExtractedContent` and
    // not a legacy-column count: "main CNC operator hoon" canonicalizes to nothing, so
    // every legacy column is at its default and only the rich draft carries the skill
    // label. Re-triggering on THAT would be a fresh ai_job on every interview forever
    // — the unbounded-spend loop issue #420 was filed about.
    const { svc, profiles } = make({
      extractionReady: true,
      latestProfile: profileRow({ richProfileDraft: { skills: ["machine operation"] } }),
    });
    await svc.postMessage(WORKER, DTO as never, CTX);
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("T3: the placeholder re-trigger never changes the chat reply (outage never blocks the worker)", async () => {
    // The self-heal is fire-and-forget: it runs on the same non-fatal path as before,
    // so the turn the worker sees is byte-identical whether it fired or not.
    const { svc } = make({ extractionReady: true, latestProfile: profileRow(), extractThrows: true });
    const res = await svc.postMessage(WORKER, DTO as never, CTX);
    expect(res.reply).toBe("Thanks!");
    expect(res.extraction_ready).toBe(true);
  });

  it("never breaks the chat reply if the extraction trigger throws", async () => {
    const { svc, profiles } = make({ extractionReady: true, extractThrows: true });
    const res = await svc.postMessage(WORKER, DTO as never, CTX);
    expect(profiles.extract).toHaveBeenCalledOnce();
    expect(res.reply).toBe("Thanks!"); // chat still returns normally
    expect(res.extraction_ready).toBe(true);
  });
});

describe("ChatService.postMessage — query-count / N+1 guard (per turn)", () => {
  it("issues a BOUNDED, constant set of repo reads/writes per message (no N+1)", async () => {
    const { svc, chat } = make({ extractionReady: false });
    await svc.postMessage(WORKER, DTO as never, CTX);
    // PERF-2: ZERO history reads per turn — the ai-service turn is stateless
    // (COST-3 discards history), so the transcript is never loaded here at all.
    expect(chat.listMessages).not.toHaveBeenCalled();
    // One session lookup, two message inserts (inbound + outbound), one state persist.
    expect(chat.findSession).toHaveBeenCalledTimes(1);
    expect(chat.insertMessage).toHaveBeenCalledTimes(2);
    expect(chat.saveConversationState).toHaveBeenCalledTimes(1);
  });
});

// PERF-2 — stop shipping the chat history the ai-service discards. The turn engine
// keys off message_text + conversation_state; build_chat_messages(history=[]) already
// ignored the field (COST-3), and a null-state turn mints a fresh ConversationState
// (never reconstructed from history). So the API now sends history: [] and no longer
// reads the transcript on the chat turn. The FIELD stays — shipped contract shape.
/**
 * The full reply shape for a plain mid-interview turn against the default stub.
 *
 * Two separate regressions deep-equal against this, from opposite directions:
 * PERF-2 (dropping history must not change the reply) and CHAT-UE-1 (the new
 * field must be purely additive). They are deliberately NOT merged — each anchors
 * a different intent — but they share ONE literal so the pair can never drift
 * apart and quietly assert two different "unchanged" shapes.
 */
const EXPECTED_TURN_REPLY = {
  session_id: SESSION,
  reply: "Thanks!",
  blocked: false,
  is_mock: true,
  suggested_followups: [],
  asked_question_id: "q_machines",
  extraction_ready: false,
  unanswered_essentials: [],
} as const;

describe("ChatService.postMessage — PERF-2 dead-history drop", () => {
  it("produces the IDENTICAL full reply object as before the change (deep-equal)", async () => {
    // The reply derives ONLY from the stubbed ai client's result (+ name rendering);
    // history never influenced it. This is byte-for-byte what the pre-change code
    // returned with the same stub. (`unanswered_essentials` joined the shape via
    // CHAT-UE-1 (#478) — orthogonal to this PR; [] here because the stub's state
    // carries none.)
    const { svc } = make({ extractionReady: false });
    const res = await svc.postMessage(WORKER, DTO as never, CTX);
    expect(res).toEqual(EXPECTED_TURN_REPLY);
  });

  it("never reads the transcript on the chat-turn path (listMessages spy)", async () => {
    const { svc, chat } = make({ extractionReady: false });
    // Even with a long prior transcript available, the turn must not load it.
    chat.listMessages.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, direction: "inbound", bodyText: "x" })),
    );
    await svc.postMessage(WORKER, DTO as never, CTX);
    expect(chat.listMessages).not.toHaveBeenCalled();
  });

  it("fresh session (null state, no prior messages) completes a turn with history: []", async () => {
    const { svc, ai } = make(); // conversationState defaults to null → fresh interview
    const res = await svc.postMessage(WORKER, DTO as never, CTX);
    expect(res.reply).toBe("Thanks!");
    const sent = ai.profilingRespond.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.conversation_state).toBeNull();
    expect(sent.history).toEqual([]);
  });

  it("outbound ai-service payload STILL CARRIES the history field — empty, not absent", async () => {
    // Invariant #8: the shipped ProfilingTurnInput contract keeps its shape; only
    // the contents were dead weight. The key must be present with value [].
    const { svc, ai } = make({ conversationState: READY_STATE });
    await svc.postMessage(WORKER, DTO as never, CTX);
    const sent = ai.profilingRespond.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(sent, "history")).toBe(true);
    expect(sent.history).toEqual([]);
  });
});

// AI-PERSONA-2 — the real-name seam. The ai-service emits a {{worker_name}} token;
// the API interpolates the real first name POST-emit, ONLY in the client reply.
const PLACEHOLDER_REPLY = "{{worker_name}} ji, Aap kaunsa kaam karte hain?";
// Second insertMessage call is the OUTBOUND (assistant) message — the audit spine.
const outboundBody = (chat: { insertMessage: ReturnType<typeof vi.fn> }): string =>
  (chat.insertMessage.mock.calls[1]?.[0] as { bodyText: string }).bodyText;

describe("ChatService — AI-PERSONA-2 worker-name seam (SG-1 PII boundary)", () => {
  it("interpolates the real FIRST name into the client reply only", async () => {
    const { res, chat, events, ai } = await run({
      replyText: PLACEHOLDER_REPLY,
      workerName: "Nitin Kumar",
    });
    // Client sees the personalized reply (first name only, not the full name).
    expect(res.reply).toBe("Nitin ji, Aap kaunsa kaam karte hain?");

    // SG-1: the stored outbound message keeps the PLACEHOLDER, never the name.
    expect(outboundBody(chat)).toContain("{{worker_name}}");
    expect(outboundBody(chat)).not.toContain("Nitin");

    // The name is in NO event payload…
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("Nitin");
    // …and was NEVER sent to the ai-service (LLM input) — only worker_ref + message.
    expect(JSON.stringify(ai.profilingRespond.mock.calls)).not.toContain("Nitin");
  });

  it("inserts a name with `$` special-replacement chars literally (no pattern expansion)", async () => {
    // Worker-controlled name may contain $&, $', $$ — a STRING replacement would
    // expand these; the function replacement must insert them verbatim.
    const { res } = await run({ replyText: PLACEHOLDER_REPLY, workerName: "Om$'" });
    expect(res.reply).toBe("Om$' ji, Aap kaunsa kaam karte hain?");
  });

  it("null name → clean no-vocative reply, no residual {{ }} token", async () => {
    const { res, chat } = await run({ replyText: PLACEHOLDER_REPLY, workerName: null });
    expect(res.reply).toBe("Aap kaunsa kaam karte hain?");
    expect(res.reply).not.toContain("{{");
    expect(res.reply).not.toContain("ji,");
    // The stored placeholder is untouched regardless of the name being absent.
    expect(outboundBody(chat)).toContain("{{worker_name}}");
  });

  it("undecryptable name (rotated/tampered key) degrades to no-vocative, never 500s", async () => {
    const { res } = await run({
      replyText: PLACEHOLDER_REPLY,
      workerName: "Nitin Kumar",
      decryptThrows: true,
    });
    expect(res.reply).toBe("Aap kaunsa kaam karte hain?");
    expect(res.reply).not.toContain("{{");
  });

  it("never passes the worker name to the logger", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      await run({ replyText: PLACEHOLDER_REPLY, workerName: "Nitin Kumar" });
      const logged = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(logged).not.toContain("Nitin");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("no DB name read for a reply without the placeholder (mid-interview ack turn)", async () => {
    const { workers } = await run({ replyText: "Theek hai. Kaunsi machine?" });
    // Fast path: renderWorkerName short-circuits, so no worker/name fetch happens.
    expect(workers.findById).not.toHaveBeenCalled();
  });
});

// CHAT-UE-1 — the completeness signal crosses the last hop to the client.
// The response carries topic IDS only (never PII), degrades to [] on the
// mock/AI-down null state, and a malformed engine value can never 500 a turn.
describe("ChatService — CHAT-UE-1 unanswered_essentials on the reply", () => {
  it("surfaces the engine's unanswered essentials, in engine (ESSENTIAL_TOPICS) order", async () => {
    const { res } = await run({
      updatedState: { ...READY_STATE, unanswered_essentials: ["machines", "experience", "salary"] },
    });
    expect(res.unanswered_essentials).toEqual(["machines", "experience", "salary"]);
  });

  it("updated_state null (real service's blocked/fail-closed leg) → [] and no throw", async () => {
    const { res, chat } = await run({ updatedState: null });
    expect(res.unanswered_essentials).toEqual([]);
    // The null-state leg was genuinely taken (plain touch, no state persist).
    expect(chat.touchSession).toHaveBeenCalledTimes(1);
    expect(chat.saveConversationState).not.toHaveBeenCalled();
  });

  it("all essentials answered → []", async () => {
    const { res } = await run({
      extractionReady: true,
      updatedState: { ...READY_STATE, unanswered_essentials: [] },
    });
    expect(res.unanswered_essentials).toEqual([]);
    expect(res.extraction_ready).toBe(true);
  });

  it("malformed value (non-string members) → drops them, keeps the string ids, never throws — and the drop is OBSERVABLE (count only, no values)", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { res } = await run({
        updatedState: { ...READY_STATE, unanswered_essentials: ["machines", 42, null, "salary"] },
      });
      expect(res.unanswered_essentials).toEqual(["machines", "salary"]);
      // The silent-coercion review finding: a drop must WARN — field name + count,
      // never the members themselves (§2 no-PII-in-logs discipline, even for ids).
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("coerced unanswered_essentials");
      expect(logged).toContain("dropped=2");
      expect(logged).not.toContain("machines");
      expect(logged).not.toContain("salary");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("malformed value (not an array at all) → [], never throws — and WARNS non-array, no values", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { res } = await run({
        updatedState: { ...READY_STATE, unanswered_essentials: "machines" },
      });
      expect(res.unanswered_essentials).toEqual([]);
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("coerced unanswered_essentials");
      expect(logged).toContain("non-array");
      expect(logged).not.toContain("machines");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("poisoned outbound VALUE (suggested_followups: 42 via the DI seam) → NO throw, constructed object returned, warn logs field PATHS only — never values", async () => {
    // Kills the review's surviving mutation (iii): swapping safeParse for a throwing
    // parse() must fail THIS test. The DI mock bypasses ProfilingTurnOutputSchema, so
    // the invalid value reaches the outbound gate — the one leg the harness could
    // not previously reach.
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const h = make();
      h.ai.profilingRespond.mockResolvedValueOnce({
        reply_text: "SECRET_REPLY_TEXT",
        blocked: false,
        is_mock: true,
        suggested_followups: 42, // invalid: schema wants string[]
        asked_question_id: "q_machines",
        extraction_ready: false,
        updated_state: null,
      });
      const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
      // No throw — the explicitly constructed fallback object is returned intact.
      expect(res.session_id).toBe(SESSION);
      expect(res.reply).toBe("SECRET_REPLY_TEXT");
      expect(res.unanswered_essentials).toEqual([]);
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("outbound validation failed");
      expect(logged).toContain("suggested_followups"); // the field PATH
      expect(logged).not.toContain("SECRET_REPLY_TEXT"); // never the VALUES (§2)
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("carries topic ids only — never the worker's name (PII)", async () => {
    const { res } = await run({
      replyText: PLACEHOLDER_REPLY,
      workerName: "Nitin Kumar",
      updatedState: { ...READY_STATE, unanswered_essentials: ["salary"] },
    });
    expect(res.unanswered_essentials).toEqual(["salary"]);
    expect(JSON.stringify(res.unanswered_essentials)).not.toContain("Nitin");
  });

  it("keeps every pre-existing reply field unchanged (additive, backward compatible)", async () => {
    // Same literal the PERF-2 deep-equal uses (EXPECTED_TURN_REPLY) — only the NEW
    // field is added, and a state without the key degrades to [].
    const { res } = await run({});
    expect(res).toEqual(EXPECTED_TURN_REPLY);
  });
});

/** Run one postMessage turn and return the harness + response. */
async function run(opts: Parameters<typeof make>[0]) {
  const h = make(opts);
  const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
  return { ...h, res };
}

// --- startSession + the one-shot opener -------------------------------------
// These are the FIRST tests for startSession (it had none before the opener), so
// they also pin the pre-existing response shape, not just the new field.

describe("ChatService.startSession — one-shot opener", () => {
  const ctx = { correlationId: "c-1", requestId: "r-1" } as never;

  it("flag OFF: the body is byte-identical and NO call is made to the ai service", async () => {
    const { svc, ai } = make();
    const res = await svc.startSession(WORKER, ctx);

    // Exactly the three historical keys — `opening_text` ABSENT, not null, so a
    // client that predates the flag sees no change at all.
    expect(Object.keys(res).sort()).toEqual(["session_id", "started_at", "status"]);
    expect("opening_text" in res).toBe(false);
    // No outbound hop: the ai client's 8s timeout must never land on chat mount.
    expect(ai.profilingOpening).not.toHaveBeenCalled();
  });

  it("flag ON: the opener rides the existing session response", async () => {
    const { svc, ai } = make({ oneShotOpener: true });
    const res = await svc.startSession(WORKER, ctx);

    expect(ai.profilingOpening).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ session_id: SESSION, opening_text: "OPENER TEXT" });
  });

  it("flag ON but the ai service is down: degrades to the 3-key body, never 500s", async () => {
    // `null` is the ai client's documented "cannot supply it" signal. The client
    // then renders its own constant — we do NOT invent a second copy here.
    const { svc } = make({ oneShotOpener: true, openingText: null });
    const res = await svc.startSession(WORKER, ctx);

    expect(Object.keys(res).sort()).toEqual(["session_id", "started_at", "status"]);
  });

  it("emits chat.session_started with its payload UNCHANGED by the opener", async () => {
    // Invariant #8: the opener must not leak into a shipped event payload.
    const { svc, events } = make({ oneShotOpener: true });
    await svc.startSession(WORKER, ctx);

    const started = events.emit.mock.calls.map((c) => c[0]).find(
      (e) => e.event_name === "chat.session_started",
    );
    expect(started).toBeDefined();
    expect(Object.keys(started!.payload).sort()).toEqual(["session_id", "worker_id"]);
  });
});
