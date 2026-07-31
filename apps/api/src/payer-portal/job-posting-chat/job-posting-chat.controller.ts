import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  PayerAuthGuard,
  CurrentPayer,
  type AuthenticatedPayer,
} from "../../payers/payer-auth.guard";
import { JobPostingChatService } from "./job-posting-chat.service";
import {
  StartJobPostingChatSchema,
  PostJobPostingChatMessageSchema,
  JobPostingChatSessionParamSchema,
  PublishJobPostingChatSchema,
  type StartJobPostingChatDto,
  type PostJobPostingChatMessageDto,
  type JobPostingChatSessionParamDto,
  type PublishJobPostingChatDto,
} from "./job-posting-chat.dto";

/**
 * AI job-posting chat (ADR-0035) — the payer's conversational route to a job posting.
 *
 * THIN BY CONTRACT: this class does HTTP and nothing else. Every route hands
 * `payer.id` — the VERIFIED SESSION payer from {@link PayerAuthGuard}, never a body or
 * URL value (XB-A) — plus the parsed DTO to {@link JobPostingChatService}. No data
 * access, no ownership decisions, no events live here.
 *
 * A new route group under `/payer/job-posting-chat`, a sibling of
 * {@link import("../payer-job-postings.controller").PayerJobPostingsController} and
 * class-guarded exactly like it. It is an INPUT SURFACE, not a second job-creation
 * path: `publish` calls the same `JobPostingsService.createForPayer` the manual form
 * uses, which already emits `job_posting.created`.
 *
 * Every `:id` route returns the SAME neutral 404 for an unknown session and for
 * another payer's session, so none of them can be used to probe for valid ids.
 */
@Controller("payer/job-posting-chat")
@UseGuards(PayerAuthGuard)
export class JobPostingChatController {
  constructor(private readonly chat: JobPostingChatService) {}

  /** Start a conversation owned by the caller. Nothing is read from the body. */
  @Post("session")
  @HttpCode(201)
  startSession(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Body(new ZodValidationPipe(StartJobPostingChatSchema)) _dto: StartJobPostingChatDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.chat.startSession(payer.id, ctx);
  }

  /** Send one payer turn; get the engine's reply + the updated draft back. */
  @Post("message")
  @HttpCode(201)
  postMessage(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Body(new ZodValidationPipe(PostJobPostingChatMessageSchema))
    dto: PostJobPostingChatMessageDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.chat.postMessage(payer.id, dto, ctx);
  }

  /**
   * The caller's own conversations, most recently active first — the CROSS-DEVICE
   * "continue where I left off" entry point both payer-web and the payer app call on
   * load. Resume works because the list is keyed to the payer ACCOUNT, not to the
   * device or browser session that started the conversation.
   */
  @Get("sessions")
  listSessions(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.chat.listSessions(payer.id);
  }

  /**
   * Hydrate one conversation's transcript (plus its status and current draft) so a
   * second device can redraw the whole surface, not just the bubbles.
   *
   * The id comes from the URL and is attacker-controlled; the service proves ownership
   * before reading a row, and a miss is a 404 — never a 403, which would confirm the
   * id exists and turn this into an existence oracle for another payer's conversation.
   */
  @Get("sessions/:id/messages")
  listMessages(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Param(new ZodValidationPipe(JobPostingChatSessionParamSchema))
    params: JobPostingChatSessionParamDto,
  ) {
    return this.chat.listMessages(payer.id, params.id);
  }

  /**
   * Publish the collected draft as a real job posting. 201 — a row is created (by the
   * existing `createForPayer`, which owns the `job_posting.created` event).
   */
  @Post("sessions/:id/publish")
  @HttpCode(201)
  publish(
    @CurrentPayer() payer: AuthenticatedPayer,
    @Param(new ZodValidationPipe(JobPostingChatSessionParamSchema))
    params: JobPostingChatSessionParamDto,
    @Body(new ZodValidationPipe(PublishJobPostingChatSchema)) _dto: PublishJobPostingChatDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.chat.publish(payer.id, params.id, ctx);
  }
}
