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
import { ExtractedCorrectionsService } from "./extracted-corrections.service";
import { CorrectExtractedSchema, type CorrectExtractedDto } from "./extracted-corrections.dto";
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
    private readonly corrections: ExtractedCorrectionsService,
  ) {}

  // Async: enqueues a BullMQ extraction job and returns 202 + ai_job_id. The
  // client polls GET /ai-jobs/:id until completed, then reads output_ref.profile_id.
  @Post("extract")
  @HttpCode(202)
  extract(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ExtractProfileSchema)) dto: ExtractProfileDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.profiles.extract({ worker_id: worker.id, session_id: dto.session_id ?? null }, ctx);
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

  /**
   * Correct extracted fields on the worker's own profile (#1311 backend half).
   *
   * The contract lives in `extracted-corrections.contract.ts`: five correctable fields,
   * each to its existing structured writer, capped per profile, evented per correction
   * (`resume.edited`), anchored to a pinned interview session. The response carries
   * counts, never the corrected values. The Rishi screen half calls this route once the
   * backend contract lands — until then it has no client.
   */
  @Post("corrections")
  @HttpCode(200)
  correctExtracted(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(CorrectExtractedSchema)) dto: CorrectExtractedDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.corrections.correctExtracted(
      {
        worker_id: worker.id,
        profile_id: dto.profile_id,
        session_id: dto.session_id,
        corrections: dto.corrections,
      },
      ctx,
    );
  }
}
