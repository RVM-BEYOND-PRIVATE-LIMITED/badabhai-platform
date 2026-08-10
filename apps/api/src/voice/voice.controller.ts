import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard, RequireConsentPurpose } from "../auth/consent.guard";
import { VoiceService } from "./voice.service";
import {
  CreateUploadUrlSchema,
  type CreateUploadUrlDto,
  UploadVoiceNoteSchema,
  type UploadVoiceNoteDto,
  TranscribeVoiceNoteSchema,
  type TranscribeVoiceNoteDto,
  VoiceNoteIdParamSchema,
} from "./voice.dto";

/**
 * Voice notes (worker AI path — transcription hits the gated STT). Worker-
 * authenticated + consent-gated (CLAUDE.md §2 invariants 4/6): the worker comes
 * from the bearer token via @CurrentWorker — never from the body. Ownership of
 * the referenced session/note is enforced in the service (404, no oracle).
 *
 * THE THREE PROCESSING ROUTES ALSO REQUIRE THE `voice_processing` PURPOSE (V9). They are the
 * only way a clip can come into existence or reach the third-party ASR processor, which makes
 * them the chokepoint: gate them and there is no path to a recording, whatever any other
 * surface believes. The purpose is declared per-route rather than on the class so the reason
 * each one carries it stays legible — and so the read route below can be reasoned about
 * separately rather than inheriting a gate nobody chose for it.
 */
@Controller("voice")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /**
   * Mint a signed upload URL (server-controlled object key). 503 while
   * VOICE_NOTES_BUCKET is unset (fail-closed dormancy). Body is empty by
   * design — the client chooses nothing about the destination.
   */
  @Post("upload-url")
  @HttpCode(201)
  @RequireConsentPurpose("voice_processing")
  createUploadUrl(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(CreateUploadUrlSchema)) _dto: CreateUploadUrlDto,
  ) {
    return this.voice.createUploadUrl(worker.id);
  }

  @Post("upload")
  @HttpCode(201)
  @RequireConsentPurpose("voice_processing")
  upload(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(UploadVoiceNoteSchema)) dto: UploadVoiceNoteDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.voice.upload(worker.id, dto, ctx);
  }

  /** Enqueue async transcription; returns 202 + { ai_job_id, status }. */
  @Post("transcribe")
  @HttpCode(202)
  @RequireConsentPurpose("voice_processing")
  transcribe(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(TranscribeVoiceNoteSchema)) dto: TranscribeVoiceNoteDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.voice.requestTranscription(worker.id, dto, ctx);
  }

  /**
   * Read one voice note incl. transcript fields (owner only; read-only → no event).
   *
   * DELIBERATELY NOT PURPOSE-GATED. This route processes nothing — it reads back a clip the
   * worker already owns. Gating it would lock a worker out of their OWN data at exactly the
   * moment they withdrew the purpose, which inverts what withdrawal is for and cuts against the
   * DPDP access right. Withdrawal must stop new recording and new transcription, both of which
   * are gated above; it is not a reason to hide what was already captured. Erasure, not this
   * route, is what removes the clip — `AccountDeletionService` owns that path.
   */
  @Get(":voiceNoteId")
  get(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param(new ZodValidationPipe(VoiceNoteIdParamSchema)) params: { voiceNoteId: string },
  ) {
    return this.voice.getNote(worker.id, params.voiceNoteId);
  }
}
