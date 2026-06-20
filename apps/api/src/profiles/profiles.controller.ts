import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { ProfilesService } from "./profiles.service";
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
  constructor(private readonly profiles: ProfilesService) {}

  // Async: enqueues a BullMQ extraction job and returns 202 + ai_job_id. The
  // client polls GET /ai-jobs/:id until completed, then reads output_ref.profile_id.
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
