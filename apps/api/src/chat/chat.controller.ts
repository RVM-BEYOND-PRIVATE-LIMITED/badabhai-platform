import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { ChatService } from "./chat.service";
import {
  StartSessionSchema,
  PostMessageSchema,
  SessionMessagesParamSchema,
  type StartSessionDto,
  type PostMessageDto,
  type SessionMessagesParamDto,
} from "./chat.dto";

/**
 * Chat profiling (worker AI path). Worker-authenticated + consent-gated
 * (CLAUDE.md §2 invariants 4/6): the worker comes from the bearer token via
 * @CurrentWorker — never from the body — and AI processing is blocked until a
 * DPDP consent row exists. Guard order: WorkerAuthGuard (attaches req.worker)
 * then ConsentGuard (reads it).
 */
@Controller("chat")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post("session")
  @HttpCode(201)
  startSession(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(StartSessionSchema)) _dto: StartSessionDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.chat.startSession(worker.id, ctx);
  }

  @Post("message")
  @HttpCode(201)
  postMessage(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(PostMessageSchema)) dto: PostMessageDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.chat.postMessage(worker.id, dto, ctx);
  }

  /**
   * #349 — transcript hydration. Rehydrates the chat thread the app cannot keep:
   * ChatBloc is a locator FACTORY, so a >5-minute background re-lock drops the
   * in-memory transcript and the worker returns to a blank screen mid-interview.
   * The messages were never lost server-side; this is the read that gives them back.
   *
   * The worker still comes from the bearer token (@CurrentWorker, class-level
   * WorkerAuthGuard + ConsentGuard — inherited, never weakened); ONLY the session id
   * comes from the URL, and the service proves ownership of it before reading a row.
   *
   * READ-ONLY → no event, deliberately. CLAUDE.md §1 binds important STATE CHANGES;
   * nothing changes here, and minting a `chat.transcript_read` per screen re-entry
   * would spam the audit spine without recording a single decision. The omission is
   * a choice, not a missed obligation.
   */
  @Get("sessions/:sessionId/messages")
  listMessages(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param(new ZodValidationPipe(SessionMessagesParamSchema)) params: SessionMessagesParamDto,
  ) {
    return this.chat.listMessages(worker.id, params.sessionId);
  }
}
