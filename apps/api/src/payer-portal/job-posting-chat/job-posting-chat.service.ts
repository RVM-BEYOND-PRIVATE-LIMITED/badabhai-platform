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
  type JobPostingChatTurnOutput,
  type JobPostingDraft,
} from "@badabhai/ai-contracts";
import type { PayerJobPostingChatSession, PayerJobPostingChatStatus } from "@badabhai/db";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { AiService } from "../../ai/ai.service";
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiTraceRecorder } from "../../ai/ai-trace-recorder.service";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { PayersRepository } from "../../payers/payers.repository";
import { JobPostingsService } from "../../job-postings/job-postings.service";
import {
  PayerCreateJobPostingSchema,
  type PayerCreateJobPostingDto,
} from "../../job-postings/job-postings.dto";
import {
  JOB_POSTING_CHAT_LIVE_STATUSES,
  JobPostingChatRepository,
} from "./job-posting-chat.repository";
import {
  JobPostingChatMessagesResponseSchema,
  JobPostingChatSessionsResponseSchema,
  JobPostingChatTurnResponseSchema,
  PublishJobPostingChatResponseSchema,
  UNMAPPED_DRAFT_FIELDS,
  WORKER_CARD_FIELDS,
  type JobPostingChatMessagesResponse,
  type JobPostingChatSessionsResponse,
  type JobPostingChatTurnResponse,
  type PostJobPostingChatMessageDto,
  type PublishJobPostingChatResponse,
  type UnmappedDraftField,
  type WorkerCardField,
} from "./job-posting-chat.dto";
import {
  blankRefusedFields,
  reaskRefusedFields,
  refusedDraftFields,
  refusedNames,
  restoreWrapUpTarget,
  WRAP_UP_TOPIC,
  type ReaskTurn,
} from "./job-posting-chat.screen";

/**
 * Marker kept on the RAW `conversation_state` jsonb (never inside the typed state):
 * `JobPostingChatStateSchema` is a non-strict `z.object`, so parsing STRIPS this key
 * and the interview engine never sees it. Same trick, same reason, as the worker
 * chat's `extraction_ready_emitted`.
 */
const DRAFT_READY_EMITTED = "draft_ready_emitted";

/**
 * The 409 for a turn on a session that is no longer live. ONE message whether the session
 * was already closed when the turn arrived or was published while the engine was answering
 * (#1922), so a client handles both the same way.
 */
const SESSION_CLOSED_MESSAGE = "This conversation is closed";

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
    private readonly aiCost: AiCostRecorder,
    // 0083 — wired at the same call site as `aiCost` below, where every trace is DROPPED by
    // design: a payer composing a posting has no worker to attribute it to.
    private readonly aiTraces: AiTraceRecorder,
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
    // BL-19: `null` trade hint is unchanged; the ctx is the request's own pair, so the opener
    // call lands under the same trace as the session it opens.
    const openingText = await this.ai.jobPostingChatOpening(null, {
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
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
    const priorDraft = this.readDraft(session);
    const priorReadyEmitted = Boolean(
      (session.conversationState as Record<string, unknown> | null)?.[DRAFT_READY_EMITTED],
    );

    // 3. One deterministic engine turn. `payer_ref` is the opaque payer uuid (spend
    //    attribution only — never a name, email, or organisation), and `message_text`
    //    is pseudonymized FAIL-CLOSED on the other side before the engine reads it.
    const aiResult = await this.ai.jobPostingChatRespond(
      {
        session_id: session.id,
        payer_ref: payerId,
        message_text: dto.text,
        conversation_state: priorState,
      },
      // BL-19: the same pair `aiCost.record` below is given, so the spend record and the far
      // side's trace name one id rather than two.
      { correlationId: ctx.correlationId, requestId: ctx.requestId },
    );
    if (!aiResult) {
      // NO LOCAL FALLBACK, deliberately — see `AiService.jobPostingChatRespond`. The
      // payer's message is already stored and the session state is untouched, so a
      // retry resumes exactly here.
      throw new ServiceUnavailableException(
        "The assistant is unavailable right now. Your message was saved — please try again.",
      );
    }

    // COST RECORD FOR THE TURN (#745) — WIRED AHEAD OF THE SPEND, DELIBERATELY.
    //
    // STATE THE HONEST THING FIRST: this route spends nothing today. `/job-posting-chat/
    // respond` makes ZERO LLM calls on every path — the engine's question is already short
    // and on-tone, so it is returned verbatim — and the ai-service therefore returns
    // `ai_metadata: null`, which `record` no-ops on. So this line emits no event today and
    // adds no rows. #745 filed this surface as money-with-no-record; re-measured here, that
    // is not true of it (it IS true of `resume_generation` and `skill_embedding`, both fixed
    // in this change).
    //
    // IT IS STILL THE RIGHT LINE TO WRITE, because the rephrase seam is written and
    // documented in `app/routers/job_posting.py` and turning it on is a two-line change
    // there (register `job_posting_chat_turn` in `model_config.py` + a settings flag).
    // Whoever does that is editing the ai-service, not this file, and would have had no
    // reason to come back here — which is exactly how `stt_transcription` shipped
    // unledgered. The record now appears the moment the seam is armed, with no second
    // change and no second incident.
    //
    // `job_posting_chat_turn`, NOT `profiling_chat_turn`, AND THE DIFFERENCE IS THE WHOLE
    // POINT OF WIRING AHEAD. Those are two different chats: `profiling_chat_turn` is the
    // WORKER profiling loop (`/profiling/respond`), which this app does not call at all.
    // This is the payer job-posting composer. The seam above will register
    // `job_posting_chat_turn` in `model_config.TaskType` and stamp it on the metadata, and
    // `AiCostRecorder` labels the event from THIS argument rather than from the metadata —
    // so naming it `profiling_chat_turn` would have filed payer spend under the worker chat
    // and required a second, invisible fix here on the day the seam went live. Wiring ahead
    // is only worth anything if what is wired is right.
    //
    // `aiJobId` is null: a payer turn is a synchronous reply, not an `ai_jobs` row.
    //
    // NO WORKER AND NO SESSION ATTRIBUTION. `session.id` here is a
    // `payer_job_posting_chat_sessions` row, NOT a `chat_sessions` row — a DIFFERENT table
    // with a different id space — so passing it as `sessionId` would violate the FK on
    // `session_ai_cost_totals` and, worse, could collide with a worker interview's id space if
    // that FK ever went away. The worker is absent for the same reason as the skill-embedding
    // fan-out: this is an employer composing a posting. It still counts in full platform-wide.
    await this.aiCost.record(
      aiResult.ai_metadata ?? null,
      "job_posting_chat_turn",
      null,
      ctx.correlationId,
      ctx.requestId,
    );

    // AND THE TRACE (0083) — DROPPED HERE, BY DESIGN, LIKE THE SKILL-EMBEDDING FAN-OUT.
    //
    // Passing no attribution means `AiTraceRecorder` refuses the row and counts it, because
    // `ai_call_traces.worker_id` is NOT NULL and that cascade IS the DSAR erasure design. The
    // reasoning the cost record above gives for having no worker and no session applies verbatim
    // and is, if anything, stronger here: `session.id` is a `payer_job_posting_chat_sessions`
    // row, a DIFFERENT table in a different id space from `chat_sessions`, so passing it would
    // violate the `ai_call_traces.session_id` FK exactly as it would the cost totals' — and the
    // payer typing a job description is not a worker whose erasure could ever reach this row.
    //
    // WIRED AHEAD OF THE SPEND, for the same reason the cost record is: this route makes zero
    // LLM calls today, and whoever arms the documented rephrase seam is editing Python, not this
    // file. When that lands, this line is already correct — and it will still drop, which is the
    // honest outcome for an employer's composer turn.
    await this.aiTraces.capture(
      aiResult.ai_metadata ?? null,
      "job_posting_chat_turn",
      null,
      ctx.correlationId,
    );

    // 4. Screen the worker-visible free text BEFORE anything is stored (#1911, #1921). A
    //    `role_title` or `description` the shared ADR-0024 screen refuses is dropped (or
    //    replaced by the clean value it held before this turn), and a refused `benefits` /
    //    `requirements` chip is dropped from its list, the clean chips staying. The field is
    //    re-asked with a plain reason, instead of sitting in the draft until publish 400s on
    //    it. From here on `turn` is the turn that is stored and returned.
    const { turn, reask } = this.screenTurn(session.id, aiResult, priorState, priorDraft);

    // 5. Store the reply + put it on the spine. A re-ask records the refused field NAMES on
    //    the row's metadata (never the text), so how often the screen fires is measurable.
    const outbound = await this.chat.insertMessage({
      sessionId: session.id,
      payerId,
      direction: "outbound",
      messageType: "text",
      bodyText: turn.reply_text,
      metadata: {
        is_mock: turn.is_mock,
        blocked: turn.blocked,
        ...(reask ? { refused_fields: reask.refused.map((r) => r.field) } : {}),
      },
    });
    await this.emitMessageSent(session.id, payerId, outbound.id, "ai_service", ctx);

    // 6. Persist the turn. A BLOCKED turn returns null state AND null draft by
    //    contract (nothing was parsed), so it only touches the activity clock —
    //    the stored state and draft must survive a blocked message untouched.
    //
    //    A re-ask is never ready, and it puts a `draft_ready` session back to `active`:
    //    a question is on screen again, so the interview is not over. The once-per-session
    //    `draft_ready` event is unaffected — its marker survives below.
    const now = new Date();
    const becameReady = turn.draft_ready && turn.updated_state != null && !priorReadyEmitted;
    const status: PayerJobPostingChatStatus = reask
      ? "active"
      : turn.draft_ready
        ? "draft_ready"
        : session.status;

    let stored: boolean;
    if (turn.updated_state) {
      const stateToPersist: Record<string, unknown> = {
        ...(turn.updated_state as unknown as Record<string, unknown>),
      };
      // Fast-path marker only. The exactly-once GUARANTEE is the `idempotencyKey` on
      // the emit below (the events table dedupes at insert); if this write is lost and
      // the turn is retried, the event is still emitted once.
      if (turn.draft_ready || priorReadyEmitted) stateToPersist[DRAFT_READY_EMITTED] = true;
      stored = await this.chat.saveTurn(session.id, payerId, {
        conversationState: stateToPersist,
        ...(turn.draft ? { draft: turn.draft as unknown as Record<string, unknown> } : {}),
        status,
        lastMessageAt: now,
      });
    } else {
      stored = await this.chat.saveTurn(session.id, payerId, { lastMessageAt: now });
    }

    // 6b. The session stopped being live while the engine was answering (#1922): in practice
    //     a publish claimed it, and `saveTurn` refused to write over that. The turn's state,
    //     draft and status were not stored, so this is the SAME 409 the turn would have got
    //     had it arrived a moment later, and `draft_ready` is not emitted, because the flip
    //     it announces never landed. The two messages and their `message_sent` events stay:
    //     each names a row that exists.
    if (!stored) {
      this.logger.warn(`session ${session.id} closed mid-turn; turn not stored (#1922)`);
      throw new ConflictException(SESSION_CLOSED_MESSAGE);
    }

    // 7. One readiness signal per session, on the flip.
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

    // 8. Reply. On a blocked turn the AI contract returns a null draft precisely so
    //    the caller keeps what it had — so fall back to the STORED draft rather than
    //    blanking the payer's draft card over one rejected message.
    return this.checked(
      JobPostingChatTurnResponseSchema,
      {
        session_id: session.id,
        status: turn.updated_state ? status : session.status,
        reply_text: turn.reply_text,
        message_id: outbound.id,
        // `suggested_answers` is the AI contract's name for the chips; `suggested_replies`
        // is the API's, and it is what both shipped clients read.
        suggested_replies: turn.suggested_answers,
        blocked: turn.blocked,
        is_mock: turn.is_mock,
        asked_question_id: turn.asked_question_id,
        draft_ready: turn.draft_ready,
        draft: turn.draft ?? priorDraft,
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
        city: draft?.city ?? null,
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
    if (!JOB_POSTING_CHAT_LIVE_STATUSES.includes(session.status)) {
      throw new ConflictException("This conversation can no longer be published");
    }

    const draft = this.readDraft(session);
    if (!draft) {
      throw new BadRequestException({
        message: "There is no usable draft on this conversation yet",
        issues: [{ path: "draft", message: "answer a few more questions first" }],
      });
    }

    // THE WHOLE DRAFT, NOT SIX FIELDS OF IT (#1650). This mapped org_label, role_title,
    // location_label, description, vacancy_band and skills — and reported pay, shift,
    // benefits and requirements back as `unmapped_fields`. The result was that the most
    // GUIDED posting path in the product produced the THINNEST posting: the payer answered
    // every question the interview asked and the worker card still showed no pay band, no
    // shift, no benefits and no requirements. The columns were always there; the create
    // schema was the gap, and #1645/#1646 closed it.
    //
    // EVERY FIELD IS STILL OMITTED WHEN THE DRAFT HAS NONE rather than sent as null. The
    // create DTO's fields are `.optional()`, not `.nullable()`, so a null would be a 400 —
    // and "the payer never answered this" must publish a posting without the field, not a
    // rejected publish. The empty-array guards on `benefits`/`requirements` carry the same
    // meaning: an interview that collected no chips leaves the column NULL (honest
    // absence), it does not store an empty list.
    //
    // NOT SENT, because the interview does not collect it: `area`. (`city`, `pay_type`, the
    // experience window and `needed_by` were in this list until #1726 added their questions.)
    //
    // AND `match_skill_ids`, WHICH IS A RULED SPLIT AND NOT A GAP (#1659, owner ruling
    // 2026-09-22). The chat owns CONTENT; the publish step owns the closed-set skill pick,
    // because a `mskill_*` selection is a form control and not a conversation — offering
    // taxonomy chips mid-interview puts a picker inside a dialogue, and canonicalizing the
    // chat's free-text `skills` into match ids would need a second canonicalizer aimed at a
    // vocabulary the ADR-0030 one does not target, then still have to be confirmed rather
    // than applied (invariant #4).
    //
    // The consequence is deliberate and worth stating plainly: a chat-published posting is
    // a DRAFT that reaches NOBODY until the payer picks skills on the publish step. That is
    // where the picker lives, so the flow is whole — but this path alone never makes a
    // posting live, and any future change that publishes straight from the chat has to
    // solve the skill pick first or it recreates #1645 by a different road.
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
      // #1650 — the five the create path used to have nowhere to put. ONE source, shared
      // with `unmappedFields` below, so the gap report can never claim a field is mapped
      // when this object does not carry it.
      ...JobPostingChatService.contentFieldsFrom(draft),
    };

    const validated = PayerCreateJobPostingSchema.safeParse(candidate);
    if (!validated.success) {
      // Field PATHS + the schema's own static messages only — never the offending
      // value. (`role_title`, `description` and every `benefits` / `requirements` chip
      // carry the worker-visible PII / org-name / link screen (#1823 B3), so the one thing
      // we must not do on that failure is echo the text back through an error body.) Since
      // #1911 and #1921 every turn screens those four fields first and re-asks a refused
      // one, so a draft written by this chat should not reach here with one. This is
      // defence in depth: it still catches a draft stored before then that no later turn
      // has screened.
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

    // A THIN DRAFT STILL PUBLISHES (#1726): `unset_card_fields` REPORTS the card holes, it
    // does not refuse them. The posting is created as a `draft` that reaches no worker until
    // the publish step's skill pick (#1659). Any hole is fillable afterwards through the
    // posting's own PATCH, which accepts every card field — whether a given client's edit form
    // exposes all of them is that client's contract, not something this route can promise. And
    // once the interview has wrapped up the payer cannot answer a missed topic in chat, so a
    // refusal here would strand the session.
    //
    // `role_kind` (migration 0131) is ALWAYS NULL on a chat-published posting: the interview
    // never asks for a role, so `candidate` above never carries one. It is deliberately NOT in
    // `WORKER_CARD_FIELDS` either — it is display / classification only and never on the worker
    // card — so it is the client's gap rule, not this report, that asks the payer to pick one.
    return this.checked(
      PublishJobPostingChatResponseSchema,
      {
        session_id: sessionId,
        job_posting_id: posting.id,
        status: "published" as const,
        unmapped_fields: JobPostingChatService.unmappedFields(draft),
        unset_card_fields: JobPostingChatService.unsetCardFields(dto),
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
    if (!JOB_POSTING_CHAT_LIVE_STATUSES.includes(session.status)) {
      throw new ConflictException(SESSION_CLOSED_MESSAGE);
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
   * #1911 / #1921 — run the shared worker-visible screen on this turn's draft (see
   * `job-posting-chat.screen.ts`). Returns the turn to store and reply with, and the re-ask
   * when the screen refused a value (`null` keeps the engine's turn as it is).
   *
   * A blocked turn carries no draft (nothing was parsed, nothing is stored), so it passes.
   * A draft WITHOUT a state is outside the ai-service contract and is never stored (step 6
   * writes the draft only alongside a state), but it is still returned. Its refused values
   * are nulled and its refused chips removed, so every draft value that leaves this service
   * has met the screen. There is no state to reopen, so nothing is re-asked.
   *
   * A clean wrap-up turn after a list re-ask puts the description back as the topic that
   * takes the next message (`restoreWrapUpTarget`). Every other clean turn is kept as it is.
   *
   * Logs field and screen NAMES only, never the refused text.
   */
  private screenTurn(
    sessionId: string,
    aiResult: JobPostingChatTurnOutput,
    priorState: JobPostingChatState | null,
    priorDraft: JobPostingDraft | null,
  ): { readonly turn: JobPostingChatTurnOutput; readonly reask: ReaskTurn | null } {
    const { draft, updated_state: state } = aiResult;
    if (!draft) return { turn: aiResult, reask: null };

    if (!state) {
      const refused = refusedDraftFields(draft);
      if (refused.length === 0) return { turn: aiResult, reask: null };
      this.logger.warn(
        `session ${sessionId} got a draft without a state; nulled screened draft ` +
          `fields=[${refusedNames(refused)}]`,
      );
      return { turn: { ...aiResult, draft: blankRefusedFields(draft, refused) }, reask: null };
    }

    const reask = reaskRefusedFields({
      draft,
      state,
      priorState,
      priorDraft,
      engineAskedId: aiResult.asked_question_id,
    });
    if (!reask) {
      const settled = restoreWrapUpTarget(state, aiResult.asked_question_id);
      if (settled === state) return { turn: aiResult, reask: null };
      this.logger.log(`session ${sessionId} wrapped up; ${WRAP_UP_TOPIC} takes the next message`);
      return { turn: { ...aiResult, updated_state: settled }, reask: null };
    }
    this.logger.log(
      `session ${sessionId} re-asking screened draft fields=[${refusedNames(reask.refused)}] ` +
        `kept=[${reask.kept.join(",")}]`,
    );
    return {
      reask,
      turn: {
        ...aiResult,
        reply_text: reask.replyText,
        // The engine's chips answered ITS question. The re-ask carries the re-asked topic's
        // own bank options instead (benefits has some; the other three have none).
        suggested_answers: [...reask.chips],
        asked_question_id: reask.askedField,
        draft_ready: false,
        draft: reask.draft,
        updated_state: reask.state,
      },
    };
  }

  /**
   * THE DRAFT'S CONTENT FIELDS, in create-DTO shape — the single source `publish` spreads
   * and `unmappedFields` measures (#1650).
   *
   * OMITTED, NEVER NULL. The create DTO's fields are `.optional()`, not `.nullable()`, so
   * sending `null` for an unanswered question would 400 the publish — and "the payer never
   * told us the shift" must produce a posting without a shift, not a refused publish. The
   * empty-array guards carry the same meaning: an interview that collected no benefit chips
   * leaves the column NULL (honest absence) rather than storing an empty list.
   */
  private static contentFieldsFrom(draft: JobPostingDraft): Record<string, unknown> {
    return {
      // #1726. A blank `city` is omitted too: the create DTO trims and then requires a
      // character, so whitespace would 400 the publish instead of reading as unanswered.
      ...(draft.city !== null && draft.city.trim() ? { city: draft.city } : {}),
      ...(draft.pay_min !== null ? { pay_min: draft.pay_min } : {}),
      ...(draft.pay_max !== null ? { pay_max: draft.pay_max } : {}),
      ...(draft.pay_type !== null ? { pay_type: draft.pay_type } : {}),
      ...(draft.min_experience_years !== null
        ? { min_experience_years: draft.min_experience_years }
        : {}),
      ...(draft.max_experience_years !== null
        ? { max_experience_years: draft.max_experience_years }
        : {}),
      ...(draft.shift !== null ? { shift: draft.shift } : {}),
      ...(draft.needed_by !== null ? { needed_by: draft.needed_by } : {}),
      ...(draft.benefits.length ? { benefits: draft.benefits } : {}),
      ...(draft.requirements.length ? { requirements: draft.requirements } : {}),
    };
  }

  /**
   * Which worker-card columns the created posting holds NULL for (#1726).
   *
   * MEASURED ON THE VALIDATED DTO THE CREATE CALL WAS HANDED — the same "measure what was
   * sent" rule as `unmappedFields` — and `createForPayer` stores `dto[key] ?? null`, so a key
   * is listed exactly when its column is NULL. Facts only; which absences matter is the
   * client's card rule. KEYS only, never values.
   */
  private static unsetCardFields(dto: PayerCreateJobPostingDto): WorkerCardField[] {
    return WORKER_CARD_FIELDS.filter((f) => dto[f] === undefined);
  }

  /**
   * Which collected fields the posting could not store (see `UNMAPPED_DRAFT_FIELDS`).
   *
   * MEASURED AGAINST WHAT `publish` ACTUALLY SENDS, not asserted. A field is unmapped when
   * the draft holds a value for it and `contentFieldsFrom` — the very object the create
   * call is built from — has no key for it. That makes this report incapable of claiming a
   * field made it onto the posting when it did not, which is the failure the old
   * hard-coded list had: it named five fields as unmappable and went on naming them after
   * the columns to hold them existed.
   *
   * It returns [] for every draft today, because all five now map. It is still computed,
   * so a future question-bank topic whose value has no column is REPORTED rather than
   * dropped in silence.
   *
   * KEYS only — the values stay on the session draft and are never echoed.
   */
  private static unmappedFields(draft: JobPostingDraft): UnmappedDraftField[] {
    const sent = JobPostingChatService.contentFieldsFrom(draft);
    const present: Record<UnmappedDraftField, boolean> = {
      pay_min: draft.pay_min !== null,
      pay_max: draft.pay_max !== null,
      shift: draft.shift !== null,
      benefits: draft.benefits.length > 0,
      requirements: draft.requirements.length > 0,
    };
    return UNMAPPED_DRAFT_FIELDS.filter((f) => present[f] && !(f in sent));
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
