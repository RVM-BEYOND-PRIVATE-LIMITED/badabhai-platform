import type { AICallMetadata } from "@badabhai/ai-contracts";

import type { AiJobUsageMetadata } from "../profiles/ai-jobs.repository";

/**
 * Map the AI router's `ai_metadata` onto the PII-free operational columns stored on an
 * `ai_jobs` row. Returns `undefined` when there is no metadata (the mock / AI-down /
 * blocked paths), which leaves those columns null rather than writing a zero that is
 * indistinguishable from a real free call.
 *
 * WHY IT LIVES HERE AND NOT ON THE EXTRACTION PROCESSOR. It was a module-private function
 * in `profile-extraction.processor.ts`, and the consequence was concrete rather than
 * stylistic: `VoiceTranscriptionService` had no way to reach it, so it called
 * `markCompleted(id, outputRef)` with no usage argument and `ai_jobs.cost_inr` stayed
 * permanently NULL for EVERY transcription job — while the same call's cost was being
 * emitted to the event spine four lines earlier. A per-job cost query therefore returned
 * "no cost" for the whole STT surface, which reads as free rather than as unrecorded.
 * That is the same shape as the defect `AiCostRecorder` was extracted to fix (#738), one
 * layer down, so the fix is the same one: make it reachable instead of copying it.
 *
 * PII-free by construction: only these typed scalars cross — a model name, a boolean, three
 * integer counts and a rupee estimate. Never a prompt, a completion or a transcript.
 */
export function toAiJobUsage(meta: AICallMetadata | null): AiJobUsageMetadata | undefined {
  if (!meta) return undefined;
  return {
    modelName: meta.model_name || null,
    realCall: meta.real_call,
    inputTokens: meta.input_tokens,
    outputTokens: meta.output_tokens,
    totalTokens: meta.input_tokens + meta.output_tokens,
    costInr: meta.estimated_cost_inr,
  };
}
