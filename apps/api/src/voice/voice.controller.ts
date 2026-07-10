import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
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
  createUploadUrl(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(CreateUploadUrlSchema)) _dto: CreateUploadUrlDto,
  ) {
    return this.voice.createUploadUrl(worker.id);
  }

  @Post("upload")
  @HttpCode(201)
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
  transcribe(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(TranscribeVoiceNoteSchema)) dto: TranscribeVoiceNoteDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.voice.requestTranscription(worker.id, dto, ctx);
  }

  /** Read one voice note incl. transcript fields (owner only; read-only → no event). */
  @Get(":voiceNoteId")
  get(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param(new ZodValidationPipe(VoiceNoteIdParamSchema)) params: { voiceNoteId: string },
  ) {
    return this.voice.getNote(worker.id, params.voiceNoteId);
  }
}
