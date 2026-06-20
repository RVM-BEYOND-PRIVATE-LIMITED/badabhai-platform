import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ResumeService } from "./resume.service";
import {
  GenerateResumeSchema,
  ShareResumeSchema,
  type GenerateResumeDto,
  type ShareResumeDto,
} from "./resume.dto";

/**
 * Thin HTTP layer (HTTP concerns only): guards, validation, the per-IP rate-limit
 * backstop, and delegation. All business logic + event emission live in
 * {@link ResumeService}.
 */
@Controller("resume")
export class ResumeController {
  constructor(
    private readonly resume: ResumeService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Post("generate")
  @HttpCode(201)
  generate(
    @Body(new ZodValidationPipe(GenerateResumeSchema)) dto: GenerateResumeDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.resume.generate(dto, ctx);
  }

  /** Read a single generated resume by id (ops read view). */
  @Get(":id")
  @UseGuards(InternalServiceGuard)
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.resume.getById(id);
  }

  /** Re-run generation for an existing resume (e.g. the profile grew). */
  @Post(":id/regenerate")
  @HttpCode(201)
  @UseGuards(InternalServiceGuard)
  regenerate(@Param("id", new ParseUUIDPipe()) id: string, @Ctx() ctx: RequestContext) {
    return this.resume.regenerate(id, ctx);
  }

  /**
   * Mint a short-lived signed download URL for a rendered resume PDF. Worker-
   * authenticated + ownership-checked in the service (404 for not-found/not-owner,
   * no existence oracle). The per-IP hourly cap (TD24) is an HTTP-layer abuse
   * backstop on top of the per-worker day cap.
   */
  @Get(":id/download")
  @UseGuards(WorkerAuthGuard)
  async download(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentWorker() worker: AuthenticatedWorker,
    @Ip() ip: string,
    @Ctx() ctx: RequestContext,
  ) {
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "resume_download",
      ip,
      this.config.RESUME_RATE_LIMIT_PER_IP_PER_HOUR,
    );
    return this.resume.download(worker.id, id, ctx);
  }

  /** Record that a worker shared a resume (PII-free, closed-enum channel). */
  @Post(":id/share")
  @HttpCode(201)
  @UseGuards(InternalServiceGuard)
  share(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ShareResumeSchema)) dto: ShareResumeDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.resume.recordShare(id, dto, ctx);
  }
}
