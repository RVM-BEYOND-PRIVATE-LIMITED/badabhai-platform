import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ZodTypeAny } from "zod";
import {
  JobPostingChatStateSchema,
  JobPostingDraftSchema,
  type JobPostingChatState,
  type JobPostingDraft,
} from "@badabhai/ai-contracts";
import type { PayerJobPostingChatSession, PayerJobPostingChatStatus } from "@badabhai/db";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { AiService } from "../../ai/ai.service";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { PayersRepository } from "../../payers/payers.repository";
import { JobPostingsService } from "../../job-postings/job-postings.service";
import {
  PayerCreateJobPostingSchema,
  type PayerCreateJobPostingDto,
} from "../../job-postings/job-postings.dto";
import { JobPostingChatRepository } from "./job-posting-chat.repository";
import {
  JobPostingChatMessagesResponseSchema,
  JobPostingChatSessionsResponseSchema,
  JobPostingChatTurnResponseSchema,
  PublishJobPostingChatResponseSchema,
  UNMAPPED_DRAFT_FIELDS,
  type JobPostingChatMessagesResponse,
  type JobPostingChatSessionsResponse,
  type JobPostingChatTurnResponse,
  type PostJobPostingChatMessageDto,
  type PublishJobPostingChatResponse,
  type UnmappedDraftField,
} from "./job-posting-chat.dto";

/**
 * Marker kept on the RAW `conversation_state` jsonb (never inside the typed state):
 * `JobPostingChatStateSchema` is a non-strict `z.object`, so parsing STRIPS this key
 * and the interview engine never sees it. Same trick, same reason, as the worker
 * chat's `extraction_ready_emitted`.
 */
const DRAFT_READY_EMITTED = "draft_ready_emitted";

/** Statuses a session can still be worked on / published from. */
const LIVE_STATUSES: readonly PayerJobPostingChatStatus[] = ["active", "draft_ready"];

/**
 * AI job-posting chat — business logic + events (ADR-0035 §Decision 5).
 *
 * THE ONE-LINE SUMMARY OF WHAT THIS IS: a conversational FRONT DOOR onto the
 * already-shipped job-posting create path. It is not a second way to create a job
 * posting. {@link publish} validates the collected draft against the SAME
 * `PayerCreateJobPostingSchema` the manual form uses and hands it to the SAME
 * `JobPostingsService.createForPayer`, which already emits `job_posting.created` with
 * `actor_type: "payer"` — this service never writes a posting row and never emits that
 * event itself.
 *
 * FOUR THINGS THAT ARE LOAD-BEARING HERE:
 *
 * 1. **The payer is always the session.** Every method takes `payerId` from
 *    `req.payer.id` via the controller; nothing on this surface reads an owner from a
 *    body or a URL (XB-A).
 * 2. **Unknown and not-yours are the same 404.** Every read goes through
 *    `findOwnedSession`, whose predicate includes the owner, so a foreign session id
 *    is indistinguishable from a made-up one. A 403 anywhere here would turn these
 *    routes into an existence oracle for another payer's conversations.
 * 3. **The organisation name is never in the conversation.** It is not asked for, so
 *    it is on no message, in no draft, in no state, and in no event. It is decrypted
 *    from `payers.orgNameEnc` and stamped onto the create call at publish time only
 *    (ADR-0035 §Decision 3 — the AI-PERSONA-2 post-hoc pattern).
 * 4. **Events carry ids and enums.** The payer's typed message, the assistant's reply,
 *    and every draft field VALUE stay out of `events` — the payload schemas are
 *    `.strict()` so this is structural, not a habit.
 */
@Injectable()
export class JobPostingChatService {
  private readonly logger = new Logger(JobPostingChatService.name);

  constructor(
    private readonly chat: JobPostingChatRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
    private readonly payers: PayersRepository,
    private readonly pii: PiiCryptoService,
    private readonly jobPostings: JobPostingsService,
  ) {}

  // -------------------------------------------------------------------------
  // POST /payer/job-posting-chat/session
  // -------------------------------------------------------------------------
  /**
   * Open a new conversation for the authenticated payer.
   *
   * The opener IS STORED as the first assistant message — the opposite of the worker
   * chat, which deliberately does not store its opener. The reason the worker chat
   * withholds it does not exist here: there, stored messages feed the profile
   * EXTRACTION transcript, so an opener naming example values hands the worker skills
   * they never claimed. This engine never reads the transcript (it carries its own
   * `conversation_state` and receives only the current message), so storing the opener
   * cannot contaminate anything — and NOT storing it would break the headline feature,
   * because a payer resuming on another device would hydrate an empty thread that
   * starts mid-answer.
   */
  async startSession(payerId: string, ctx: RequestContext): Promise<JobPostingChatTurnResponse> {
    const session = await this.chat.createSession(payerId);
    await this.events.emit({
      event_name: "job_posting_chat.session_started",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "payer_job_posting_chat_session", subject_id: session.id },
      payload: { session_id: session.id, payer_id: payerId },
      idempotencyKey: `job_posting_chat.session_started:${session.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // `null` = the AI service could not supply the opener. Return an EMPTY reply rather
    // than a locally invented greeting: a fallback string here would be a second copy of
    // the opener copy, free to drift from the AI service's. The clients test for empty
    // and render their own constant. Nothing is stored in that case either — a message
    // row with no text would hydrate as a blank bubble on the next device.
    const openingText = await this.ai.jobPostingChatOpening();
    const opener =
      openingText === null
        ? null
        : await this.chat.insertMessage({
            sessionId: session.id,
            payerId,
            direction: "outbound",
            messageType: "text",
            bodyText: openingText,
            metadata: { is_mock: true, blocked: false, opening: true },
          });
    if (opener) await this.emitMessageSent(session.id, payerId, opener.id, "ai_service", ctx);

    return this.checked(
      JobPostingChatTurnResponseSchema,
      {
        session_id: session.id,
        status: session.status,
        started_at: session.startedAt.toISOString(),
        reply_text: openingText ?? "",
        message_id: opener?.id ?? null,
        suggested_replies: [],
        blocked: false,
        is_mock: true,
        asked_question_id: null,
        draft_ready: false,
        draft: null,
      },
      session.id,
    );
  }

  // -------------------------------------------------------------------------
  // POST /payer/job-posting-chat/message
  // -------------------------------------------------------------------------
  async postMessage(
    payerId: string,
    dto: PostJobPostingChatMessageDto,
    ctx: RequestContext,
  ): Promise<JobPostingChatTurnResponse> {
    const session = await this.requireLiveSession(dto.session_id, payerId);

    // 1. Store the payer's turn and put it on the spine FIRST, before anything that
    //    can fail. If the AI service is down the message is still recorded, so the
    //    conversation resumes rather than losing what they typed.
    const inbound = await this.chat.insertMessage({
      sessionId: session.id,
      payerId,
      direction: "inbound",
      messageType: "text",
      bodyText: dto.text,
    });
    await this.emitMessageSent(session.id, payerId, inbound.id, "payer", ctx);

    // 2. Re-validate the persisted interview state at the boundary. A malformed or
    //    stale jsonb row degrades to a FRESH interview rather than throwing — losing
    //    progress is recoverable, a 500 mid-conversation is not.
    const loaded = JobPostingChatStateSchema.nullable().safeParse(
      session.conversationState ?? null,
    );
    if (!loaded.success) {
      this.logger.warn(
        `session ${session.id} had an invalid conversation_state; restarting the interview`,
      );
    }
    const priorState: JobPostingChatState | null = loaded.success ? loaded.data : null;
    const priorReadyEmitted = Boolean(
      (session.conversationState as Record<string, unknown> | null)?.[DRAFT_READY_EMITTED],
    );

    // 3. One deterministic engine turn. `payer_ref` is the opaque payer uuid (spend
    //    attribution only — never a name, email, or organisation), and `message_text`
    //    is pseudonymized FAIL-CLOSED on the other side before the engine reads it.
    const aiResult = await this.ai.jobPostingChatRespond({
      session_id: session.id,
      payer_ref: payerId,
      message_text: dto.text,
      conversation_state: priorState,
    });
    if (!aiResult) {
      // NO LOCAL FALLBACK, deliberately — see `AiService.jobPostingChatRespond`. The
      // payer's message is already stored and the session state is untouched, so a
      // retry resumes exactly here.
      throw new ServiceUnavailableException(
        "The assistant is unavailable right now. Your message was saved — please try again.",
      );
    }

    // 4. Store the engine's reply + put it on the spine.
    const outbound = await this.chat.insertMessage({
      sessionId: session.id,
      payerId,
      direction: "outbound",
      messageType: "text",
      bodyText: aiResult.reply_text,
      metadata: { is_mock: aiResult.is_mock, blocked: aiResult.blocked },
    });
    await this.emitMessageSent(session.id, payerId, outbound.id, "ai_service", ctx);

    // 5. Persist the turn. A BLOCKED turn returns null state AND null draft by
    //    contract (nothing was parsed), so it only touches the activity clock —
    //    the stored state and draft must survive a blocked message untouched.
    const now = new Date();
    const becameReady =
      aiResult.draft_ready && aiResult.updated_state != null && !priorReadyEmitted;
    const status: PayerJobPostingChatStatus = aiResult.draft_ready ? "draft_ready" : session.status;

    if (aiResult.updated_state) {
      const stateToPersist: Record<string, unknown> = {
        ...(aiResult.updated_state as unknown as Record<string, unknown>),
      };
      // Fast-path marker only. The exactly-once GUARANTEE is the `idempotencyKey` on
      // the emit below (the events table dedupes at insert); if this write is lost and
      // the turn is retried, the event is still emitted once.
      if (aiResult.draft_ready || priorReadyEmitted) stateToPersist[DRAFT_READY_EMITTED] = true;
      await this.chat.saveTurn(session.id, payerId, {
        conversationState: stateToPersist,
        ...(aiResult.draft ? { draft: aiResult.draft as unknown as Record<string, unknown> } : {}),
        status,
        lastMessageAt: now,
      });
    } else {
      await this.chat.saveTurn(session.id, payerId, { lastMessageAt: now });
    }

    // 6. One readiness signal per session, on the flip.
    if (becameReady) {
      await this.events.emit({
        event_name: "job_posting_chat.draft_ready",
        actor: { actor_type: "payer", actor_id: payerId },
        subject: { subject_type: "payer_job_posting_chat_session", subject_id: session.id },
        payload: { session_id: session.id, payer_id: payerId },
        idempotencyKey: `job_posting_chat.draft_ready:${session.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

    // 7. Reply. On a blocked turn the AI contract returns a null draft precisely so
    //    the caller keeps what it had — so fall back to the STORED draft rather than
    //    blanking the payer's draft card over one rejected message.
    return this.checked(
      JobPostingChatTurnResponseSchema,
      {
        session_id: session.id,
        status: aiResult.updated_state ? status : session.status,
        reply_text: aiResult.reply_text,
        message_id: outbound.id,
        // `suggested_answers` is the AI contract's name for the chips; `suggested_replies`
        // is the API's, and it is what both shipped clients read.
        suggested_replies: aiResult.suggested_answers,
        blocked: aiResult.blocked,
        is_mock: aiResult.is_mock,
        asked_question_id: aiResult.asked_question_id,
        draft_ready: aiResult.draft_ready,
        draft: aiResult.draft ?? this.readDraft(session),
      },
      session.id,
    );
  }

  // -------------------------------------------------------------------------
  // GET /payer/job-posting-chat/sessions
  // -------------------------------------------------------------------------
  /**
   * The cross-device "continue where I left off" entry point.
   *
   * Cross-device resume needs no new mechanism and gets none: the list is keyed to the
   * authenticated PAYER ACCOUNT, not to a device or a browser session, so every device
   * the payer is logged into sees the same conversations.
   *
   * READ-ONLY → NO EVENT, deliberately. §1 binds important STATE CHANGES; minting an
   * event every time a dashboard mounts would spam the audit spine without recording a
   * decision.
   */
  async listSessions(payerId: string): Promise<JobPostingChatSessionsResponse> {
    const rows = await this.chat.listSessions(payerId);
    const sessions = rows.map((row) => {
      const draft = this.readDraft(row);
      return {
        session_id: row.id,
        status: row.status,
        draft_ready: row.status === "draft_ready",
        role_title: draft?.role_title ?? null,
        location_label: draft?.location_label ?? null,
        vacancy_band: draft?.vacancy_band ?? null,
        started_at: row.startedAt.toISOString(),
        last_message_at: row.lastMessageAt?.toISOString() ?? null,
        published_job_posting_id: row.publishedJobPostingId,
      };
    });
    return this.checked(JobPostingChatSessionsResponseSchema, { sessions }, "-");
  }

  // -------------------------------------------------------------------------
  // GET /payer/job-posting-chat/sessions/:id/messages
  // -------------------------------------------------------------------------
  /**
   * Hydrate one conversation. The session id arrives in the URL and is therefore
   * attacker-controlled; `findOwnedSession` proves ownership in the same predicate
   * that finds the row, so "no such session" and "not yours" produce the SAME neutral
   * 404 (the no-oracle rule the worker chat's transcript endpoint set).
   *
   * Read-only → no event, for the same reason as {@link listSessions}.
   */
  async listMessages(payerId: string, sessionId: string): Promise<JobPostingChatMessagesResponse> {
    const session = await this.requireOwnedSession(sessionId, payerId);
    const rows = await this.chat.listMessages(sessionId);

    return this.checked(
      JobPostingChatMessagesResponseSchema,
      {
        session_id: session.id,
        status: session.status,
        draft_ready: session.status === "draft_ready",
        draft: this.readDraft(session),
        published_job_posting_id: session.publishedJobPostingId,
        // Mapped FIELD-BY-FIELD, never spread: the row also carries payer_id and a
        // metadata jsonb, neither of which a client needs to redraw bubbles. Spreading
        // would silently publish any future column.
        messages: rows.map((row) => ({
          id: row.id,
          message_type: row.messageType,
          direction: row.direction,
          body_text: row.bodyText,
          created_at: row.createdAt.toISOString(),
        })),
      },
      sessionId,
    );
  }

  // -------------------------------------------------------------------------
  // POST /payer/job-posting-chat/sessions/:id/publish
  // -------------------------------------------------------------------------
  /**
   * Turn the collected draft into a real job posting — by CALLING THE EXISTING PATH,
   * not by reimplementing it.
   *
   * ORDER OF OPERATIONS, and each step is there for a reason:
   *  1. Own the session (no-oracle 404) and refuse a terminal one (409).
   *  2. Re-read the draft from jsonb through `JobPostingDraftSchema` — a stored draft
   *     is untrusted input like any other row.
   *  3. Stamp `org_label` from `payers.orgNameEnc`. It could not have come from the
   *     chat, because the chat never asks for it.
   *  4. Validate against `PayerCreateJobPostingSchema`. THIS is the publish gate, not
   *     the engine's `draft_ready` flag — invariant #4 says the engine assists and does
   *     not decide, so a session may be published from `active` if the fields are
   *     genuinely there, and a `draft_ready` session is still rejected if they are not.
   *  5. CLAIM the session, then create, then bind (see `claimForPublish` for why the
   *     claim precedes the create).
   *
   * NO EVENT IS EMITTED HERE. `createForPayer` already emits `job_posting.created` with
   * `actor_type: "payer"`; a second emit from this slice would double-count postings on
   * the spine.
   */
  async publish(
    payerId: string,
    sessionId: string,
    ctx: RequestContext,
  ): Promise<PublishJobPostingChatResponse> {
    const session = await this.requireOwnedSession(sessionId, payerId);
    if (session.status === "published") {
      throw new ConflictException("This conversation has already been published");
    }
    if (!LIVE_STATUSES.includes(session.status)) {
      throw new ConflictException("This conversation can no longer be published");
    }

    const draft = this.readDraft(session);
    if (!draft) {
      throw new BadRequestException({
        message: "There is no usable draft on this conversation yet",
        issues: [{ path: "draft", message: "answer a few more questions first" }],
      });
    }

    const candidate = {
      org_label: await this.resolveOrgLabel(payerId),
      role_title: draft.role_title ?? undefined,
      ...(draft.location_label ? { location_label: draft.location_label } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      // ALWAYS the band, NEVER the raw count (ADR-0012). The interview bands the
      // payer's answer locally and discards the integer, so there is no `vacancies`
      // value here to send even if the schema would accept one.
      ...(draft.vacancy_band ? { vacancy_band: draft.vacancy_band } : {}),
      ...(draft.skills.length ? { skills: draft.skills } : {}),
    };

    const validated = PayerCreateJobPostingSchema.safeParse(candidate);
    if (!validated.success) {
      // Field PATHS + the schema's own static messages only — never the offending
      // value. (`description` carries a `looksLikePii` refine, so the one thing we
      // must not do on that failure is echo the text back through an error body.)
      const issues = validated.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      }));
      this.logger.warn(
        `publish rejected session=${sessionId} paths=[${issues.map((i) => i.path).join(",")}]`,
      );
      throw new BadRequestException({ message: "This draft is not ready to publish", issues });
    }
    const dto: PayerCreateJobPostingDto = validated.data;

    const claimed = await this.chat.claimForPublish(sessionId, payerId, new Date());
    if (!claimed) {
      // Lost the race with a concurrent publish — and, because the claim runs before
      // the create, this request has created nothing.
      throw new ConflictException("This conversation has already been published");
    }

    let posting: { id: string };
    try {
      posting = await this.jobPostings.createForPayer(payerId, dto, ctx);
    } catch (err) {
      // Give the session back so the payer can fix the draft and try again. Guarded on
      // "no posting bound", so it can never un-publish a session that really produced
      // one. Best-effort: a failure here must not mask the original error.
      await this.chat
        .releasePublishClaim(sessionId, payerId, session.status)
        .catch(() =>
          this.logger.error(
            `publish claim release FAILED session=${sessionId}; it is stuck in 'published' with no posting`,
          ),
        );
      throw err;
    }
    await this.chat.bindPublishedPosting(sessionId, payerId, posting.id);

    return this.checked(
      PublishJobPostingChatResponseSchema,
      {
        session_id: sessionId,
        job_posting_id: posting.id,
        status: "published" as const,
        unmapped_fields: JobPostingChatService.unmappedFields(draft),
      },
      sessionId,
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The ONE ownership chokepoint. Unknown id and foreign id both land here as
   * `undefined` and both raise the SAME message — there is no branch that could
   * accidentally distinguish them.
   */
  private async requireOwnedSession(
    sessionId: string,
    payerId: string,
  ): Promise<PayerJobPostingChatSession> {
    const session = await this.chat.findOwnedSession(sessionId, payerId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }

  /** Owned AND still open for turns. Published/abandoned sessions are terminal. */
  private async requireLiveSession(
    sessionId: string,
    payerId: string,
  ): Promise<PayerJobPostingChatSession> {
    const session = await this.requireOwnedSession(sessionId, payerId);
    if (!LIVE_STATUSES.includes(session.status)) {
      throw new ConflictException("This conversation is closed");
    }
    return session;
  }

  /**
   * The payer's own organisation name, decrypted for THIS request only.
   *
   * Decrypts the ONE field it needs rather than reusing `decryptContact`, which would
   * also bring the payer's email and phone into memory for a call that has no use for
   * either — least privilege on a PII read. The value is passed straight into the
   * create DTO and is never logged, evented, stored on the session, or sent to the AI
   * service.
   *
   * FAILS CLOSED: a missing row, an undecryptable token (rotated key), or an empty
   * name raises rather than publishing a posting under a blank or fabricated employer.
   */
  private async resolveOrgLabel(payerId: string): Promise<string> {
    const row = await this.payers.findById(payerId);
    if (!row) {
      throw new InternalServerErrorException("Could not resolve your organisation details");
    }
    let orgName = "";
    try {
      orgName = this.pii.decrypt(row.orgNameEnc).trim();
    } catch {
      // Never log the token or the error body — both can carry ciphertext.
      this.logger.error(`could not decrypt org name for payer ${payerId}; publish blocked`);
      throw new InternalServerErrorException("Could not resolve your organisation details");
    }
    if (!orgName) {
      throw new InternalServerErrorException("Could not resolve your organisation details");
    }
    return orgName;
  }

  /**
   * Re-read the stored draft through its schema. A jsonb column is untrusted input:
   * a malformed row yields `null` (the caller degrades) rather than a 500.
   */
  private readDraft(session: PayerJobPostingChatSession): JobPostingDraft | null {
    if (!session.draft) return null;
    const parsed = JobPostingDraftSchema.safeParse(session.draft);
    if (!parsed.success) {
      this.logger.warn(
        `session ${session.id} had an invalid draft; paths=[` +
          `${parsed.error.issues.map((i) => i.path.join(".")).join(",")}]`,
      );
      return null;
    }
    return parsed.data;
  }

  /**
   * Which collected fields the posting cannot store (see `UNMAPPED_DRAFT_FIELDS`).
   * KEYS only — the values stay on the session draft and are never echoed.
   */
  private static unmappedFields(draft: JobPostingDraft): UnmappedDraftField[] {
    const present: Record<UnmappedDraftField, boolean> = {
      pay_min: draft.pay_min !== null,
      pay_max: draft.pay_max !== null,
      shift: draft.shift !== null,
      benefits: draft.benefits.length > 0,
      requirements: draft.requirements.length > 0,
    };
    return UNMAPPED_DRAFT_FIELDS.filter((f) => present[f]);
  }

  /**
   * `job_posting_chat.message_sent` for one stored message.
   *
   * ONE event name covers both directions (the ADR freezes three events for this
   * domain); the ACTOR is the discriminator — `payer` for a payer turn, `ai_service`
   * for the engine's reply. `body_text` is NOT a parameter of this method, which is
   * the point: there is no code path here that could pass it.
   */
  private async emitMessageSent(
    sessionId: string,
    payerId: string,
    messageId: string,
    actorType: "payer" | "ai_service",
    ctx: RequestContext,
  ): Promise<void> {
    await this.events.emit({
      event_name: "job_posting_chat.message_sent",
      actor:
        actorType === "payer"
          ? { actor_type: "payer", actor_id: payerId }
          : { actor_type: "ai_service" },
      subject: { subject_type: "payer_job_posting_chat_message", subject_id: messageId },
      payload: {
        session_id: sessionId,
        payer_id: payerId,
        message_id: messageId,
        message_type: "text",
      },
      // One event per stored message row; a full-turn HTTP retry inserts a new row and
      // therefore is a genuinely new event, exactly as the worker chat behaves.
      idempotencyKey: `job_posting_chat.message_sent:${messageId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  /**
   * Outbound boundary check. Every response above is built FIELD-BY-FIELD (never
   * spread from a row), so this guards the VALUES, not the key set. On failure it logs
   * field PATHS only — response bodies here carry the payer's own draft text — and
   * returns the constructed object anyway: an outbound validation slip must never 500
   * a live conversation.
   */
  private checked<T>(schema: ZodTypeAny, value: T, sessionId: string): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      this.logger.warn(
        `outbound validation failed session=${sessionId} ` +
          `paths=[${result.error.issues.map((i) => i.path.join(".")).join(",")}]`,
      );
    }
    return value;
  }
}
