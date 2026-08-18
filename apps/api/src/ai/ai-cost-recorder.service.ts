import { Injectable, Logger } from "@nestjs/common";
import type { AICallMetadata } from "@badabhai/ai-contracts";
import type { AiCostTaskType } from "@badabhai/event-schema";

import { EventsService } from "../events/events.service";
import { AiCostTotalsRepository } from "./ai-cost-totals.repository";

/**
 * WHO THIS SPEND BELONGS TO. Both fields are OPTIONAL and both may legitimately be absent —
 * payer-side calls have no worker, and an inline call has no interview behind it.
 *
 * IDS ONLY, AND ONLY OPAQUE INTERNAL ONES (§2). These are the same UUIDs `subject_id` and
 * `ai_jobs.input_ref` already carry. Nothing derived from what a worker said, typed, or is
 * called may ever be added to this shape — the whole point of attributing cost by id is that
 * the ledger never has to hold identity to answer "whose spend was this".
 */
export interface AiCostAttribution {
  readonly workerId?: string | null;
  readonly sessionId?: string | null;
}

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
 *
 * IT NOW ALSO MAINTAINS THE RUNNING TOTALS (migration 0077), in the SAME transaction as the
 * event. See {@link record} for why atomicity is the point rather than a detail.
 */
@Injectable()
export class AiCostRecorder {
  private readonly logger = new Logger(AiCostRecorder.name);

  constructor(
    private readonly events: EventsService,
    private readonly totals: AiCostTotalsRepository,
  ) {}

  /**
   * Emit the cost record for ONE provider call, and fold it into the running totals.
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
   *
   * `aiJobId` IS NULLABLE, AND THAT IS THE #745 WIDENING. Three spending surfaces have no
   * `ai_jobs` row at all: the résumé route runs inline on the request, skill canonicalization
   * fans out N embeds inside one posting write, and the payer chat turn is a synchronous reply.
   * Requiring a job id here is what kept them unledgered — the alternative was minting a fake
   * `ai_jobs` row purely to satisfy this signature, which would have put rows describing no
   * async job into the table every dashboard reads.
   *
   * `subject_id` and `ai_job_id` both go null in that case (the envelope and the payload each
   * declare them nullable), so every cost record still has ONE shape and the ledger query stays
   * `WHERE task_type = ?` — the query the whole defect class is about. `ai_call_id` remains the
   * identity of the event either way.
   *
   * ---
   *
   * `attribution` IS WHAT MAKES "WHAT DID THIS WORKER COST?" ANSWERABLE. Before it, exactly one
   * task type could answer that question — `profile_extraction`, by joining `ai_jobs.input_ref`
   * — and the DOMINANT profiling cost driver could not: `profiling_chat_turn` is emitted with a
   * null `ai_job_id` by construction, so it had neither a join nor a field. `resume_generation`,
   * `skill_embedding` and `job_posting_chat_turn` were in the same position. The ids are passed
   * IN rather than looked up here, because only the caller knows whose call it was, and a
   * recorder that guessed would be a recorder that attributed spend to the wrong worker.
   *
   * THE TOTALS MOVE IN THE SAME COMMIT AS THE EVENT, AND ONLY IF THE EVENT WAS WRITTEN.
   * `emitOnce` reports whether the `ON CONFLICT DO NOTHING` insert actually stored a row; a
   * redelivered queue job re-emits the same `ai_call_id`, stores nothing, and must therefore
   * move nothing. Binding the increment to that boolean — rather than to "we reached this line"
   * — is what makes a retried job idempotent here, and it is the same rule
   * `AdminActionsRepository.grantCredits` uses to bind a balance move to a NEW ledger row.
   *
   * ATOMIC, SO THE TOTAL CANNOT DISAGREE WITH THE LEDGER IT IS DERIVED FROM. If the totals
   * write fails the event insert rolls back with it. That is the deliberate trade: a totals
   * table that silently trails the spine is wrong in a way nobody can see, whereas a missing
   * cost event leaves BOTH sides consistent and re-derivable — the spine remains the source of
   * truth and a backfill over it reconstructs the totals exactly.
   */
  async record(
    meta: AICallMetadata | null,
    taskType: AiCostTaskType,
    aiJobId: string | null,
    correlationId: string,
    requestId: string,
    attribution: AiCostAttribution = {},
  ): Promise<void> {
    if (!meta) return;
    const workerId = attribution.workerId ?? null;
    const sessionId = attribution.sessionId ?? null;
    try {
      // The transaction comes from the repository that OWNS the totals tables — the same
      // `withTransaction` seam `AdminActionsService` uses. It is not opened here, because the
      // recorder should not know how a `Database` handle is obtained.
      await this.totals.withTransaction(async (tx) => {
        const { written } = await this.events.emitOnce({
          event_name: "ai.cost_recorded",
          actor: { actor_type: "ai_service" },
          subject: { subject_type: "ai_job", subject_id: aiJobId ?? null },
          payload: {
            ai_call_id: meta.ai_call_id,
            ai_job_id: aiJobId ?? null,
            worker_id: workerId,
            session_id: sessionId,
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
            success: meta.success,
            error_code: meta.error_code,
            failure_reason: meta.failure_reason,
          },
          idempotencyKey: `ai.cost_recorded:${meta.ai_call_id}`,
          correlationId,
          requestId,
          tx,
        });

        // A DEDUPED EMIT MOVES NOTHING. This call's spend is already in the totals from the
        // attempt that stored the event.
        if (!written) return;

        await this.totals.accrue(
          {
            workerId,
            sessionId,
            // Defaulted to the SAME literal the payload carries, so the totals table and the
            // event agree about an unlabelled call instead of dropping it.
            provider: meta.provider || "unknown",
            taskType,
            costInr: meta.estimated_cost_inr,
            realCall: meta.real_call,
          },
          tx,
        );
      });
    } catch (err) {
      this.logger.warn(
        `ai.cost_recorded emit failed for job ${aiJobId ?? "(none — inline surface)"} ` +
          `task=${taskType} (non-fatal): ${String(err)}`,
      );
    }
  }
}
