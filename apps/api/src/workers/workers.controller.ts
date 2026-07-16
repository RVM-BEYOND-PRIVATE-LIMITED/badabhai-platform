import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { clampLimit } from "../common/pagination";
import { Ctx, type RequestContext } from "../common/request-context";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { WorkersRepository } from "./workers.repository";
import { WorkersService } from "./workers.service";
import {
  SetWorkerNameSchema,
  type SetWorkerNameDto,
  SetMyNameSchema,
  type SetMyNameDto,
  UpdateResumePrefsSchema,
  type UpdateResumePrefsDto,
  ConfirmPhotoSchema,
  type ConfirmPhotoDto,
  type WorkerProfileSummary,
  type WorkerResumeFields,
} from "./workers.dto";

@Controller("workers")
export class WorkersController {
  constructor(
    private readonly workers: WorkersRepository,
    private readonly workersService: WorkersService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** List workers (newest first) with latest-profile summary. No PII. */
  @Get()
  async list(@Query("limit") limit?: string) {
    return { workers: await this.workers.list(clampLimit(limit)) };
  }

  /**
   * Worker SELF-view profile summary (TD54 — the app's home "my profile" card).
   * The worker is taken from the bearer token via @CurrentWorker — NEVER from a
   * path/body id (no IDOR). Consent-gated like every worker-self read of profile
   * data (CLAUDE.md §2 invariant #6) — hence WorkerAuthGuard THEN ConsentGuard
   * (ConsentGuard reads `req.worker`, which WorkerAuthGuard attaches).
   *
   * NO PII in the response (no name — an OPEN escalation, see
   * docs/worker-profile-summary-spec.md — and never phone/hash) and NO event:
   * a read-only self-view is not a material state change (§1).
   *
   * ROUTE ORDER: declared BEFORE the `:id/profile` param route below so a literal
   * "me" path segment is never captured as an `:id` (Nest matches in declaration
   * order within a controller).
   */
  @Get("me/profile-summary")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async getMyProfileSummary(
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<WorkerProfileSummary> {
    return this.workersService.getProfileSummary(worker.id);
  }

  /**
   * Worker SELF-view of the editable resume "safe fields" (the "Aap control karte
   * hain" edit screen loads this): the worker's OWN name spelling + the two display
   * prefs. Worker from @CurrentWorker (never a path/body id); consent-gated like
   * every worker-self profile read (WorkerAuthGuard THEN ConsentGuard).
   *
   * Returns the worker's OWN name — a self-read, not a cross-actor leak; it never
   * enters an event/log/ai_jobs/LLM. NO event (a read is not a state change, §1).
   *
   * ROUTE ORDER: declared BEFORE the `:id/profile` param route so the literal "me"
   * segment is never captured as an `:id` (Nest matches in declaration order).
   */
  @Get("me/resume-fields")
  @Header("Cache-Control", "no-store") // response carries the worker's own name (PII) — never cache
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async getMyResumeFields(
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<WorkerResumeFields> {
    return this.workersService.getResumeFields(worker.id);
  }

  /**
   * ADR-0032 — short-lived signed READ url for the worker's OWN profile photo.
   * Own-session only (@CurrentWorker, never body/path — no IDOR); consent-gated.
   * The signed URL is a bearer credential: no-store, never logged, never emitted.
   * 404 when no photo; 503 while WORKER_PHOTOS_BUCKET is unset (dormant).
   * NO event (a read is not a state change, §1).
   *
   * ROUTE ORDER: declared BEFORE the `:id/profile` param route so the literal "me"
   * segment is never captured as an `:id` (Nest matches in declaration order).
   */
  @Get("me/photo-url")
  @Header("Cache-Control", "no-store") // response carries a signed bearer URL — never cache
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async getMyPhotoUrl(
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<{ url: string; expires_in: number }> {
    return this.workersService.getPhotoUrl(worker.id);
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

  /**
   * Worker SELF-service name capture. The worker is taken from the bearer token
   * via @CurrentWorker — NEVER from a path/body id (no IDOR). Consent-gated: name
   * capture is processing of personal data, so it must follow `consent.accepted`
   * (CLAUDE.md §2 invariant #6) — hence WorkerAuthGuard THEN ConsentGuard
   * (ConsentGuard reads `req.worker`, which WorkerAuthGuard attaches).
   *
   * The plaintext name is encrypted at rest by the service, emitted as a name-free
   * `worker.name_recorded` event, and never logged — the response is only
   * `{ ok: true }` (never the raw name).
   */
  @Patch("me/name")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async setMyName(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(SetMyNameSchema)) dto: SetMyNameDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true }> {
    await this.workersService.setFullName(worker.id, dto.full_name, ctx);
    return { ok: true };
  }

  /**
   * Update the worker's resume display prefs (show-photo / night-shift-ready) from
   * the edit screen. Worker from @CurrentWorker (never body/path); consent-gated.
   * Emits a PII-free `worker.resume_prefs_updated`. Response is only `{ ok: true }`.
   */
  @Patch("me/resume-prefs")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async updateMyResumePrefs(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(UpdateResumePrefsSchema)) dto: UpdateResumePrefsDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true }> {
    await this.workersService.updateResumePrefs(worker.id, dto, ctx);
    return { ok: true };
  }

  /**
   * ADR-0032 — mint a signed UPLOAD url for the worker's profile photo. Worker
   * from the token (never body/path); consent-gated (a face photo is personal-data
   * processing, invariant #6). The body is deliberately EMPTY (`{}`): the SERVER
   * chooses the object key — the client controls nothing about the destination.
   * 503 while WORKER_PHOTOS_BUCKET is unset. NO event (minting is an authorization
   * grant, not a state change — the confirm step emits). The response's signed URL
   * is a bearer credential: no-store, never logged.
   */
  @Post("me/photo/upload-url")
  @HttpCode(201)
  @Header("Cache-Control", "no-store") // response carries a signed bearer URL — never cache
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async createMyPhotoUploadUrl(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Ip() ip: string,
  ): Promise<{ storage_path: string; upload_url: string; expires_in: number }> {
    // bb-security-review M-1: unthrottled minting = unlimited ≤2MiB orphan objects
    // (upload-but-never-confirm). Same fail-closed per-IP idiom as the download caps.
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "photo_upload_url",
      ip,
      this.config.PHOTO_RATE_LIMIT_PER_IP_PER_HOUR,
    );
    return this.workersService.createPhotoUploadUrl(worker.id);
  }

  /**
   * ADR-0032 — confirm the photo upload: anti-forgery minted-key check, object
   * mime/size validation (JPEG/PNG ≤ 2MB), pointer persist, superseded-object
   * cleanup, and a PII-free `worker.photo_uploaded` (worker_id only — never the
   * key or a URL). Worker from the token; consent-gated.
   */
  @Post("me/photo")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async confirmMyPhoto(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ConfirmPhotoSchema)) dto: ConfirmPhotoDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ worker_id: string; has_photo: true }> {
    return this.workersService.confirmPhoto(worker.id, dto, ctx);
  }

  /**
   * ADR-0032 — remove the worker's profile photo. IDEMPOTENT (no photo → 200,
   * no event). Clearing the pointer always works — data minimization is never
   * blocked by dormancy; only the object delete is skipped while the bucket is
   * unset. Emits a PII-free `worker.photo_removed` when a photo existed.
   */
  @Delete("me/photo")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async deleteMyPhoto(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Ctx() ctx: RequestContext,
  ): Promise<{ worker_id: string; has_photo: false }> {
    return this.workersService.deletePhoto(worker.id, ctx);
  }
}
