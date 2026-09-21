import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from "@nestjs/common";

import { ConsentGuard } from "../../auth/consent.guard";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../../auth/worker-auth.guard";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ResumeImportService } from "./resume-import.service";
import {
  ConfirmResumeImportSchema,
  CreateResumeUploadUrlSchema,
  ResumeImportIdParamSchema,
  type ConfirmResumeImportDto,
  type CreateResumeUploadUrlDto,
  type ResumeImportIdParamDto,
} from "./resume-import.dto";

/**
 * Résumé import (worker surface) — ADR-0041, phase RI-1.
 *
 * THE SAME SPINE AS EVERY OTHER WORKER CONTROLLER, to the letter: worker-authenticated then
 * consent-gated, in that guard order (CLAUDE.md §2 invariants 4/6), the acting worker taken from
 * the bearer token via `@CurrentWorker` and NEVER from the body. A new surface is a new front
 * door, not a new set of locks.
 *
 * ── NO NEW CONSENT PURPOSE, AND THAT IS A SIGNED RULING ──────────────────────────────────
 *
 * There is no `@RequireConsentPurpose` here. `voice_processing` was minted as its own purpose on
 * the argument that consenting to be profiled is consenting to ANSWER QUESTIONS rather than to be
 * RECORDED, and the same argument extends to handing over a document. Ruling D1 (ADR-0041) went
 * the other way: a résumé is a profiling input a worker volunteers for exactly the purpose he
 * already consented to. So `ConsentGuard`'s ordinary `profiling` check is the gate, and there is
 * nothing dormant on the consent axis.
 *
 * WHAT STILL GATES THIS SURFACE is `RESUME_UPLOADS_BUCKET`: unset (the default) and both write
 * routes 503. The feature ships inert and is armed by a bucket, not by a purpose.
 *
 * ── WHY THE READ ROUTE HAS NO GATE OF ITS OWN ────────────────────────────────────────────
 *
 * Neither write route can be reached without profiling consent, and `GET :importId` processes
 * nothing — it reads back the status of something the worker already gave us. That distinction is
 * `VoiceController`'s and it holds here for the same reason: withdrawal must stop new processing,
 * not hide from a worker what was already captured.
 */
@Controller("profiling/resume-import")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class ResumeImportController {
  constructor(private readonly imports: ResumeImportService) {}

  /**
   * Mint a signed upload URL (server-controlled object key).
   *
   * 503 while `RESUME_UPLOADS_BUCKET` is unset (fail-closed dormancy). NO event — minting is an
   * authorization grant, not a state change, and the confirm step emits. The response's signed
   * URL is a bearer credential: `no-store`, never logged, never emitted.
   */
  @Post("upload-url")
  @HttpCode(201)
  @Header("Cache-Control", "no-store") // response carries a signed bearer URL — never cache
  createUploadUrl(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(CreateResumeUploadUrlSchema)) dto: CreateResumeUploadUrlDto,
  ) {
    return this.imports.createUploadUrl(worker.id, dto);
  }

  /**
   * Register the uploaded object: minted-key shape check, then the object's real mime and size
   * from Storage object-info, then persist and emit `profile.resume_imported`.
   *
   * Idempotent per key — a retry after a lost response returns the original row rather than
   * colliding with the unique index.
   */
  @Post()
  @HttpCode(201)
  confirm(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(ConfirmResumeImportSchema)) dto: ConfirmResumeImportDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.imports.confirm(worker.id, dto, ctx);
  }

  /**
   * Read one import's status back (owner only; read-only → no event).
   *
   * 404 for both not-found and not-owner, so this is not an existence oracle for another
   * worker's imports.
   */
  @Get(":importId")
  get(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param(new ZodValidationPipe(ResumeImportIdParamSchema)) params: ResumeImportIdParamDto,
  ) {
    return this.imports.get(worker.id, params.importId);
  }
}
