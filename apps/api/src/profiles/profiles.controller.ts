import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { ProfilesService } from "./profiles.service";
import { AiJobsRepository } from "./ai-jobs.repository";
import type { AiJobResponse } from "./ai-jobs.dto";
import {
  ExtractProfileSchema,
  ConfirmProfileSchema,
  type ExtractProfileDto,
  type ConfirmProfileDto,
} from "./profiles.dto";

/**
 * Profile extraction/confirmation (worker AI path). Worker-authenticated +
 * consent-gated (CLAUDE.md §2 invariants 4/6): the worker comes from the bearer
 * token via @CurrentWorker — never from the body.
 */
@Controller("profile")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly aiJobs: AiJobsRepository,
  ) {}

  /**
   * Poll the CALLER'S OWN async AI job (profile extraction / voice transcription).
   *
   * WHY THIS EXISTS: `GET /ai-jobs/:id` on {@link AiJobsController} is
   * ops-only (`InternalServiceGuard`), which a public client must never carry the
   * token for. The worker app legitimately polls its extraction/transcription job
   * to completion, so it needs an OWNER-SCOPED read: the job is served only when
   * `ai_jobs.input_ref->>'worker_id'` equals the bearer's worker. A non-owner — or
   * an unknown id — gets a 404, never a distinguishable 403, so this is not an
   * existence/ownership oracle. Read-only, PII-free (refs + AI usage only), so it
   * emits no event. Job-type-agnostic: any ai_job the worker owns is pollable here.
   */
  @Get("ai-jobs/:id")
  async ownAiJob(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<AiJobResponse> {
    const job = await this.aiJobs.findById(id);
    const ownerId = (job?.inputRef as { worker_id?: string } | undefined)?.worker_id;
    if (!job || ownerId !== worker.id) {
      throw new NotFoundException(`AI job ${id} not found`);
    }
    return {
      id: job.id,
      job_type: job.jobType,
      status: job.status,
      output_ref: job.outputRef as AiJobResponse["output_ref"],
      error_message: job.errorMessage ?? null,
      ai_usage: {
        model_name: job.modelName ?? null,
        real_call: job.realCall ?? null,
        input_tokens: job.inputTokens ?? null,
        output_tokens: job.outputTokens ?? null,
        total_tokens: job.totalTokens ?? null,
        cost_inr: job.costInr ?? null,
      },
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    };
  }

  // Async: enqueues a BullMQ extraction job and returns 202 + ai_job_id. The
  // client polls GET /profile/ai-jobs/:id until completed, then reads
  // output_ref.profile_id.
  @Post("extract")
  @HttpCode(202)
  extract(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ExtractProfileSchema)) dto: ExtractProfileDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.profiles.extract(
      { worker_id: worker.id, session_id: dto.session_id ?? null },
      ctx,
    );
  }

  @Post("confirm")
  @HttpCode(200)
  confirm(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ConfirmProfileSchema)) dto: ConfirmProfileDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.profiles.confirm({ worker_id: worker.id, profile_id: dto.profile_id }, ctx);
  }
}
