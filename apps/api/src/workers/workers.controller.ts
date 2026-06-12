import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from "@nestjs/common";
import { clampLimit } from "../common/pagination";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { WorkersRepository } from "./workers.repository";
import { WorkersService } from "./workers.service";
import { SetWorkerNameSchema, type SetWorkerNameDto } from "./workers.dto";

@Controller("workers")
export class WorkersController {
  constructor(
    private readonly workers: WorkersRepository,
    private readonly workersService: WorkersService,
  ) {}

  /** List workers (newest first) with latest-profile summary. No PII. */
  @Get()
  async list(@Query("limit") limit?: string) {
    return { workers: await this.workers.list(clampLimit(limit)) };
  }

  /** Worker + latest profile + latest generated resume. */
  @Get(":id/profile")
  async getProfile(@Param("id", new ParseUUIDPipe()) id: string) {
    const worker = await this.workers.findById(id);
    if (!worker) throw new NotFoundException(`Worker ${id} not found`);

    const [profile, resume] = await Promise.all([
      this.workers.latestProfile(id),
      this.workers.latestResume(id),
    ]);

    return {
      worker: {
        id: worker.id,
        status: worker.status,
        preferred_language: worker.preferredLanguage,
        // NOTE: full_name/phone are intentionally NOT returned by this endpoint.
        created_at: worker.createdAt,
      },
      profile: profile ?? null,
      resume: resume ?? null,
    };
  }

  /**
   * Record the worker's real name (TD21). The name is PII: it is encrypted at
   * rest and is NEVER returned by this (or any) endpoint — the response carries
   * only `{ worker_id }`. The name later appears only on the worker's own resume.
   */
  @Put(":id/name")
  @HttpCode(200)
  async setName(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(SetWorkerNameSchema)) dto: SetWorkerNameDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.workersService.setFullName(id, dto.full_name, ctx);
  }
}
