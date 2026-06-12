import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { EventsService } from "../events/events.service";
import { StorageService } from "../storage/storage.service";
import { ResumeService } from "./resume.service";
import { ResumeRepository } from "./resume.repository";
import {
  GenerateResumeSchema,
  ShareResumeSchema,
  type GenerateResumeDto,
  type ShareResumeDto,
} from "./resume.dto";

@Controller("resume")
export class ResumeController {
  constructor(
    private readonly resume: ResumeService,
    private readonly resumes: ResumeRepository,
    private readonly events: EventsService,
    private readonly storage: StorageService,
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

  /**
   * Read a single generated resume by id (ops read view).
   * The resume body contains the worker's OWN name by design (TD21) — it is their
   * document. The phone never appears. Exposure is bounded by RLS on generated_resumes
   * (TD20) + no Data-API consumer; closing the endpoint's authz rides the TD4 gap.
   */
  @Get(":id")
  @UseGuards(InternalServiceGuard)
  async get(@Param("id", new ParseUUIDPipe()) id: string) {
    const resume = await this.resumes.findById(id);
    if (!resume) throw new NotFoundException(`Resume ${id} not found`);
    return {
      resume_id: resume.id,
      worker_id: resume.workerId,
      profile_id: resume.profileId,
      version: resume.version,
      resume_text: resume.resumeText,
      resume_json: resume.resumeJson,
      render_status: resume.renderStatus,
      generated_at: resume.generatedAt,
    };
  }

  /**
   * Re-run generation for an existing resume (e.g. the profile grew). Loads the
   * source resume to recover its worker/profile, then calls generate — which emits
   * `resume.regenerated` (version > 1) and re-enqueues a render.
   */
  @Post(":id/regenerate")
  @HttpCode(201)
  @UseGuards(InternalServiceGuard)
  async regenerate(@Param("id", new ParseUUIDPipe()) id: string, @Ctx() ctx: RequestContext) {
    const existing = await this.resumes.findById(id);
    if (!existing) throw new NotFoundException(`Resume ${id} not found`);
    return this.resume.generate(
      { worker_id: existing.workerId, profile_id: existing.profileId },
      ctx,
      { forceNewVersion: true }, // bump to a new version (don't upsert the current one)
    );
  }

  /**
   * Mint a short-lived signed download URL for a rendered resume PDF and emit
   * `resume.downloaded`. 409 while still rendering ('pending') or if it failed.
   * The signed URL is NOT logged or emitted (it embeds a token).
   */
  @Get(":id/download")
  @UseGuards(InternalServiceGuard)
  async download(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Ip() ip: string,
    @Ctx() ctx: RequestContext,
  ) {
    // Per-IP hourly cap (TD24) — an abuse backstop on top of the per-worker day cap.
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "resume_download",
      ip,
      this.config.RESUME_RATE_LIMIT_PER_IP_PER_HOUR,
    );
    const resume = await this.resumes.findById(id);
    if (!resume) throw new NotFoundException(`Resume ${id} not found`);

    if (resume.renderStatus !== "rendered" || !resume.pdfStorageKey) {
      if (resume.renderStatus === "pending") {
        throw new ConflictException("Resume PDF is still being rendered; please retry shortly");
      }
      throw new ConflictException("Resume PDF is not available for download");
    }

    const ttl = this.config.RESUME_SIGNED_URL_TTL_SECONDS;
    const url = await this.storage.createSignedUrl(resume.pdfStorageKey, ttl);

    await this.events.emit({
      event_name: "resume.downloaded",
      actor: { actor_type: "worker", actor_id: resume.workerId },
      subject: { subject_type: "resume", subject_id: resume.id },
      payload: {
        worker_id: resume.workerId,
        resume_id: resume.id,
        version: resume.version,
        format: "pdf",
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { url, expires_in: ttl };
  }

  /**
   * Record that a worker shared a resume. `channel` is a closed enum, so no link
   * or PII enters the `resume.shared` event payload.
   */
  @Post(":id/share")
  @HttpCode(201)
  @UseGuards(InternalServiceGuard)
  async share(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ShareResumeSchema)) dto: ShareResumeDto,
    @Ctx() ctx: RequestContext,
  ) {
    const resume = await this.resumes.findById(id);
    if (!resume) throw new NotFoundException(`Resume ${id} not found`);

    await this.events.emit({
      event_name: "resume.shared",
      actor: { actor_type: "worker", actor_id: resume.workerId },
      subject: { subject_type: "resume", subject_id: resume.id },
      payload: {
        worker_id: resume.workerId,
        resume_id: resume.id,
        version: resume.version,
        channel: dto.channel,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { ok: true };
  }
}
