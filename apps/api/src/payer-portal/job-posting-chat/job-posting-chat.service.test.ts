import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../../common/request-context";
import { fakeAiTraceRecorder } from "../../ai/ai-trace-recorder.fake";
import { EventsService } from "../../events/events.service";
import { JobPostingsService } from "../../job-postings/job-postings.service";
import { JobPostingChatService } from "./job-posting-chat.service";
import type { PayerTenantScope } from "../../payers/payer-tenant-scope";
import type { PayerTenantScopeService } from "../../payers/payer-tenant-scope.service";
import { defaultModeResolver, resolverOver } from "../../payers/payer-tenant-scope.test-support";
import type { ServerConfig } from "@badabhai/config";

const PAYER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const PAYER_B = "bbbbbbbb-0000-4000-8000-000000000002";
const SESSION = "cccccccc-0000-4000-8000-000000000003";
const POSTING = "dddddddd-0000-4000-8000-000000000004";
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};

/** The payer's own organisation name — must never appear in an event or in LLM input. */
const ORG_NAME = "Sharma Precision Works";
/** Payer free text — must never appear in an event payload. */
const PAYER_TEXT = "we need 5 CNC operators in Pune, 20000 to 25000 per month";
const ASSISTANT_TEXT = "Got it. Which shift will they work?";

/** A complete, publishable draft as it would sit in the `draft` jsonb column. */
const FULL_DRAFT = {
  role_title: "CNC Operator",
  skills: ["fanuc control"],
  // Poster free text and the card city differ on purpose, so a test can tell which one a
  // mapping read (#1726 — `city` is never derived from `location_label`).
  location_label: "Chakan MIDC",
  vacancy_band: "2-5",
  pay_min: 20000,
  pay_max: 25000,
  shift: "day",
  benefits: ["PF and ESI"],
  requirements: ["ITI preferred"],
  description: "Machining shop floor role on our production line",
  city: "Pune",
  pay_type: "in_hand",
  min_experience_years: 1,
  max_experience_years: 3,
  needed_by: "soon",
  confidence: 1,
  missing_fields: [],
  clarification_questions: [],
};

const ENGINE_STATE = {
  trade_hint: null,
  turn_count: 2,
  answered_topics: ["role_title", "location_label"],
  asked_question_ids: ["q_role_title"],
  collected: { role_title: "CNC Operator" },
  clarify_count: 0,
  ask_counts: {},
  unanswered_essentials: ["vacancy"],
};

type EmitParams = {
  event_name: string;
  actor: { actor_type: string; actor_id?: string };
  subject: { subject_type: string; subject_id: string };
  payload: Record<string, unknown>;
  idempotencyKey?: string;
};

function make(
  opts: {
    /** The row `findOwnedSession` resolves — `undefined` models unknown OR foreign. */
    session?: Record<string, unknown> | undefined;
    openingText?: string | null;
    /** What the AI seam returns for a turn; `null` models an unreachable service. */
    turn?: Record<string, unknown> | null;
    /** `undefined` models a payer row that vanished. */
    payerRow?: Record<string, unknown> | undefined;
    decryptThrows?: boolean;
    orgName?: string;
    claimWins?: boolean;
    /** `false` models a turn that lost the race to a publish: `saveTurn` wrote no row (#1922). */
    turnStored?: boolean;
    createThrows?: Error;
    /** ADR-0053 — the REAL resolver; the default mode (`off`) unless a case builds another. */
    tenancy?: PayerTenantScopeService;
  } = {},
) {
  const session =
    opts.session === undefined && !("session" in opts)
      ? {
          id: SESSION,
          payerId: PAYER_A,
          status: "active",
          conversationState: null,
          draft: null,
          publishedJobPostingId: null,
          startedAt: new Date("2026-07-28T09:00:00.000Z"),
          lastMessageAt: null,
          endedAt: null,
        }
      : opts.session;

  let messageSeq = 0;
  const chat = {
    createSession: vi.fn(async () => ({
      id: SESSION,
      payerId: PAYER_A,
      status: "active",
      conversationState: null,
      draft: null,
      publishedJobPostingId: null,
      startedAt: new Date("2026-07-28T09:00:00.000Z"),
      lastMessageAt: null,
      endedAt: null,
    })),
    // OWNER-AWARE ON PURPOSE: the real query filters on `payer_id` in the WHERE
    // clause, so a foreign id and an unknown id both come back `undefined`. Mocking
    // that faithfully is what makes the IDOR tests below test something real rather
    // than merely re-asserting a stub.
    findOwnedSession: vi.fn(async (id: string, payerId: string) =>
      session &&
      id === (session as { id: string }).id &&
      payerId === (session as { payerId: string }).payerId
        ? session
        : undefined,
    ),
    listSessions: vi.fn(async (payerId: string) =>
      session && payerId === (session as { payerId: string }).payerId ? [session] : [],
    ),
    // Params are declared (even where unused) so `mock.calls[n][i]` stays TYPED — an
    // untyped `vi.fn(async () => …)` gives an empty call tuple and the assertions
    // below would silently degrade to `any`.
    insertMessage: vi.fn(async (_input: Record<string, unknown>) => ({
      id: `eeeeeeee-0000-4000-8000-00000000000${++messageSeq}`,
      createdAt: new Date("2026-07-28T09:01:00.000Z"),
    })),
    listMessages: vi.fn(async (_sessionId: string) => []),
    // Resolves whether a row was written, like the real guarded UPDATE: `true` unless the
    // test models the session leaving the live statuses mid-turn.
    saveTurn: vi.fn(
      async (_sessionId: string, _payerId: string, _patch: Record<string, unknown>) =>
        opts.turnStored !== false,
    ),
    claimForPublish: vi.fn(async (_sessionId: string, _payerId: string, _at: Date) =>
      opts.claimWins === false ? undefined : session,
    ),
    bindPublishedPosting: vi.fn(
      async (_sessionId: string, _payerId: string, _jobPostingId: string) => undefined,
    ),
    releasePublishClaim: vi.fn(
      async (_sessionId: string, _payerId: string, _to: string) => undefined,
    ),
  };

  const emitted: EmitParams[] = [];
  const events = {
    emit: vi.fn(async (p: EmitParams) => {
      emitted.push(p);
      return undefined;
    }),
  };

  // Both stubs TAKE the BL-19 trace ctx as their trailing optional parameter, so a test can
  // assert the request's ids were forwarded rather than left for `AiService.post` to mint.
  const ai = {
    jobPostingChatOpening: vi.fn(async (_tradeHint?: string | null, _ctx?: unknown) =>
      opts.openingText === undefined
        ? "Tell me about the role you are hiring for."
        : opts.openingText,
    ),
    jobPostingChatRespond: vi.fn(async (_input: Record<string, unknown>, _ctx?: unknown) =>
      opts.turn === null
        ? null
        : {
            reply_text: ASSISTANT_TEXT,
            blocked: false,
            blocked_reason: null,
            suggested_answers: ["Day", "Night"],
            is_mock: true,
            asked_question_id: "q_shift",
            draft_ready: false,
            draft: FULL_DRAFT,
            updated_state: ENGINE_STATE,
            ai_metadata: null,
            pseudonymization_metadata: null,
            ...(opts.turn ?? {}),
          },
    ),
  };

  const payers = {
    findById: vi.fn(async (_payerId: string) =>
      "payerRow" in opts ? opts.payerRow : { id: PAYER_A, orgNameEnc: "ENC_ORG_TOKEN" },
    ),
  };
  const pii = {
    decrypt: vi.fn((_token: string) => {
      if (opts.decryptThrows) throw new Error("rotated key");
      return opts.orgName ?? ORG_NAME;
    }),
  };
  const jobPostings = {
    createInScope: vi.fn(
      async (_scope: PayerTenantScope, _dto: Record<string, unknown>, _ctx: RequestContext) => {
        if (opts.createThrows) throw opts.createThrows;
        return { id: POSTING, status: "draft" };
      },
    ),
  };

  // #745: the turn's cost emitter. This route makes no LLM call today, so the stub exists
  // to satisfy the constructor AND to let a test prove the emitter stays silent on null
  // metadata rather than writing a ₹0 record for a call that never happened.
  // Typed to the recorder's real signature so the argument assertions stay type-checked.
  const aiCost = {
    record: vi.fn(
      async (
        _meta: unknown,
        _taskType: string,
        _aiJobId: string | null,
        _correlationId: string,
        _requestId: string,
      ) => {},
    ),
  };

  // 0083: the SHARED trace fake. It reproduces the real recorder's short-circuits, so
  // `traces.dropped` is a claim about production (a payer turn has no worker, so nothing is
  // ever stored) rather than about this double.
  const traces = fakeAiTraceRecorder();

  const svc = new JobPostingChatService(
    chat as never,
    events as never,
    ai as never,
    aiCost as never,
    traces.recorder,
    payers as never,
    pii as never,
    jobPostings as never,
    opts.tenancy ?? defaultModeResolver(),
  );
  return { svc, chat, events, emitted, ai, aiCost, traces, payers, pii, jobPostings };
}

/** Re-build each recorded emit through `createEvent` — proves it is registry-valid. */
function assertRegistryValid(params: EmitParams): void {
  const built = createEvent({
    event_name: params.event_name,
    payload: params.payload,
    actor: params.actor,
    subject: params.subject,
    source: "api",
    metadata: { environment: "test", service: "api" },
  } as never);
  expect((built as { event_name: string }).event_name).toBe(params.event_name);
}

// ---------------------------------------------------------------------------
describe("JobPostingChatService — session lifecycle", () => {
  it("startSession creates the session, emits session_started, and stores the opener as the first assistant message", async () => {
    const d = make();
    const res = await d.svc.startSession(PAYER_A, CTX);

    expect(d.chat.createSession).toHaveBeenCalledWith(PAYER_A);
    expect(res.session_id).toBe(SESSION);
    expect(res.status).toBe("active");
    // One TURN shape for both /session and /message — the clients render an assistant
    // bubble the same way whether it is the greeting or the fifth question.
    expect(res.reply_text).toBe("Tell me about the role you are hiring for.");
    expect(res.message_id).toBeTruthy();
    expect(res.draft).toBeNull();
    expect(res.draft_ready).toBe(false);

    // The opener IS persisted (cross-device hydration needs it) and IS on the spine.
    expect(d.chat.insertMessage).toHaveBeenCalledTimes(1);
    expect(d.chat.insertMessage.mock.calls[0]![0]).toMatchObject({
      sessionId: SESSION,
      payerId: PAYER_A,
      direction: "outbound",
    });

    expect(d.emitted.map((e) => e.event_name)).toEqual([
      "job_posting_chat.session_started",
      "job_posting_chat.message_sent",
    ]);
    expect(d.emitted[0]!.payload).toEqual({ session_id: SESSION, payer_id: PAYER_A });
    expect(d.emitted[0]!.subject.subject_type).toBe("payer_job_posting_chat_session");
    // The engine's own line is attributed to the ai_service, never to the payer.
    expect(d.emitted[1]!.actor.actor_type).toBe("ai_service");
    d.emitted.forEach(assertRegistryValid);

    // BL-19: the opener is fetched under the REQUEST's ids. The trade hint stays null — this
    // slice never sends one — so the ctx is the trailing argument, not a replacement for it.
    expect(d.ai.jobPostingChatOpening).toHaveBeenCalledWith(null, {
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
  });

  it("startSession returns an EMPTY reply (never a locally invented greeting) when the AI service cannot supply an opener", async () => {
    const d = make({ openingText: null });
    const res = await d.svc.startSession(PAYER_A, CTX);

    // The key is present (the clients require it) but empty, and nothing was stored —
    // a message row with no text would hydrate as a blank bubble on the next device.
    expect(res.reply_text).toBe("");
    expect(res.message_id).toBeNull();
    expect(d.chat.insertMessage).not.toHaveBeenCalled();
    expect(d.emitted.map((e) => e.event_name)).toEqual(["job_posting_chat.session_started"]);
  });

  /**
   * #745 — the emitter is wired AHEAD of the spend, and that is deliberate.
   *
   * `/job-posting-chat/respond` makes ZERO LLM calls today (the engine's question is
   * returned verbatim), so the ai-service returns `ai_metadata: null` and this emits
   * nothing. The issue filed this surface as money-with-no-record; re-measurement showed
   * it spends nothing, so the honest guarantee to lock is the pair below: the call is
   * made on every turn, and it stays silent while there is nothing to report.
   *
   * The seam that will start spending (`job_posting_chat_turn` in the ai-service's
   * `model_config.py`) is edited in Python by someone with no reason to open this file —
   * which is precisely how `stt_transcription` shipped unledgered in the first place.
   */
  it("asks the recorder on every turn, but records NOTHING while the route makes no LLM call", async () => {
    const d = make({
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "active",
        conversationState: ENGINE_STATE,
        draft: null,
        publishedJobPostingId: null,
        startedAt: new Date("2026-07-28T09:00:00.000Z"),
        lastMessageAt: null,
        endedAt: null,
      },
    });
    await d.svc.postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX);

    expect(d.aiCost.record).toHaveBeenCalledOnce();
    const [meta, taskType, aiJobId] = d.aiCost.record.mock.calls[0]!;
    // Null metadata ⇒ `record` no-ops. A ₹0 record here would put a provider call that
    // never happened onto the cost spine, which is the failure the recorder documents.
    expect(meta).toBeNull();
    // ITS OWN TASK TYPE, not the worker chat's. `profiling_chat_turn` is `/profiling/respond`
    // (the worker profiling loop, which this app never calls); this is the payer job-posting
    // composer. The recorder labels the event from this argument, not from the metadata, so
    // borrowing the worker's name would file payer spend under the worker chat the day the
    // rephrase seam is armed — and the fix would then be an invisible one-word edit here.
    expect(taskType).toBe("job_posting_chat_turn");
    expect(aiJobId).toBeNull(); // a payer turn is a synchronous reply, not an ai_jobs row
    // And no cost event reached the spine.
    expect(d.emitted.map((e) => e.event_name)).not.toContain("ai.cost_recorded");
  });

  it("does not reach the recorder at all when the engine turn failed", async () => {
    // The 503 path: nothing was spent because nothing was answered, and the payer's
    // message is already stored so a retry resumes exactly here.
    const d = make({
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "active",
        conversationState: ENGINE_STATE,
        draft: null,
        publishedJobPostingId: null,
        startedAt: new Date("2026-07-28T09:00:00.000Z"),
        lastMessageAt: null,
        endedAt: null,
      },
      turn: null,
    });
    await expect(
      d.svc.postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX),
    ).rejects.toThrow();
    expect(d.aiCost.record).not.toHaveBeenCalled();
  });

  it("postMessage stores both turns, calls the engine with the loaded state, and persists state + draft", async () => {
    const d = make({
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "active",
        conversationState: ENGINE_STATE,
        draft: null,
        publishedJobPostingId: null,
        startedAt: new Date("2026-07-28T09:00:00.000Z"),
        lastMessageAt: null,
        endedAt: null,
      },
    });
    const res = await d.svc.postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX);

    // The payer's turn is stored BEFORE the engine call, so an outage cannot lose it.
    expect(d.chat.insertMessage.mock.calls[0]![0]).toMatchObject({
      direction: "inbound",
      bodyText: PAYER_TEXT,
    });
    expect(d.chat.insertMessage.mock.calls[1]![0]).toMatchObject({
      direction: "outbound",
      bodyText: ASSISTANT_TEXT,
    });

    // The engine is handed the loaded state (the interview never restarts at Q1) and
    // the payer's OPAQUE id — never an org name, email, or any other identity.
    const sent = d.ai.jobPostingChatRespond.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      session_id: SESSION,
      payer_ref: PAYER_A,
      message_text: PAYER_TEXT,
    });
    expect((sent.conversation_state as { turn_count: number }).turn_count).toBe(2);
    expect(JSON.stringify(sent)).not.toContain(ORG_NAME);
    // BL-19: the request's own ids ride the call, so the ai-service's trace joins this turn
    // instead of the fresh uuid `AiService.post` mints when no ctx is supplied.
    expect(d.ai.jobPostingChatRespond.mock.calls[0]![1]).toEqual({
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });

    const saved = d.chat.saveTurn.mock.calls[0]![2] as Record<string, unknown>;
    expect(saved.conversationState).toMatchObject({ turn_count: 2 });
    expect(saved.draft).toMatchObject({ role_title: "CNC Operator" });

    expect(res.reply_text).toBe(ASSISTANT_TEXT);
    expect(res.suggested_replies).toEqual(["Day", "Night"]);
    expect(res.draft?.vacancy_band).toBe("2-5");
    // `message_id` is the OUTBOUND (assistant) row — the second insert of the turn —
    // not the payer's own message, so a client can key/dedupe the bubble it renders.
    const outbound = (await d.chat.insertMessage.mock.results[1]!.value) as { id: string };
    expect(res.message_id).toBe(outbound.id);

    // Inbound is attributed to the payer, outbound to the ai_service — one event name,
    // two actors (the ADR freezes three events for this domain, not four).
    const messageEvents = d.emitted.filter((e) => e.event_name === "job_posting_chat.message_sent");
    expect(messageEvents.map((e) => e.actor.actor_type)).toEqual(["payer", "ai_service"]);
    d.emitted.forEach(assertRegistryValid);
  });

  it("postMessage emits draft_ready ONCE, on the flip, and never again", async () => {
    const ready = {
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "active",
        conversationState: null,
        draft: null,
        publishedJobPostingId: null,
        startedAt: new Date(),
        lastMessageAt: null,
        endedAt: null,
      },
      turn: { draft_ready: true },
    };
    const first = make(ready);
    await first.svc.postMessage(PAYER_A, { session_id: SESSION, text: "day shift" }, CTX);
    expect(
      first.emitted.filter((e) => e.event_name === "job_posting_chat.draft_ready"),
    ).toHaveLength(1);
    // The status follows the flip, and the marker is carried on the RAW state.
    const saved = first.chat.saveTurn.mock.calls[0]![2] as Record<string, unknown>;
    expect(saved.status).toBe("draft_ready");
    expect((saved.conversationState as Record<string, unknown>).draft_ready_emitted).toBe(true);

    // A later turn on a session that already carries the marker must not re-emit.
    const again = make({
      ...ready,
      session: {
        ...ready.session,
        conversationState: { ...ENGINE_STATE, draft_ready_emitted: true },
      },
    });
    await again.svc.postMessage(PAYER_A, { session_id: SESSION, text: "yes" }, CTX);
    expect(
      again.emitted.filter((e) => e.event_name === "job_posting_chat.draft_ready"),
    ).toHaveLength(0);
  });

  it("a BLOCKED turn keeps the stored state and draft untouched", async () => {
    const d = make({
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "active",
        conversationState: ENGINE_STATE,
        draft: FULL_DRAFT,
        publishedJobPostingId: null,
        startedAt: new Date(),
        lastMessageAt: null,
        endedAt: null,
      },
      turn: { blocked: true, draft: null, updated_state: null, reply_text: "Please retype that." },
    });
    const res = await d.svc.postMessage(
      PAYER_A,
      { session_id: SESSION, text: "call 9876543210" },
      CTX,
    );

    // Only the activity clock moved.
    const saved = d.chat.saveTurn.mock.calls[0]![2] as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual(["lastMessageAt"]);
    // The draft card does not blank out over one rejected message.
    expect(res.blocked).toBe(true);
    expect(res.draft?.role_title).toBe("CNC Operator");
  });

  it("503s (never a fabricated turn) when the AI service is unreachable — the payer's message is already stored", async () => {
    const d = make({ turn: null });
    await expect(
      d.svc.postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(d.chat.insertMessage).toHaveBeenCalledTimes(1);
    expect(d.chat.insertMessage.mock.calls[0]![0]).toMatchObject({ direction: "inbound" });
    expect(d.chat.saveTurn).not.toHaveBeenCalled();
  });

  it("refuses turns on a terminal (published) session", async () => {
    const d = make({
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "published",
        conversationState: null,
        draft: FULL_DRAFT,
        publishedJobPostingId: POSTING,
        startedAt: new Date(),
        lastMessageAt: null,
        endedAt: null,
      },
    });
    await expect(
      d.svc.postMessage(PAYER_A, { session_id: SESSION, text: "one more thing" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ---------------------------------------------------------------------------
describe("JobPostingChatService — ownership is a no-oracle 404 (IDOR)", () => {
  /**
   * The property under test is INDISTINGUISHABILITY: an unknown id and another
   * payer's id must produce byte-identical failures, so the endpoint cannot be used
   * to discover which session ids exist.
   */
  it("every :id route reads through the OWNER-SCOPED predicate, keyed on the CALLER", async () => {
    const d = make();
    await d.svc.listMessages(PAYER_A, SESSION);
    // The caller's id, not the row's — there is no unscoped read to get wrong.
    expect(d.chat.findOwnedSession).toHaveBeenCalledWith(SESSION, PAYER_A);
  });

  it("a REAL session owned by someone else fails identically to a session that does not exist", async () => {
    // `foreign` holds a genuine, populated PAYER_A session; `missing` holds nothing.
    // PAYER_B asks for the same id in both. The two must be indistinguishable.
    const foreign = make();
    const missing = make({ session: undefined });

    const errors: Error[] = [];
    for (const d of [foreign, missing]) {
      await expect(d.svc.listMessages(PAYER_B, SESSION)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        d.svc.postMessage(PAYER_B, { session_id: SESSION, text: "hi" }, CTX),
      ).rejects.toBeInstanceOf(NotFoundException);
      await d.svc.publish(PAYER_B, SESSION, CTX).catch((e: unknown) => errors.push(e as Error));
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(NotFoundException);
    expect(errors[1]).toBeInstanceOf(NotFoundException);
    // Byte-identical message: nothing tells "not yours" apart from "no such session".
    expect(errors[0]!.message).toBe(errors[1]!.message);
  });

  it("a foreign session is refused BEFORE any write, event, engine call, or posting", async () => {
    const d = make(); // a real PAYER_A session...
    await d.svc
      .postMessage(PAYER_B, { session_id: SESSION, text: "hi" }, CTX)
      .catch(() => undefined);
    await d.svc.publish(PAYER_B, SESSION, CTX).catch(() => undefined); // ...asked for by PAYER_B

    expect(d.chat.insertMessage).not.toHaveBeenCalled();
    expect(d.chat.claimForPublish).not.toHaveBeenCalled();
    expect(d.jobPostings.createInScope).not.toHaveBeenCalled();
    expect(d.ai.jobPostingChatRespond).not.toHaveBeenCalled();
    expect(d.emitted).toHaveLength(0);
  });

  it("listSessions is scoped to the caller — another payer's list comes back empty", async () => {
    const d = make();
    expect((await d.svc.listSessions(PAYER_A)).sessions).toHaveLength(1);
    expect(d.chat.listSessions).toHaveBeenCalledWith(PAYER_A);
    expect((await d.svc.listSessions(PAYER_B)).sessions).toHaveLength(0);
  });

  it("the resume list gives the payer back their OWN draft preview, keyed to the account not a device", async () => {
    const d = make({
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "draft_ready",
        conversationState: ENGINE_STATE,
        draft: FULL_DRAFT,
        publishedJobPostingId: null,
        startedAt: new Date("2026-07-28T09:00:00.000Z"),
        lastMessageAt: new Date("2026-07-28T09:30:00.000Z"),
        endedAt: null,
      },
    });
    const { sessions } = await d.svc.listSessions(PAYER_A);
    expect(sessions[0]).toMatchObject({
      session_id: SESSION,
      status: "draft_ready",
      draft_ready: true,
      last_message_at: "2026-07-28T09:30:00.000Z",
      // FLAT, matching what both shipped clients read off a resume card.
      role_title: "CNC Operator",
      location_label: "Chakan MIDC",
      city: "Pune", // #1726 — the draft's card city, not the poster's free-text label
      vacancy_band: "2-5",
    });
  });

  it("a resume card whose draft has no city says null, never a guess from location_label (#1726)", async () => {
    const d = make({
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "active",
        conversationState: ENGINE_STATE,
        draft: { ...FULL_DRAFT, city: null },
        publishedJobPostingId: null,
        startedAt: new Date("2026-07-28T09:00:00.000Z"),
        lastMessageAt: null,
        endedAt: null,
      },
    });
    const { sessions } = await d.svc.listSessions(PAYER_A);
    expect(sessions[0]!.city).toBeNull();
    expect(sessions[0]!.location_label).toBe("Chakan MIDC");
  });
});

// ---------------------------------------------------------------------------
describe("JobPostingChatService — publish reuses the existing create path", () => {
  const publishable = {
    session: {
      id: SESSION,
      payerId: PAYER_A,
      status: "draft_ready",
      conversationState: ENGINE_STATE,
      draft: FULL_DRAFT,
      publishedJobPostingId: null,
      startedAt: new Date(),
      lastMessageAt: null,
      endedAt: null,
    },
  };

  let d: ReturnType<typeof make>;
  beforeEach(() => {
    d = make(publishable);
  });

  it("calls the posting create with the SESSION payer's resolved scope and the mapped draft", async () => {
    const res = await d.svc.publish(PAYER_A, SESSION, CTX);

    expect(d.jobPostings.createInScope).toHaveBeenCalledTimes(1);
    const [scope, dto, ctx] = d.jobPostings.createInScope.mock.calls[0]! as unknown as [
      PayerTenantScope,
      Record<string, unknown>,
      RequestContext,
    ];
    // The default mode (off): the session payer is both the actor and the tenant (ADR-0053).
    expect(scope).toMatchObject({ actorPayerId: PAYER_A, tenantKey: PAYER_A });
    expect(ctx).toBe(CTX);
    // #1650 — THE WHOLE DRAFT. This asserted six keys and the other five rode back as
    // `unmapped_fields`, which is why the most guided posting path in the product produced
    // the thinnest posting: the payer answered every question and the worker card showed
    // no pay, no shift, no benefits and no requirements.
    expect(dto).toEqual({
      org_label: ORG_NAME,
      role_title: "CNC Operator",
      location_label: "Chakan MIDC",
      description: "Machining shop floor role on our production line",
      vacancy_band: "2-5",
      skills: ["fanuc control"],
      pay_min: 20000,
      pay_max: 25000,
      shift: "day",
      benefits: ["PF and ESI"],
      requirements: ["ITI preferred"],
      // #1726 — the card fields the interview now collects.
      city: "Pune",
      pay_type: "in_hand",
      min_experience_years: 1,
      max_experience_years: 3,
      needed_by: "soon",
    });
    expect(res).toMatchObject({ job_posting_id: POSTING, status: "published" });
  });

  it("stamps org_label SERVER-SIDE from the encrypted payer row — it can never have come from the chat", async () => {
    await d.svc.publish(PAYER_A, SESSION, CTX);
    expect(d.payers.findById).toHaveBeenCalledWith(PAYER_A);
    expect(d.pii.decrypt).toHaveBeenCalledWith("ENC_ORG_TOKEN");
    // Least privilege: only the org-name token is decrypted, not the whole contact row.
    expect(d.pii.decrypt).toHaveBeenCalledTimes(1);
  });

  it("never sends role_kind — the interview does not ask for a role, so the posting stores NULL (0131)", async () => {
    // Owner ruling 2026-09-29: chat publish leaves `role_kind` NULL. The create DTO's field is
    // optional with no default, so an absent key is what makes `createInScope` store NULL.
    await d.svc.publish(PAYER_A, SESSION, CTX);
    const dto = d.jobPostings.createInScope.mock.calls[0]![1] as Record<string, unknown>;
    expect("role_kind" in dto).toBe(false);
  });

  it("does not report role_kind as an unset CARD field — it is display-only, not on the worker card", async () => {
    const res = await d.svc.publish(PAYER_A, SESSION, CTX);
    expect(res.unset_card_fields as readonly string[]).not.toContain("role_kind");
  });

  it("sends the BANDED vacancy and never a raw count (ADR-0012)", async () => {
    await d.svc.publish(PAYER_A, SESSION, CTX);
    const dto = d.jobPostings.createInScope.mock.calls[0]![1] as Record<string, unknown>;
    expect(dto.vacancy_band).toBe("2-5");
    expect("vacancies" in dto).toBe(false);
  });

  it("does NOT emit job_posting.created itself — the posting create (createInScope) is the single writer", async () => {
    await d.svc.publish(PAYER_A, SESSION, CTX);
    expect(d.emitted.map((e) => e.event_name)).not.toContain("job_posting.created");
    // Publish adds NO event of its own at all (ADR-0035 §Decision 6).
    expect(d.emitted).toHaveLength(0);
  });

  it("reports NOTHING unmapped now that the create path takes all five (#1650)", async () => {
    const res = await d.svc.publish(PAYER_A, SESSION, CTX);
    // This used to be the full five. The columns were always there (0054/0116); the
    // create SCHEMA was the gap, and #1645/#1646 closed it.
    expect(res.unmapped_fields).toEqual([]);
    // VACUITY GUARD: an empty list would also be the answer if the draft were empty, so
    // pin that this draft really does carry all five values the report is now silent about.
    expect(FULL_DRAFT.pay_min).not.toBeNull();
    expect(FULL_DRAFT.pay_max).not.toBeNull();
    expect(FULL_DRAFT.shift).not.toBeNull();
    expect(FULL_DRAFT.benefits.length).toBeGreaterThan(0);
    expect(FULL_DRAFT.requirements.length).toBeGreaterThan(0);
    // …and the values still never ride the RESPONSE — only the create DTO carries them.
    expect(JSON.stringify(res)).not.toContain("20000");
    expect(JSON.stringify(res)).not.toContain("PF and ESI");
  });

  it("omits a field the payer never answered instead of publishing a null (#1650)", async () => {
    // The create DTO's fields are `.optional()`, not `.nullable()` — a null would 400 the
    // publish. "The payer never told us the shift" must produce a posting WITHOUT a shift,
    // not a refused publish, and an interview that collected no chips must leave the
    // column NULL rather than storing an empty list.
    d = make({
      ...publishable,
      session: {
        ...publishable.session,
        draft: {
          ...FULL_DRAFT,
          pay_min: null,
          pay_max: null,
          shift: null,
          benefits: [],
          city: null,
          pay_type: null,
          min_experience_years: null,
          max_experience_years: null,
          needed_by: null,
        },
      },
    });
    await d.svc.publish(PAYER_A, SESSION, CTX);
    const dto = d.jobPostings.createInScope.mock.calls[0]![1] as Record<string, unknown>;
    for (const key of [
      "pay_min",
      "pay_max",
      "shift",
      "benefits",
      "city",
      "pay_type",
      "min_experience_years",
      "max_experience_years",
      "needed_by",
    ]) {
      expect(key in dto, key).toBe(false);
    }
    // The one that WAS answered still rides — otherwise this would pass on an empty DTO.
    expect(dto.requirements).toEqual(["ITI preferred"]);
  });

  it("omits a whitespace-only city rather than 400ing the publish on it (#1726)", async () => {
    d = make({
      ...publishable,
      session: { ...publishable.session, draft: { ...FULL_DRAFT, city: "   " } },
    });
    const res = await d.svc.publish(PAYER_A, SESSION, CTX);
    const dto = d.jobPostings.createInScope.mock.calls[0]![1] as Record<string, unknown>;
    expect("city" in dto).toBe(false);
    // Measured on what was SENT: the draft held a (blank) string, the posting holds NULL.
    expect(res.unset_card_fields).toEqual(["city"]);
  });

  describe("unset_card_fields — facts about the created posting, never a refusal (#1726)", () => {
    it("is empty when the draft fills every card field", async () => {
      const res = await d.svc.publish(PAYER_A, SESSION, CTX);
      expect(res.unset_card_fields).toEqual([]);
      // VACUITY GUARD: [] is also what a report that never looked would say, so pin that
      // the create DTO really carried all eleven.
      const dto = d.jobPostings.createInScope.mock.calls[0]![1] as Record<string, unknown>;
      for (const key of [
        "city",
        "pay_min",
        "pay_max",
        "pay_type",
        "min_experience_years",
        "max_experience_years",
        "shift",
        "needed_by",
        "description",
        "requirements",
        "benefits",
      ]) {
        expect(dto[key], key).toBeDefined();
      }
    });

    it("lists every card field a THIN draft left NULL — and still publishes", async () => {
      const thin = make({
        ...publishable,
        session: {
          ...publishable.session,
          draft: {
            role_title: "CNC Operator",
            skills: ["fanuc control"],
            location_label: "Chakan MIDC",
            vacancy_band: "2-5",
          },
        },
      });
      const res = await thin.svc.publish(PAYER_A, SESSION, CTX);
      expect(thin.jobPostings.createInScope).toHaveBeenCalledTimes(1);
      expect(res.job_posting_id).toBe(POSTING);
      expect(res.unset_card_fields).toEqual([
        "city",
        "pay_min",
        "pay_max",
        "pay_type",
        "min_experience_years",
        "max_experience_years",
        "shift",
        "needed_by",
        "description",
        "requirements",
        "benefits",
      ]);
      // Distinct from `unmapped_fields` ("collected, no column") — nothing was collected here.
      expect(res.unmapped_fields).toEqual([]);
    });

    it("reports a legitimate open-ended window as a fact, and only that", async () => {
      // "5+ years" has a min and no max; no benefits were stated. Both are NULL columns,
      // and whether either is a hole is the client's card rule, not this report's.
      const partial = make({
        ...publishable,
        session: {
          ...publishable.session,
          draft: {
            ...FULL_DRAFT,
            min_experience_years: 5,
            max_experience_years: null,
            benefits: [],
          },
        },
      });
      const res = await partial.svc.publish(PAYER_A, SESSION, CTX);
      expect(res.unset_card_fields).toEqual(["max_experience_years", "benefits"]);
      // KEYS only — no value from the draft rides the response.
      expect(JSON.stringify(res)).not.toContain("Pune");
    });
  });

  it("claims the session BEFORE creating, so a double-click cannot create two postings", async () => {
    const order: string[] = [];
    d.chat.claimForPublish.mockImplementation(async () => {
      order.push("claim");
      return publishable.session;
    });
    d.jobPostings.createInScope.mockImplementation(async () => {
      order.push("create");
      return { id: POSTING, status: "draft" };
    });
    await d.svc.publish(PAYER_A, SESSION, CTX);
    expect(order).toEqual(["claim", "create"]);
    expect(d.chat.bindPublishedPosting).toHaveBeenCalledWith(SESSION, PAYER_A, POSTING);
  });

  it("the loser of a concurrent publish gets a 409 and creates NOTHING", async () => {
    const race = make({ ...publishable, claimWins: false });
    await expect(race.svc.publish(PAYER_A, SESSION, CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(race.jobPostings.createInScope).not.toHaveBeenCalled();
  });

  it("an already-published session is a 409, not a second posting", async () => {
    const done = make({
      session: { ...publishable.session, status: "published", publishedJobPostingId: POSTING },
    });
    await expect(done.svc.publish(PAYER_A, SESSION, CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(done.chat.claimForPublish).not.toHaveBeenCalled();
    expect(done.jobPostings.createInScope).not.toHaveBeenCalled();
  });

  it("releases the claim when the create fails, so the payer can fix the draft and retry", async () => {
    const boom = make({ ...publishable, createThrows: new Error("posting cap reached") });
    await expect(boom.svc.publish(PAYER_A, SESSION, CTX)).rejects.toThrow("posting cap reached");
    expect(boom.chat.releasePublishClaim).toHaveBeenCalledWith(SESSION, PAYER_A, "draft_ready");
    expect(boom.chat.bindPublishedPosting).not.toHaveBeenCalled();
  });

  it("rejects an incomplete draft with field PATHS only — never the offending text", async () => {
    const partial = make({
      session: { ...publishable.session, draft: { ...FULL_DRAFT, vacancy_band: null } },
    });
    const err = await partial.svc.publish(PAYER_A, SESSION, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const body = (err as BadRequestException).getResponse() as {
      issues: { path: string; message: string }[];
    };
    expect(body.issues.map((i) => i.path)).toContain("vacancy_band");
    expect(JSON.stringify(body)).not.toContain("Machining shop floor");
    // Nothing was claimed or created on the rejected path.
    expect(partial.chat.claimForPublish).not.toHaveBeenCalled();
    expect(partial.jobPostings.createInScope).not.toHaveBeenCalled();
  });

  it("rejects publishing a session that has collected nothing yet", async () => {
    const empty = make({ session: { ...publishable.session, draft: null } });
    await expect(empty.svc.publish(PAYER_A, SESSION, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(empty.jobPostings.createInScope).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED rather than posting under a blank employer when the org name cannot be resolved", async () => {
    for (const opts of [
      { ...publishable, decryptThrows: true },
      { ...publishable, orgName: "   " },
      { ...publishable, payerRow: undefined },
    ]) {
      const broken = make(opts);
      await expect(broken.svc.publish(PAYER_A, SESSION, CTX)).rejects.toThrow();
      expect(broken.jobPostings.createInScope).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
/**
 * #1928 — ONE PUBLISH, AT MOST ONE POSTING, WHEN `job_posting.created` FAILS.
 *
 * The stubbed `createInScope` above cannot show this, because the defect lived between the
 * two services: `JobPostingsService` committed the posting row and only then emitted, outside
 * any transaction. A failed emit threw into `publish`, which released the claim (correctly
 * guarded on "nothing bound", but the row WAS committed), and the retry created a second
 * posting. So this wires the REAL `JobPostingsService` and the REAL `EventsService` under the
 * REAL `publish`, over fakes that keep the semantics that matter:
 *   - the posting + events store is TRANSACTIONAL. A write on the open `tx` persists only if the
 *     callback resolves, and a write with no executor autocommits, as the pre-#1928 insert did;
 *   - the session store mirrors the guarded UPDATEs (claim: live AND unbound; release: unbound).
 * The real-Postgres version is the #1928 block in `job-posting-chat.repository.db.test.ts`.
 */
describe("JobPostingChatService — a publish whose job_posting.created emit fails creates no posting (#1928)", () => {
  const LIVE = ["active", "draft_ready"];

  function wired() {
    const TX = { executor: "publish-test-tx" };
    type Stored = {
      postings: { id: string }[];
      spine: { event_name: string; subject_id: string }[];
    };
    const committed: Stored = { postings: [], spine: [] };
    let pending: Stored | null = null;
    const write = <K extends keyof Stored>(tx: unknown, into: K, value: Stored[K][number]) => {
      if (tx === undefined) (committed[into] as Stored[K][number][]).push(value);
      else if (tx === TX && pending !== null) (pending[into] as Stored[K][number][]).push(value);
      else throw new Error("write on an executor that is not the open transaction");
    };

    let seq = 0;
    const postingsRepo = {
      withTransaction: async (work: (tx: unknown) => Promise<unknown>) => {
        pending = { postings: [], spine: [] };
        try {
          const out = await work(TX);
          committed.postings.push(...pending.postings);
          committed.spine.push(...pending.spine);
          return out;
        } finally {
          pending = null;
        }
      },
      create: async (input: Record<string, unknown>, tx?: unknown) => {
        const posting = {
          id: `dddddddd-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
          created_by: input.createdBy,
          vacancy_band: input.vacancyBand,
          location_label: input.locationLabel ?? null,
          description: input.description ?? null,
          role_kind: input.roleKind ?? null,
          status: "draft",
        };
        write(tx, "postings", posting);
        return posting;
      },
    };

    // The FIRST events insert fails, as a dropped connection would; every later one succeeds.
    let failNextEventInsert = true;
    const eventsRepo = {
      insert: async (
        event: { event_name: string; subject: { subject_id: string } },
        _key?: string | null,
        executor?: unknown,
      ) => {
        if (failNextEventInsert) {
          failNextEventInsert = false;
          throw new Error("connection terminated unexpectedly");
        }
        write(executor, "spine", {
          event_name: event.event_name,
          subject_id: event.subject.subject_id,
        });
        return true;
      },
    };
    const traces = fakeAiTraceRecorder();
    const aiCost = { record: vi.fn(async () => {}) };
    const tenancy = defaultModeResolver();
    const jobPostings = new JobPostingsService(
      postingsRepo as never,
      new EventsService(eventsRepo as never, { NODE_ENV: "test" } as never),
      // The draft's skill phrase is canonicalized on the way in; unresolved is enough here.
      {
        canonicalizeSkill: vi.fn(async () => ({
          status: "unresolved",
          skill_id: null,
          score: null,
          ai_metadata: null,
        })),
      } as never,
      aiCost as never,
      traces.recorder,
      // A create never materializes reach and a chat publish sends no match_skill_ids.
      {} as never,
      {} as never,
      tenancy,
    );

    const session = {
      id: SESSION,
      payerId: PAYER_A,
      status: "draft_ready",
      conversationState: ENGINE_STATE,
      draft: FULL_DRAFT,
      publishedJobPostingId: null as string | null,
      startedAt: new Date("2026-10-03T09:00:00.000Z"),
      lastMessageAt: null,
      endedAt: null as Date | null,
    };
    const chat = {
      findOwnedSession: async (id: string, payerId: string) =>
        id === session.id && payerId === session.payerId ? { ...session } : undefined,
      claimForPublish: async (_id: string, _payerId: string, at: Date) => {
        if (!LIVE.includes(session.status) || session.publishedJobPostingId !== null) {
          return undefined;
        }
        session.status = "published";
        session.endedAt = at;
        return { ...session };
      },
      releasePublishClaim: async (_id: string, _payerId: string, to: string) => {
        if (session.publishedJobPostingId !== null) return;
        session.status = to;
        session.endedAt = null;
      },
      bindPublishedPosting: async (_id: string, _payerId: string, postingId: string) => {
        session.publishedJobPostingId = postingId;
      },
    };

    const svc = new JobPostingChatService(
      chat as never,
      { emit: vi.fn(async () => undefined) } as never,
      {} as never,
      aiCost as never,
      traces.recorder,
      { findById: async () => ({ id: PAYER_A, orgNameEnc: "ENC_ORG_TOKEN" }) } as never,
      { decrypt: () => ORG_NAME } as never,
      jobPostings,
      tenancy,
    );
    return { svc, committed, session };
  }

  it("the failed attempt leaves no posting and no event, and releases the session", async () => {
    const w = wired();
    await expect(w.svc.publish(PAYER_A, SESSION, CTX)).rejects.toThrow(
      "connection terminated unexpectedly",
    );
    // Rolled back with its event. Before #1928 the row had already committed here.
    expect(w.committed.postings).toEqual([]);
    expect(w.committed.spine).toEqual([]);
    // The release is now CORRECT: nothing exists for the session to be bound to.
    expect(w.session.status).toBe("draft_ready");
    expect(w.session.publishedJobPostingId).toBeNull();
  });

  it("the retry creates exactly ONE posting, bound, with its one job_posting.created; a third publish is a 409", async () => {
    const w = wired();
    await expect(w.svc.publish(PAYER_A, SESSION, CTX)).rejects.toThrow();
    const res = await w.svc.publish(PAYER_A, SESSION, CTX);

    expect(w.committed.postings.map((p) => p.id)).toEqual([res.job_posting_id]);
    // No posting without its event, and no event without its posting.
    expect(w.committed.spine).toEqual([
      { event_name: "job_posting.created", subject_id: res.job_posting_id },
    ]);
    expect(w.session.status).toBe("published");
    expect(w.session.publishedJobPostingId).toBe(res.job_posting_id);

    await expect(w.svc.publish(PAYER_A, SESSION, CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(w.committed.postings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
/**
 * #1922 — a turn that loses the race to a publish.
 *
 * The turn reads the session as live, then waits seconds on the ai-service; a publish can
 * claim the session in that window. `saveTurn`'s WHERE now refuses to write over a session
 * that is no longer live (pinned in `job-posting-chat.repository.test.ts`, evaluated against
 * Postgres in `job-posting-chat.repository.db.test.ts`) and reports `false`. These pin what
 * the service does with that `false`: the same 409 a turn on a closed session gets, and no
 * `draft_ready` for a flip that never landed.
 */
describe("JobPostingChatService — a turn that loses the race to a publish stores nothing (#1922)", () => {
  const liveSession = {
    id: SESSION,
    payerId: PAYER_A,
    status: "active",
    conversationState: ENGINE_STATE,
    draft: null,
    publishedJobPostingId: null,
    startedAt: new Date("2026-07-28T09:00:00.000Z"),
    lastMessageAt: null,
    endedAt: null,
  };

  let logged: string[];
  beforeEach(() => {
    logged = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("409s with the closed-session error, and emits no draft_ready for the flip that never landed", async () => {
    const d = make({ session: liveSession, turn: { draft_ready: true }, turnStored: false });
    const err = await d.svc
      .postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX)
      .catch((e: unknown) => e);

    // The SAME envelope a turn gets when the session is already closed on arrival, so a
    // client needs no second branch for "it closed while I was waiting".
    const closed = make({
      session: { ...liveSession, status: "published", publishedJobPostingId: POSTING },
    });
    const onArrival = await closed.svc
      .postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(onArrival).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual(
      (onArrival as ConflictException).getResponse(),
    );

    // The write WAS attempted with the ready flip; the guarded UPDATE refused it.
    expect(d.chat.saveTurn).toHaveBeenCalledOnce();
    expect(d.chat.saveTurn.mock.calls[0]![2]).toMatchObject({ status: "draft_ready" });
    // The spine records the two stored message rows and nothing about a turn that did not land.
    expect(d.emitted.map((e) => e.event_name)).toEqual([
      "job_posting_chat.message_sent",
      "job_posting_chat.message_sent",
    ]);
    // The log names the session, never the payer's text.
    expect(logged.some((l) => l.includes(SESSION))).toBe(true);
    expect(logged.join("\n")).not.toContain(PAYER_TEXT);
  });

  it("a BLOCKED turn whose activity-clock write is refused 409s the same way", async () => {
    const d = make({
      session: liveSession,
      turn: { blocked: true, draft: null, updated_state: null, reply_text: "Please retype that." },
      turnStored: false,
    });
    await expect(
      d.svc.postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(d.chat.saveTurn.mock.calls[0]![2]).toEqual({ lastMessageAt: expect.any(Date) });
    expect(d.emitted.map((e) => e.event_name)).not.toContain("job_posting_chat.draft_ready");
  });

  it("CONTROL: the same ready turn on a session that stayed live is answered and emits draft_ready", async () => {
    const d = make({ session: liveSession, turn: { draft_ready: true } });
    const res = await d.svc.postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX);
    expect(res.status).toBe("draft_ready");
    expect(d.emitted.map((e) => e.event_name)).toContain("job_posting_chat.draft_ready");
  });
});

// ---------------------------------------------------------------------------
/**
 * #1911 — the shared worker-visible screen runs on every turn's draft, not only at publish.
 *
 * Before this, a refused title or description sat in the draft, publish answered 400, and no
 * retry could clear it: the interview had marked the topic answered and never asked again.
 * The screen's own matrix is in `job-posting-chat.screen.test.ts`; these pin the service
 * wiring — what is stored, what is replied, what reaches the spine and the log.
 */
describe("JobPostingChatService — a refused title or description is re-asked during the interview (#1911)", () => {
  /** Each value trips exactly the named screen (pinned in the screen suite). */
  const TITLE_TRIPS = {
    contact_details: "CNC Operator call 9876543210",
    company_name: "Operator at Kalyani Pvt Ltd",
    link: "CNC Operator www.acme.in",
  } as const;
  const DESCRIPTION_TRIPS = {
    contact_details: "Machining work. Send CV to hr@acme.example",
    company_name: "Machining for Mehta & Co on the shop floor",
    link: "Machining work, details at www.acme.in",
  } as const;
  const REASON = {
    contact_details: "contact details",
    company_name: "a company name",
    link: "website links",
  } as const;

  const PRIOR_STATE = {
    trade_hint: null,
    turn_count: 3,
    answered_topics: ["role_title", "location_label", "city"],
    asked_question_ids: ["location_label"],
    collected: { role_title: "CNC Operator", location_label: "Chakan MIDC", city: "Pune" },
    clarify_count: 0,
    ask_counts: { location_label: 1 },
    unanswered_essentials: ["vacancy"],
  };

  const session = (patch: Record<string, unknown> = {}) => ({
    id: SESSION,
    payerId: PAYER_A,
    status: "active",
    conversationState: PRIOR_STATE,
    draft: null,
    publishedJobPostingId: null,
    startedAt: new Date("2026-07-28T09:00:00.000Z"),
    lastMessageAt: null,
    endedAt: null,
    ...patch,
  });

  /** One engine turn that recorded `patch` into the draft and served the shift question. */
  const engineTurn = (patch: { role_title?: string; description?: string }) => ({
    asked_question_id: "shift",
    draft: { ...FULL_DRAFT, ...patch },
    updated_state: {
      ...PRIOR_STATE,
      turn_count: 4,
      answered_topics: [...PRIOR_STATE.answered_topics, "vacancy", "description"],
      asked_question_ids: [...PRIOR_STATE.asked_question_ids, "shift"],
      collected: { ...PRIOR_STATE.collected, vacancy: "2-5", ...patch },
      ask_counts: { ...PRIOR_STATE.ask_counts, shift: 1 },
      unanswered_essentials: [],
    },
  });

  let logged: string[];
  beforeEach(() => {
    logged = [];
    const capture = (message: unknown): void => {
      logged.push(String(message));
    };
    vi.spyOn(Logger.prototype, "log").mockImplementation(capture);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(capture);
    vi.spyOn(Logger.prototype, "error").mockImplementation(capture);
  });
  afterEach(() => vi.restoreAllMocks());

  async function run(turn: Record<string, unknown>, sessionPatch: Record<string, unknown> = {}) {
    const d = make({ session: session(sessionPatch), turn });
    const res = await d.svc.postMessage(PAYER_A, { session_id: SESSION, text: "answer" }, CTX);
    const saved = d.chat.saveTurn.mock.calls[0]![2] as {
      conversationState: {
        collected: Record<string, unknown>;
        answered_topics: string[];
        asked_question_ids: string[];
        ask_counts: Record<string, number>;
        draft_ready_emitted?: boolean;
      };
      draft: Record<string, unknown>;
      status: string;
    };
    const outbound = d.chat.insertMessage.mock.calls[1]![0] as {
      bodyText: string;
      metadata: Record<string, unknown>;
    };
    return { d, res, saved, outbound };
  }

  for (const [screen, value] of Object.entries(TITLE_TRIPS)) {
    it(`a title that trips ${screen} is dropped and re-asked, never echoed`, async () => {
      const { d, res, saved, outbound } = await run(engineTurn({ role_title: value }));

      // The re-ask REPLACES the engine's reply, names the field and the reason class.
      expect(res.reply_text).not.toBe(ASSISTANT_TEXT);
      expect(res.reply_text).toContain("job title");
      expect(res.reply_text).toContain(REASON[screen as keyof typeof REASON]);
      expect(res.asked_question_id).toBe("role_title");
      // The engine's chips answered ITS question (the shift); the title has none.
      expect(res.suggested_replies).toEqual([]);
      expect(res.draft_ready).toBe(false);
      expect(res.draft?.role_title).toBeNull();
      expect(outbound.bodyText).toBe(res.reply_text);
      expect(outbound.metadata).toEqual({
        is_mock: true,
        blocked: false,
        refused_fields: ["role_title"],
      });

      // The PERSISTED draft and state lack the value, and the next message answers the title.
      expect(saved.draft.role_title).toBeNull();
      expect(saved.conversationState.collected).not.toHaveProperty("role_title");
      expect(saved.conversationState.answered_topics).not.toContain("role_title");
      expect(saved.conversationState.asked_question_ids).toEqual(["location_label", "role_title"]);
      // The engine's shift question was never shown, so it is not counted as asked.
      expect(saved.conversationState.ask_counts).toEqual({ location_label: 1 });
      // The rest of the turn's answers are kept.
      expect(saved.conversationState.collected).toMatchObject({ vacancy: "2-5" });

      // Never the refused text: not in the reply, the stored draft or state, an event, a log.
      expect(res.reply_text).not.toContain(value);
      expect(JSON.stringify(saved)).not.toContain(value);
      expect(JSON.stringify(d.emitted)).not.toContain(value);
      d.emitted.forEach(assertRegistryValid);
      expect(logged.some((l) => l.includes("role_title"))).toBe(true);
      for (const line of logged) expect(line).not.toContain(value);
    });
  }

  for (const [screen, value] of Object.entries(DESCRIPTION_TRIPS)) {
    it(`a description that trips ${screen} is dropped and re-asked, never echoed`, async () => {
      const { d, res, saved, outbound } = await run(engineTurn({ description: value }));

      expect(res.reply_text).toContain("job description");
      expect(res.reply_text).toContain(REASON[screen as keyof typeof REASON]);
      expect(res.asked_question_id).toBe("description");
      expect(res.draft?.description).toBeNull();
      // The clean title is untouched.
      expect(res.draft?.role_title).toBe("CNC Operator");
      expect(outbound.metadata.refused_fields).toEqual(["description"]);

      expect(saved.draft.description).toBeNull();
      expect(saved.draft.role_title).toBe("CNC Operator");
      expect(saved.conversationState.collected).not.toHaveProperty("description");
      expect(saved.conversationState.answered_topics).not.toContain("description");
      expect(saved.conversationState.asked_question_ids.at(-1)).toBe("description");

      expect(res.reply_text).not.toContain(value);
      expect(JSON.stringify(saved)).not.toContain(value);
      expect(JSON.stringify(d.emitted)).not.toContain(value);
      for (const line of logged) expect(line).not.toContain(value);
    });
  }

  it("both failing at once: one reply names both, the title is asked first, both are dropped", async () => {
    const title = TITLE_TRIPS.link;
    const description = DESCRIPTION_TRIPS.contact_details;
    const { d, res, saved, outbound } = await run(engineTurn({ role_title: title, description }));

    expect(res.reply_text).toBe(
      "Workers see the job title and job description, so they can't include contact details " +
        "or website links. What is the job title — for example CNC Operator, MIG Welder or Plumber?",
    );
    expect(res.asked_question_id).toBe("role_title");
    expect(outbound.metadata.refused_fields).toEqual(["role_title", "description"]);
    expect(saved.draft).toMatchObject({ role_title: null, description: null });
    expect(saved.conversationState.collected).not.toHaveProperty("role_title");
    expect(saved.conversationState.collected).not.toHaveProperty("description");
    for (const value of [title, description]) {
      expect(JSON.stringify(saved)).not.toContain(value);
      expect(JSON.stringify(d.emitted)).not.toContain(value);
      expect(JSON.stringify(res)).not.toContain(value);
    }
  });

  it("a clean title and description pass untouched — the engine's turn is stored and returned as is", async () => {
    const turn = engineTurn({});
    const { res, saved, outbound } = await run(turn);

    expect(res.reply_text).toBe(ASSISTANT_TEXT);
    expect(res.suggested_replies).toEqual(["Day", "Night"]);
    expect(res.asked_question_id).toBe("shift");
    expect(res.draft).toEqual(FULL_DRAFT);
    expect(saved.draft).toEqual(FULL_DRAFT);
    expect(saved.conversationState).toEqual(turn.updated_state);
    expect(outbound.metadata).toEqual({ is_mock: true, blocked: false });
    expect(logged.filter((l) => l.includes("re-asking"))).toEqual([]);
  });

  it("a refused description on the engine's WRAP-UP is not ready: no draft_ready event, status stays active", async () => {
    const { d, res, saved } = await run({
      ...engineTurn({ description: DESCRIPTION_TRIPS.link }),
      draft_ready: true,
      asked_question_id: null,
      reply_text: "That's everything I need.",
    });

    expect(res.draft_ready).toBe(false);
    expect(res.status).toBe("active");
    expect(saved.status).toBe("active");
    expect(saved.conversationState.draft_ready_emitted).toBeUndefined();
    expect(d.emitted.map((e) => e.event_name)).not.toContain("job_posting_chat.draft_ready");
  });

  it("a draft_ready session whose turn is refused goes back to active, and the ready event is not re-emitted later", async () => {
    const { d, res, saved } = await run(
      { ...engineTurn({ role_title: TITLE_TRIPS.company_name }), draft_ready: true },
      {
        status: "draft_ready",
        conversationState: { ...PRIOR_STATE, draft_ready_emitted: true },
      },
    );

    expect(res.status).toBe("active");
    expect(saved.status).toBe("active");
    // The once-per-session marker survives, so the next wrap-up does not emit again.
    expect(saved.conversationState.draft_ready_emitted).toBe(true);
    expect(d.emitted.map((e) => e.event_name)).not.toContain("job_posting_chat.draft_ready");
  });

  it("a refused overwrite of a clean description keeps the earlier one, stored and returned", async () => {
    // After the wrap-up the description is still the last asked question, so the payer's
    // next message overwrites it. A refused overwrite must not cost them the earlier text.
    const earlier = FULL_DRAFT.description;
    const storedState = {
      ...PRIOR_STATE,
      answered_topics: [...PRIOR_STATE.answered_topics, "vacancy", "description"],
      asked_question_ids: [...PRIOR_STATE.asked_question_ids, "description"],
      collected: { ...PRIOR_STATE.collected, vacancy: "2-5", description: earlier },
      ask_counts: { ...PRIOR_STATE.ask_counts, description: 1 },
      unanswered_essentials: [],
      draft_ready_emitted: true,
    };
    const refused = DESCRIPTION_TRIPS.link;
    const { d, res, saved, outbound } = await run(
      {
        asked_question_id: null,
        draft_ready: true,
        reply_text: "That's everything I need.",
        draft: { ...FULL_DRAFT, description: refused },
        updated_state: {
          ...storedState,
          turn_count: 4,
          collected: { ...storedState.collected, description: refused },
        },
      },
      { status: "draft_ready", conversationState: storedState, draft: FULL_DRAFT },
    );

    expect(res.draft?.description).toBe(earlier);
    expect(saved.draft.description).toBe(earlier);
    expect(saved.conversationState.collected.description).toBe(earlier);
    expect(saved.conversationState.answered_topics).toContain("description");
    expect(res.asked_question_id).toBe("description");
    expect(res.reply_text).toContain("Your earlier job description is still in the draft.");
    expect(res.reply_text).toContain('Reply "no" to keep the earlier one.');
    // Still a question on screen: not ready, and the session is live again.
    expect(res.draft_ready).toBe(false);
    expect(saved.status).toBe("active");
    expect(outbound.metadata.refused_fields).toEqual(["description"]);
    expect(logged.some((l) => l.includes("kept=[description]"))).toBe(true);

    for (const blob of [JSON.stringify(saved), JSON.stringify(res), JSON.stringify(d.emitted)]) {
      expect(blob).not.toContain(refused);
    }
    for (const line of logged) expect(line).not.toContain(refused);
  });

  it("a draft that arrives WITHOUT a state is not stored, and its refused value is not returned", async () => {
    // Outside the ai-service contract (a blocked turn nulls both), but every draft value
    // that leaves the service must still have met the screen.
    const value = TITLE_TRIPS.contact_details;
    const { d, res, saved, outbound } = await run({
      ...engineTurn({ role_title: value }),
      updated_state: null,
    });

    expect(res.draft?.role_title).toBeNull();
    expect(res.draft?.missing_fields).toEqual(["role_title"]);
    // Nothing to reopen, so this is not a re-ask: the engine's reply stands.
    expect(res.reply_text).toBe(ASSISTANT_TEXT);
    expect(outbound.metadata).toEqual({ is_mock: true, blocked: false });
    // Only the activity clock moves.
    expect(Object.keys(saved)).toEqual(["lastMessageAt"]);
    expect(JSON.stringify(res)).not.toContain(value);
    expect(JSON.stringify(d.emitted)).not.toContain(value);
    expect(logged.some((l) => l.includes("role_title:contact_details"))).toBe(true);
    for (const line of logged) expect(line).not.toContain(value);
  });

  /**
   * #1921 — the same screen on each `benefits` / `requirements` chip. The engine asks each list
   * once and unions every answer into `collected`, so the refused chip must leave the STORED
   * list (or the next turn rebuilds it), the clean chips stay, and the list is asked again.
   * The matrix is in the screen suite; these pin what is stored, replied, evented and logged.
   */
  describe("benefits / requirements chips (#1921)", () => {
    /** Each chip trips exactly the named screen (pinned in the screen suite). */
    const CHIP_TRIPS = {
      benefits: {
        contact_details: "call HR 9876543210",
        company_name: "Canteen by Kalyani Pvt Ltd",
        link: "details www.acme.in",
      },
      requirements: {
        contact_details: "Contact hr@acme.example",
        company_name: "Licence from Sharma & Co",
        link: "apply at acme.in",
      },
    } as const;
    /** The bank's own options for benefits, served with its re-ask. */
    const BENEFIT_CHIPS = ["PF + ESI", "Canteen", "Transport", "Accommodation"];
    const ASKED_BEFORE_LISTS = [
      "location_label",
      "vacancy",
      "skills",
      "pay_range",
      "pay_type",
      "experience",
      "shift",
      "needed_by",
    ];
    const ONE_EACH = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, 1]));

    /** The stored state with `field`'s question on screen, every topic before it answered. */
    const listOnScreen = (field: "benefits" | "requirements") => {
      const asked = [
        ...ASKED_BEFORE_LISTS,
        "benefits",
        ...(field === "requirements" ? ["requirements"] : []),
      ];
      return {
        ...PRIOR_STATE,
        turn_count: asked.length,
        answered_topics: [
          ...PRIOR_STATE.answered_topics,
          ...ASKED_BEFORE_LISTS.filter((t) => t !== "location_label"),
          ...(field === "requirements" ? ["benefits"] : []),
        ],
        asked_question_ids: asked,
        ask_counts: ONE_EACH(asked),
        collected: {
          ...PRIOR_STATE.collected,
          ...(field === "requirements" ? { benefits: ["PF"] } : {}),
        },
        unanswered_essentials: [],
      };
    };

    /** The engine recorded `chips` for `field` and served the next question. */
    const listTurn = (field: "benefits" | "requirements", chips: string[]) => {
      const prior = listOnScreen(field);
      const next = field === "benefits" ? "requirements" : "description";
      const turn = {
        asked_question_id: next,
        draft: { ...FULL_DRAFT, [field]: chips },
        updated_state: {
          ...prior,
          turn_count: prior.turn_count + 1,
          answered_topics: [...prior.answered_topics, field],
          asked_question_ids: [...prior.asked_question_ids, next],
          ask_counts: { ...prior.ask_counts, [next]: 1 },
          collected: { ...prior.collected, [field]: chips },
        },
      };
      return { prior, turn };
    };

    for (const field of ["benefits", "requirements"] as const) {
      for (const [screen, value] of Object.entries(CHIP_TRIPS[field])) {
        it(`a ${field} chip that trips ${screen} is dropped, the clean chips kept, the list re-asked, never echoed`, async () => {
          const { prior, turn } = listTurn(field, ["ITI", value, "Free bus"]);
          const { d, res, saved, outbound } = await run(turn, { conversationState: prior });

          // The re-ask REPLACES the engine's reply and its chips.
          expect(res.reply_text).toContain(`Workers see the ${field}, so they can't include`);
          expect(res.reply_text).toContain(REASON[screen as keyof typeof REASON]);
          expect(res.reply_text).toContain('Reply "no" if there are none.');
          expect(res.asked_question_id).toBe(field);
          // Clean chips are left, so the list is asked for more, with "No" as a tap.
          expect(res.suggested_replies).toEqual(
            field === "benefits" ? [...BENEFIT_CHIPS, "No"] : ["No"],
          );
          expect(res.draft_ready).toBe(false);
          expect(res.draft?.[field]).toEqual(["ITI", "Free bus"]);
          expect(outbound.bodyText).toBe(res.reply_text);
          expect(outbound.metadata).toEqual({
            is_mock: true,
            blocked: false,
            refused_fields: [field],
          });

          // The STORED list loses only the refused chip, so the engine's union cannot bring it
          // back; the list stays answered and goes back on screen, the engine's pick un-served.
          expect(saved.draft[field]).toEqual(["ITI", "Free bus"]);
          expect(saved.conversationState.collected[field]).toEqual(["ITI", "Free bus"]);
          expect(saved.conversationState.answered_topics).toContain(field);
          expect(saved.conversationState.asked_question_ids).toEqual(prior.asked_question_ids);
          expect(saved.conversationState.asked_question_ids.at(-1)).toBe(field);
          expect(saved.conversationState.ask_counts).toEqual(prior.ask_counts);

          // Never the refused text: not in the reply, the stored draft or state, an event, a log.
          expect(JSON.stringify(res)).not.toContain(value);
          expect(JSON.stringify(saved)).not.toContain(value);
          expect(JSON.stringify(d.emitted)).not.toContain(value);
          d.emitted.forEach(assertRegistryValid);
          expect(logged.some((l) => l.includes(`${field}:${screen}`))).toBe(true);
          expect(logged.some((l) => l.includes(`kept=[${field}]`))).toBe(true);
          for (const line of logged) expect(line).not.toContain(value);
        });
      }
    }

    it("every chip refused: the list is emptied, listed as missing, and asked from the top", async () => {
      const value = CHIP_TRIPS.benefits.link;
      const { turn } = listTurn("benefits", [value]);
      const { res, saved } = await run(turn, { conversationState: listOnScreen("benefits") });

      expect(res.reply_text).toBe(
        "Workers see the benefits, so they can't include website links. " +
          "Which benefits are included — PF, ESI, canteen, transport or accommodation?",
      );
      expect(res.suggested_replies).toEqual(BENEFIT_CHIPS);
      expect(res.draft?.benefits).toEqual([]);
      expect(res.draft?.missing_fields).toEqual(["benefits"]);
      expect(saved.conversationState.collected).not.toHaveProperty("benefits");
      expect(saved.conversationState.answered_topics).not.toContain("benefits");
      expect(saved.conversationState.asked_question_ids.at(-1)).toBe("benefits");
      expect(JSON.stringify(saved)).not.toContain(value);
    });

    it("a dropped chip is not resurrected: the next turn hands the engine the clean list", async () => {
      const value = CHIP_TRIPS.benefits.link;
      const { prior, turn } = listTurn("benefits", ["PF", "ESI", value]);
      const first = await run(turn, { conversationState: prior });
      const stored = first.saved.conversationState;

      // Turn 2: the payer replies "no". The engine records nothing for the list, rebuilds the
      // draft from the stored list, and serves the requirements question it was denied.
      const second = make({
        session: session({ conversationState: stored, draft: first.saved.draft }),
        turn: {
          asked_question_id: "requirements",
          suggested_answers: [],
          draft: first.saved.draft,
          updated_state: {
            ...stored,
            turn_count: 12,
            asked_question_ids: [...stored.asked_question_ids, "requirements"],
            ask_counts: { ...stored.ask_counts, requirements: 1 },
          },
        },
      });
      const res = await second.svc.postMessage(PAYER_A, { session_id: SESSION, text: "no" }, CTX);

      const handed = second.ai.jobPostingChatRespond.mock.calls[0]![0] as {
        conversation_state: { collected: Record<string, unknown> };
      };
      expect(handed.conversation_state.collected.benefits).toEqual(["PF", "ESI"]);
      expect(JSON.stringify(handed)).not.toContain(value);
      // A clean turn: the engine's own reply, stored as it is.
      expect(res.reply_text).toBe(ASSISTANT_TEXT);
      expect(res.asked_question_id).toBe("requirements");
      expect(res.draft?.benefits).toEqual(["PF", "ESI"]);
      expect(JSON.stringify(second.chat.saveTurn.mock.calls[0]![2])).not.toContain(value);
    });

    it("a refused title in the same turn: one reply names both, the title is asked, the clean chips stay", async () => {
      const title = TITLE_TRIPS.company_name;
      const chip = CHIP_TRIPS.benefits.contact_details;
      const prior = listOnScreen("benefits");
      // A session stored before #1911 still holds a refused title.
      const legacy = { ...prior, collected: { ...prior.collected, role_title: title } };
      const { turn } = listTurn("benefits", ["PF", chip]);
      const { d, res, saved, outbound } = await run(
        {
          ...turn,
          draft: { ...turn.draft, role_title: title },
          updated_state: {
            ...turn.updated_state,
            collected: { ...turn.updated_state.collected, role_title: title },
          },
        },
        { conversationState: legacy, draft: { ...FULL_DRAFT, role_title: title } },
      );

      expect(res.reply_text).toBe(
        "Workers see the job title and benefits, so they can't include contact details or a " +
          "company name. The rest of the benefits are still in the draft. " +
          "What is the job title — for example CNC Operator, MIG Welder or Plumber?",
      );
      expect(res.asked_question_id).toBe("role_title");
      expect(res.suggested_replies).toEqual([]);
      expect(outbound.metadata.refused_fields).toEqual(["role_title", "benefits"]);
      expect(saved.draft).toMatchObject({ role_title: null, benefits: ["PF"] });
      expect(saved.conversationState.collected).not.toHaveProperty("role_title");
      expect(saved.conversationState.collected.benefits).toEqual(["PF"]);
      expect(saved.conversationState.answered_topics).toContain("benefits");
      expect(saved.conversationState.asked_question_ids.at(-1)).toBe("role_title");
      for (const value of [title, chip]) {
        expect(JSON.stringify(res)).not.toContain(value);
        expect(JSON.stringify(saved)).not.toContain(value);
        expect(JSON.stringify(d.emitted)).not.toContain(value);
        for (const line of logged) expect(line).not.toContain(value);
      }
    });

    it("a list re-asked at the wrap-up, once answered, gives the next message back to the description", async () => {
      // The stored state of a benefits re-ask at the wrap-up: benefits last, so the payer's
      // "Canteen" reaches it. The engine records it, wraps up and appends nothing.
      const asked = [...ASKED_BEFORE_LISTS, "requirements", "description", "benefits"];
      const reasked = {
        ...PRIOR_STATE,
        turn_count: 13,
        answered_topics: [
          ...PRIOR_STATE.answered_topics,
          ...ASKED_BEFORE_LISTS.filter((t) => t !== "location_label"),
          "requirements",
          "description",
        ],
        asked_question_ids: asked,
        ask_counts: ONE_EACH(asked),
        collected: { ...PRIOR_STATE.collected, description: FULL_DRAFT.description },
        unanswered_essentials: [],
      };
      const engineState = {
        ...reasked,
        turn_count: 14,
        answered_topics: [...reasked.answered_topics, "benefits"],
        collected: { ...reasked.collected, benefits: ["Canteen"] },
      };
      const { res, saved } = await run(
        {
          asked_question_id: null,
          draft_ready: true,
          reply_text: "That's everything I need.",
          suggested_answers: [],
          draft: { ...FULL_DRAFT, benefits: ["Canteen"] },
          updated_state: engineState,
        },
        { conversationState: reasked },
      );

      // A clean wrap-up: the engine's reply and draft, ready.
      expect(res.reply_text).toBe("That's everything I need.");
      expect(res.asked_question_id).toBeNull();
      expect(res.draft_ready).toBe(true);
      expect(saved.status).toBe("draft_ready");
      // Only the attribution target moves: the description is last again, so a later
      // "ok" revises it instead of becoming a benefit a worker reads.
      expect(saved.conversationState.asked_question_ids).toEqual([
        ...ASKED_BEFORE_LISTS,
        "requirements",
        "benefits",
        "description",
      ]);
      expect(saved.conversationState.collected).toEqual(engineState.collected);
      expect(saved.conversationState.answered_topics).toEqual(engineState.answered_topics);
      expect(saved.conversationState.ask_counts).toEqual(engineState.ask_counts);
      expect(logged.some((l) => l.includes("description takes the next message"))).toBe(true);
    });

    it("a draft that arrives WITHOUT a state has its refused chips removed and is not stored", async () => {
      const value = CHIP_TRIPS.requirements.link;
      const { res, saved, outbound } = await run({
        ...listTurn("requirements", [value]).turn,
        updated_state: null,
      });

      expect(res.draft?.requirements).toEqual([]);
      expect(res.draft?.missing_fields).toEqual(["requirements"]);
      expect(res.reply_text).toBe(ASSISTANT_TEXT);
      expect(outbound.metadata).toEqual({ is_mock: true, blocked: false });
      expect(Object.keys(saved)).toEqual(["lastMessageAt"]);
      expect(JSON.stringify(res)).not.toContain(value);
      expect(logged.some((l) => l.includes("requirements:link"))).toBe(true);
      for (const line of logged) expect(line).not.toContain(value);
    });
  });

  describe("publish still screens (defence in depth)", () => {
    for (const [field, value, message] of [
      ["role_title", TITLE_TRIPS.company_name, "title must not contain a company name"],
      [
        "description",
        DESCRIPTION_TRIPS.contact_details,
        "remove contact details from the description",
      ],
    ] as const) {
      it(`a stored ${field} the screen refuses is a 400 that names the field and never echoes it`, async () => {
        const d = make({
          session: session({ status: "draft_ready", draft: { ...FULL_DRAFT, [field]: value } }),
        });
        const err = await d.svc.publish(PAYER_A, SESSION, CTX).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        const body = (err as BadRequestException).getResponse() as {
          issues: { path: string; message: string }[];
        };
        expect(body.issues).toEqual([{ path: field, message }]);
        expect(JSON.stringify(body)).not.toContain(value);
        for (const line of logged) expect(line).not.toContain(value);
        expect(d.chat.claimForPublish).not.toHaveBeenCalled();
        expect(d.jobPostings.createInScope).not.toHaveBeenCalled();
      });
    }

    // #1921: a chip stored before the chat screened chips still meets the create schema.
    for (const [field, value, message] of [
      ["benefits", "details www.acme.in", "benefits must not contain links"],
      ["requirements", "Contact hr@acme.example", "remove contact details from requirements"],
    ] as const) {
      it(`a stored ${field} chip the screen refuses is a 400 at ${field}.1 that never echoes it`, async () => {
        const d = make({
          session: session({
            status: "draft_ready",
            draft: { ...FULL_DRAFT, [field]: ["PF", value] },
          }),
        });
        const err = await d.svc.publish(PAYER_A, SESSION, CTX).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        const body = (err as BadRequestException).getResponse() as {
          issues: { path: string; message: string }[];
        };
        expect(body.issues).toEqual([{ path: `${field}.1`, message }]);
        expect(JSON.stringify(body)).not.toContain(value);
        for (const line of logged) expect(line).not.toContain(value);
        expect(d.chat.claimForPublish).not.toHaveBeenCalled();
        expect(d.jobPostings.createInScope).not.toHaveBeenCalled();
      });
    }
  });
});

// ---------------------------------------------------------------------------
describe("JobPostingChatService — no free text and no org name on the event spine (§2)", () => {
  /**
   * THE INVARIANT, STATED AS A TEST: run the whole flow with distinctive strings in
   * every free-text position, then assert none of them appears ANYWHERE in ANY emitted
   * event — not in the payload, not in the actor, not in the subject. The `.strict()`
   * payload schemas make this structural; this proves the call sites agree.
   */
  it("no emitted event contains the payer's message, the reply, a draft VALUE, or the org name", async () => {
    const d = make({
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "active",
        conversationState: null,
        draft: null,
        publishedJobPostingId: null,
        startedAt: new Date(),
        lastMessageAt: null,
        endedAt: null,
      },
      turn: { draft_ready: true },
    });

    await d.svc.startSession(PAYER_A, CTX);
    await d.svc.postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX);

    expect(d.emitted.length).toBeGreaterThan(0);
    const wire = JSON.stringify(d.emitted);
    for (const secret of [
      ORG_NAME,
      PAYER_TEXT,
      ASSISTANT_TEXT,
      "CNC Operator", // draft role_title
      "Chakan MIDC", // draft location_label
      "Pune", // draft city (#1726)
      "fanuc control", // draft skill phrase
      "Machining shop floor", // draft description
      "20000", // draft pay figure
      "PF and ESI", // draft benefit
      "Tell me about the role", // the opener
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("every emitted payload holds ONLY the keys its registry schema names", async () => {
    const d = make({ turn: { draft_ready: true } });
    await d.svc.startSession(PAYER_A, CTX);
    await d.svc.postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX);

    for (const e of d.emitted) {
      assertRegistryValid(e);
      const allowed =
        e.event_name === "job_posting_chat.message_sent"
          ? ["session_id", "payer_id", "message_id", "message_type"]
          : ["session_id", "payer_id"];
      expect(Object.keys(e.payload).sort()).toEqual([...allowed].sort());
    }
  });

  it("every event carries a stable idempotency key (TD18 — exactly-once on retry)", async () => {
    const d = make({ turn: { draft_ready: true } });
    await d.svc.startSession(PAYER_A, CTX);
    await d.svc.postMessage(PAYER_A, { session_id: SESSION, text: PAYER_TEXT }, CTX);
    for (const e of d.emitted) {
      expect(e.idempotencyKey).toBeTruthy();
      expect(e.idempotencyKey).toContain(e.event_name);
    }
  });
});

// ---------------------------------------------------------------------------
/**
 * THE FROZEN WIRE CONTRACT.
 *
 * Two client teams (apps/payer-web and the Flutter payer app) build against these
 * exact keys in parallel, per ADR-0035 §Decision 7 — they cannot read this service,
 * only its responses. Renaming a key is therefore a breaking change to two codebases
 * at once, so the key SETS are pinned here rather than left to be discovered at
 * integration time. If one of these fails, fix the clients too, or revert the rename.
 */
describe("JobPostingChatService — the frozen response key sets", () => {
  const keys = (o: object) => Object.keys(o).sort();

  it("POST /session and POST /message return the SAME turn shape", async () => {
    const d = make();
    const start = await d.svc.startSession(PAYER_A, CTX);
    const turn = await d.svc.postMessage(PAYER_A, { session_id: SESSION, text: "hi" }, CTX);

    const TURN_KEYS = [
      "asked_question_id",
      "blocked",
      "draft",
      "draft_ready",
      "is_mock",
      "message_id",
      "reply_text",
      "session_id",
      "status",
      "suggested_replies",
    ];
    // `started_at` rides ONLY the session-start turn (a session is created once).
    expect(keys(start)).toEqual([...TURN_KEYS, "started_at"].sort());
    expect(keys(turn)).toEqual(TURN_KEYS);
  });

  it("GET /sessions rows are FLAT (role_title at the top level, not nested)", async () => {
    const d = make();
    const { sessions } = await d.svc.listSessions(PAYER_A);
    expect(keys(sessions[0]!)).toEqual([
      "city",
      "draft_ready",
      "last_message_at",
      "location_label",
      "published_job_posting_id",
      "role_title",
      "session_id",
      "started_at",
      "status",
      "vacancy_band",
    ]);
  });

  it("GET /sessions/:id/messages carries the transcript AND the resumable surface", async () => {
    const d = make();
    const res = await d.svc.listMessages(PAYER_A, SESSION);
    expect(keys(res)).toEqual([
      "draft",
      "draft_ready",
      "messages",
      "published_job_posting_id",
      "session_id",
      "status",
    ]);
  });

  it("transcript rows carry id + type (both clients key their bubble lists on id)", async () => {
    const d = make();
    d.chat.listMessages.mockResolvedValue([
      {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        direction: "inbound",
        messageType: "text",
        bodyText: PAYER_TEXT,
        createdAt: new Date("2026-07-28T09:01:00.000Z"),
      },
    ] as never);
    const res = await d.svc.listMessages(PAYER_A, SESSION);
    expect(keys(res.messages[0]!)).toEqual([
      "body_text",
      "created_at",
      "direction",
      "id",
      "message_type",
    ]);
  });

  it("POST /sessions/:id/publish returns the REAL posting id", async () => {
    const d = make({
      session: {
        id: SESSION,
        payerId: PAYER_A,
        status: "draft_ready",
        conversationState: ENGINE_STATE,
        draft: FULL_DRAFT,
        publishedJobPostingId: null,
        startedAt: new Date(),
        lastMessageAt: null,
        endedAt: null,
      },
    });
    const res = await d.svc.publish(PAYER_A, SESSION, CTX);
    expect(keys(res)).toEqual([
      "job_posting_id",
      "session_id",
      "status",
      "unmapped_fields",
      "unset_card_fields",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ADR-0053 (PAY-DB-01) P2a — publish creates the posting under the TENANT; the session stays
// the acting login's (member-private drafts, O-7). The REAL resolver over in-memory memberships.
// ---------------------------------------------------------------------------
describe("ADR-0053 P2a — publish: the posting is the org's, the conversation stays the login's", () => {
  const ANCHOR = "bbbbbbbb-0000-4000-8000-0000000000aa";
  const ON = { PAYER_ORG_TENANCY_MODE: "on" } as unknown as ServerConfig;
  const session = {
    id: SESSION,
    payerId: PAYER_A,
    status: "draft_ready",
    conversationState: ENGINE_STATE,
    draft: FULL_DRAFT,
    publishedJobPostingId: null,
    startedAt: new Date(),
    lastMessageAt: null,
    endedAt: null,
  };

  it("on: a teammate's publish hands the create the ORG's scope; the claim and the bind stay keyed by the login", async () => {
    const d = make({
      session,
      tenancy: resolverOver(ON, [{ anchor: ANCHOR, members: [PAYER_A] }]),
    });
    await d.svc.publish(PAYER_A, SESSION, CTX);
    const [scope] = d.jobPostings.createInScope.mock.calls[0]! as unknown as [PayerTenantScope];
    expect(scope).toMatchObject({ actorPayerId: PAYER_A, tenantKey: ANCHOR, mode: "on" });
    expect(d.chat.claimForPublish).toHaveBeenCalledWith(SESSION, PAYER_A, expect.any(Date));
    expect(d.chat.bindPublishedPosting).toHaveBeenCalledWith(SESSION, PAYER_A, POSTING);
  });

  it("on: a refused resolution (R3, two team memberships) is the neutral 403 BEFORE the claim — nothing is claimed or created", async () => {
    const d = make({
      session,
      tenancy: resolverOver(ON, [
        { anchor: ANCHOR, members: [PAYER_A] },
        { anchor: "bbbbbbbb-0000-4000-8000-0000000000bb", members: [PAYER_A] },
      ]),
    });
    const quiet = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const err = await d.svc.publish(PAYER_A, SESSION, CTX).catch((e: unknown) => e);
    quiet.mockRestore();
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(d.chat.claimForPublish).not.toHaveBeenCalled();
    expect(d.jobPostings.createInScope).not.toHaveBeenCalled();
  });

  it("off (the default): the SAME teammate's publish is their own posting — today's behaviour", async () => {
    const d = make({
      session,
      tenancy: defaultModeResolver([{ anchor: ANCHOR, members: [PAYER_A] }]),
    });
    await d.svc.publish(PAYER_A, SESSION, CTX);
    const [scope] = d.jobPostings.createInScope.mock.calls[0]! as unknown as [PayerTenantScope];
    expect(scope).toMatchObject({ actorPayerId: PAYER_A, tenantKey: PAYER_A, mode: "off" });
  });
});
