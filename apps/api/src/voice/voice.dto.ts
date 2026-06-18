import { z } from "zod";
import { uuidSchema, voiceDurationSecondsSchema, safeTextSchema } from "@badabhai/validators";

/**
 * Request DTOs carry NO worker_id: the acting worker is taken from the
 * authenticated session (WorkerAuthGuard), never trusted from the body.
 */
export const UploadVoiceNoteSchema = z.object({
  session_id: uuidSchema,
  // Phase 1 placeholder: the client provides the already-uploaded storage path.
  storage_path: safeTextSchema(512),
  duration_seconds: voiceDurationSecondsSchema, // > 0 and <= 120
});
export type UploadVoiceNoteDto = z.infer<typeof UploadVoiceNoteSchema>;

/** Request async transcription of a previously-uploaded voice note. */
export const TranscribeVoiceNoteSchema = z.object({
  voice_note_id: uuidSchema,
});
export type TranscribeVoiceNoteDto = z.infer<typeof TranscribeVoiceNoteSchema>;
