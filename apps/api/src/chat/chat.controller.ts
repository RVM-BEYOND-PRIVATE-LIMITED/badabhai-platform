import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
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
  type StartSessionDto,
  type PostMessageDto,
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
}
