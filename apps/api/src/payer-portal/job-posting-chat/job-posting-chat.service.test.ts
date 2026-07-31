import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../../common/request-context";
import { JobPostingChatService } from "./job-posting-chat.service";

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
  location_label: "Pune",
  vacancy_band: "2-5",
  pay_min: 20000,
  pay_max: 25000,
  shift: "day",
  benefits: ["PF and ESI"],
  requirements: ["ITI preferred"],
  description: "Machining shop floor role on our production line",
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
    createThrows?: Error;
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
    saveTurn: vi.fn(
      async (_sessionId: string, _payerId: string, _patch: Record<string, unknown>) => undefined,
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

  const ai = {
    jobPostingChatOpening: vi.fn(async () =>
      opts.openingText === undefined
        ? "Tell me about the role you are hiring for."
        : opts.openingText,
    ),
    jobPostingChatRespond: vi.fn(async (_input: Record<string, unknown>) =>
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
    createForPayer: vi.fn(
      async (_payerId: string, _dto: Record<string, unknown>, _ctx: RequestContext) => {
        if (opts.createThrows) throw opts.createThrows;
        return { id: POSTING, status: "draft" };
      },
    ),
  };

  const svc = new JobPostingChatService(
    chat as never,
    events as never,
    ai as never,
    payers as never,
    pii as never,
    jobPostings as never,
  );
  return { svc, chat, events, emitted, ai, payers, pii, jobPostings };
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
    expect(d.jobPostings.createForPayer).not.toHaveBeenCalled();
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
      location_label: "Pune",
      vacancy_band: "2-5",
    });
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

  it("calls createForPayer with the SESSION payer and the mapped draft", async () => {
    const res = await d.svc.publish(PAYER_A, SESSION, CTX);

    expect(d.jobPostings.createForPayer).toHaveBeenCalledTimes(1);
    const [payerId, dto, ctx] = d.jobPostings.createForPayer.mock.calls[0]! as unknown as [
      string,
      Record<string, unknown>,
      RequestContext,
    ];
    expect(payerId).toBe(PAYER_A);
    expect(ctx).toBe(CTX);
    expect(dto).toEqual({
      org_label: ORG_NAME,
      role_title: "CNC Operator",
      location_label: "Pune",
      description: "Machining shop floor role on our production line",
      vacancy_band: "2-5",
      skills: ["fanuc control"],
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

  it("sends the BANDED vacancy and never a raw count (ADR-0012)", async () => {
    await d.svc.publish(PAYER_A, SESSION, CTX);
    const dto = d.jobPostings.createForPayer.mock.calls[0]![1] as Record<string, unknown>;
    expect(dto.vacancy_band).toBe("2-5");
    expect("vacancies" in dto).toBe(false);
  });

  it("does NOT emit job_posting.created itself — createForPayer is the single writer", async () => {
    await d.svc.publish(PAYER_A, SESSION, CTX);
    expect(d.emitted.map((e) => e.event_name)).not.toContain("job_posting.created");
    // Publish adds NO event of its own at all (ADR-0035 §Decision 6).
    expect(d.emitted).toHaveLength(0);
  });

  it("reports the fields the posting cannot store, by NAME and never by value", async () => {
    const res = await d.svc.publish(PAYER_A, SESSION, CTX);
    expect(res.unmapped_fields).toEqual([
      "pay_min",
      "pay_max",
      "shift",
      "benefits",
      "requirements",
    ]);
    expect(JSON.stringify(res)).not.toContain("20000");
    expect(JSON.stringify(res)).not.toContain("PF and ESI");
  });

  it("claims the session BEFORE creating, so a double-click cannot create two postings", async () => {
    const order: string[] = [];
    d.chat.claimForPublish.mockImplementation(async () => {
      order.push("claim");
      return publishable.session;
    });
    d.jobPostings.createForPayer.mockImplementation(async () => {
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
    expect(race.jobPostings.createForPayer).not.toHaveBeenCalled();
  });

  it("an already-published session is a 409, not a second posting", async () => {
    const done = make({
      session: { ...publishable.session, status: "published", publishedJobPostingId: POSTING },
    });
    await expect(done.svc.publish(PAYER_A, SESSION, CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(done.chat.claimForPublish).not.toHaveBeenCalled();
    expect(done.jobPostings.createForPayer).not.toHaveBeenCalled();
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
    expect(partial.jobPostings.createForPayer).not.toHaveBeenCalled();
  });

  it("rejects publishing a session that has collected nothing yet", async () => {
    const empty = make({ session: { ...publishable.session, draft: null } });
    await expect(empty.svc.publish(PAYER_A, SESSION, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(empty.jobPostings.createForPayer).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED rather than posting under a blank employer when the org name cannot be resolved", async () => {
    for (const opts of [
      { ...publishable, decryptThrows: true },
      { ...publishable, orgName: "   " },
      { ...publishable, payerRow: undefined },
    ]) {
      const broken = make(opts);
      await expect(broken.svc.publish(PAYER_A, SESSION, CTX)).rejects.toThrow();
      expect(broken.jobPostings.createForPayer).not.toHaveBeenCalled();
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
      "Pune", // draft location_label
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
    expect(keys(res)).toEqual(["job_posting_id", "session_id", "status", "unmapped_fields"]);
  });
});
