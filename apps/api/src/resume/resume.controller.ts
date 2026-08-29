import {
  Body,
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
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
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

  /**
   * Generate (or refresh) the worker's OWN resume. Worker-authenticated (TD70
   * item 5); the acting worker id comes from the SESSION (XB-A), NEVER the body.
   * The body `worker_id` survives only for back-compat with shipped worker-app
   * clients that still send it: a mismatch with the session worker returns 404 —
   * not 400/403 — for consistency with the sibling download route's
   * no-existence-oracle posture (the response must never confirm that another
   * worker or their profile exists).
   *
   * CONSENT-GATED (B-3, CLAUDE.md §2 invariant 6: no AI processing before
   * `consent.accepted`). Resume generation sends the worker's profile to an LLM,
   * so it is AI processing and carries {@link ConsentGuard} — the same gate the
   * sibling worker-AI routes (chat / voice / profiles) already had. The gap was
   * not merely theoretical: reaching this route implies a profile (and so a past
   * consent), but a worker who WITHDREW consent could still generate — sending
   * their profile to an LLM post-withdrawal. Guard order matters: WorkerAuthGuard
   * first (it attaches `req.worker`, which ConsentGuard reads).
   *
   * Applied PER-ROUTE, never class-level: the sibling `InternalServiceGuard`
   * routes carry no worker session, so a class-level ConsentGuard would 401 the
   * extraction pipeline.
   */
  @Post("generate")
  @HttpCode(201)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  generate(
    @Body(new ZodValidationPipe(GenerateResumeSchema)) dto: GenerateResumeDto,
    @CurrentWorker() worker: AuthenticatedWorker,
    @Ctx() ctx: RequestContext,
  ) {
    if (dto.worker_id !== undefined && dto.worker_id !== worker.id) {
      throw new NotFoundException(`Profile ${dto.profile_id} not found`);
    }
    return this.resume.generate({ worker_id: worker.id, profile_id: dto.profile_id }, ctx);
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

  /**
   * Record that a worker shared a resume (PII-free, closed-enum channel).
   *
   * ── R16 §5.1 — WORKER-CALLABLE NOW, AND IT NEVER WAS ─────────────────────────────────
   *
   * This route carried `InternalServiceGuard`, which requires a shared `x-internal-service`
   * secret and denies every request when that secret is unset. The worker app holds no such
   * secret and never could — so `resume.shared`, the ONE number §12.2 calls "the number that
   * matters" and §12.4 sets a ninety-day kill criterion against, was unreachable by
   * construction. The metric that decides whether the free résumé survives could not fire.
   *
   * NOTHING CALLED IT. A repo-wide search finds the route definition and one prod-canary probe
   * that expects a rejection — no internal service, no job, no client. Converting it costs no
   * caller.
   *
   * FOUR THINGS MOVE TOGETHER, and three of them are the reason a guard swap alone would have
   * been worse than leaving it shut:
   *
   *   WorkerAuthGuard   so the app can reach it at all.
   *   ConsentGuard      recording what a worker did with their résumé is behavioural profiling,
   *                     which is exactly what the sibling `POST /workers/me/actions/batch`
   *                     gates. Ordered AFTER the auth guard, which reads `req.worker`.
   *   ownership         `recordShare` took only a resume id and attributed the event to whatever
   *                     row it found. Under an internal-only guard the caller was trusted; under
   *                     a worker session it is not, and a guessed UUID would have written an
   *                     engagement signal in a stranger's name. Worker engagement is a
   *                     first-class ranking signal (CLAUDE.md §2.4), so that is a rankable
   *                     forgery, not a bad analytics row.
   *   per-IP cap        `download` carries one and this had none. An event-writer with a session
   *                     and no cap is an unmetered one.
   */
  @Post(":id/share")
  @HttpCode(201)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async share(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ShareResumeSchema)) dto: ShareResumeDto,
    @Ip() ip: string,
    @Ctx() ctx: RequestContext,
  ) {
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "resume_share",
      ip,
      this.config.RESUME_RATE_LIMIT_PER_IP_PER_HOUR,
    );
    return this.resume.recordShare(worker.id, id, dto, ctx);
  }
}
