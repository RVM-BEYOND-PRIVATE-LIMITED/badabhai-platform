import { Injectable, Logger } from "@nestjs/common";
import type { AICallMetadata } from "@badabhai/ai-contracts";
import type { AiCostTaskType } from "@badabhai/event-schema";

import { EventsService } from "../events/events.service";

/**
 * THE ONE PLACE `ai.cost_recorded` IS EMITTED, FOR EVERY PROVIDER SURFACE.
 *
 * WHY IT IS A SERVICE AND NOT A METHOD ON A PROCESSOR (#738). This logic used to be
 * `private recordAiCost` on `ProfileExtractionProcessor`. It worked — for the one caller that
 * could see it. `VoiceTranscriptionService` had no way to reach a private method on an unrelated
 * class, so STT spend was emitted by nobody, while `aiTaskType` already listed
 * `stt_transcription`. The result was the worst shape available: a query for STT cost returned
 * empty and read as *"no spend"* rather than *"not instrumented"*, and the only thing bounding
 * the money was a Redis limiter whose keys expire ~25h after the day they describe.
 *
 * Privacy of the emitted payload is a property of {@link AICallMetadata}, which carries ids, a
 * model name, int counts, rupees and closed-set reason codes — never a prompt, a completion, a
 * transcript or anything a worker said.
 */
@Injectable()
export class AiCostRecorder {
  private readonly logger = new Logger(AiCostRecorder.name);

  constructor(private readonly events: EventsService) {}

  /**
   * Emit the cost record for ONE provider call.
   *
   * NO-OPS ON `null` METADATA — no metadata means no real call to record, which is the mock and
   * service-unreachable path. The caller does not have to branch.
   *
   * NEVER THROWS. Cost observability must not be able to fail the work it is observing: a failed
   * emit downgrades to a warning, because a dropped cost row is worth strictly less than the
   * transcription or extraction it would otherwise take down.
   *
   * KEYED ON `ai_call_id`, NOT ON THE JOB. One job can make several billable calls — extraction
   * plus `/profile/parse`, or a retried transcription — and a per-job key silently deduped the
   * later ones away, which is how an interview's model spend once disappeared into a dedupe. The
   * call id is what this event is about, so it is what exactly-once means here.
   */
  async record(
    meta: AICallMetadata | null,
    taskType: AiCostTaskType,
    aiJobId: string,
    correlationId: string,
    requestId: string,
  ): Promise<void> {
    if (!meta) return;
    try {
      await this.events.emit({
        event_name: "ai.cost_recorded",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "ai_job", subject_id: aiJobId },
        payload: {
          ai_call_id: meta.ai_call_id,
          ai_job_id: aiJobId,
          task_type: taskType,
          model: meta.model_name || "unknown",
          provider: meta.provider || "unknown",
          real_call: meta.real_call,
          tokens_in: meta.input_tokens,
          tokens_out: meta.output_tokens,
          estimated_cost_inr: meta.estimated_cost_inr,
          latency_ms: meta.latency_ms,
          cost_alert: meta.cost_alert,
          above_target: meta.above_target,
        },
        idempotencyKey: `ai.cost_recorded:${meta.ai_call_id}`,
        correlationId,
        requestId,
      });
    } catch (err) {
      this.logger.warn(
        `ai.cost_recorded emit failed for job ${aiJobId} task=${taskType} (non-fatal): ${String(err)}`,
      );
    }
  }
}
