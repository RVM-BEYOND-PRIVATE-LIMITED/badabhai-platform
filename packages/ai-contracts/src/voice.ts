// Voice transcription (STT) request-response pair.
import { z } from "zod";

import { languageCode } from "./internal/primitives";

// ---------------------------------------------------------------------------
// Voice transcription (STT). Input carries only an opaque storage reference;
// output's transcript_text is raw worker free-text — the backend stores it in
// voice_notes and keeps it OUT of events/ai_jobs/logs.
// ---------------------------------------------------------------------------
export const TranscriptionInputSchema = z.object({
  voice_note_id: z.string().min(1).optional(),
  storage_path: z.string().min(1),
  duration_seconds: z.number().nonnegative().nullable().optional(),
  language_code: languageCode.optional(),
  // Optional (AI service defaults to true) → backward compatible input type.
  real_call_allowed: z.boolean().optional(),
  // AI service ALSO translates the transcript to English when true (it defaults to
  // true server-side). Optional here → backward compatible input type.
  translate_to_english: z.boolean().optional(),
  // Opaque worker ref (PII-free) → attributes real STT chunk spend to the TD27
  // per-user daily cap (D-2 chunked path: one 120s note = up to 5 provider calls),
  // so voice + chat + extraction + resume share one budget. Optional → backward
  // compatible. Mirrors contracts.py TranscriptionInput.worker_ref.
  worker_ref: z.string().min(1).optional(),
});
export type TranscriptionInput = z.infer<typeof TranscriptionInputSchema>;

export const TranscriptionOutputSchema = z.object({
  transcript_text: z.string(),
  confidence: z.number().min(0).max(1).default(0),
  language_code: z.string().nullable().default(null),
  /** True when the response came from the mock path (AI_ENABLE_REAL_CALLS=false). */
  is_mock: z.boolean().default(true),
  // Derived English translation (empty when not translated / source already English /
  // translation failed-closed). Raw worker text — stored in voice_notes.transcript_english,
  // kept OUT of events/ai_jobs/logs.
  english_text: z.string().default(""),
});
export type TranscriptionOutput = z.infer<typeof TranscriptionOutputSchema>;
