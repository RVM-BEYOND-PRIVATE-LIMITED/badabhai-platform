import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { VoiceService } from "./voice.service";
import {
  UploadVoiceNoteSchema,
  type UploadVoiceNoteDto,
  TranscribeVoiceNoteSchema,
  type TranscribeVoiceNoteDto,
} from "./voice.dto";

@Controller("voice")
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Post("upload")
  @HttpCode(201)
  upload(
    @Body(new ZodValidationPipe(UploadVoiceNoteSchema)) dto: UploadVoiceNoteDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.voice.upload(dto, ctx);
  }

  /** Enqueue async transcription; returns 202 + { ai_job_id, status }. */
  @Post("transcribe")
  @HttpCode(202)
  transcribe(
    @Body(new ZodValidationPipe(TranscribeVoiceNoteSchema)) dto: TranscribeVoiceNoteDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.voice.requestTranscription(dto, ctx);
  }
}
