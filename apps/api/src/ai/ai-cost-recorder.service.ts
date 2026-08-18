import { Injectable, Logger } from "@nestjs/common";
import type { AICallMetadata } from "@badabhai/ai-contracts";
import type { AiCostTaskType } from "@badabhai/event-schema";

import { EventsService } from "../events/events.service";
import { AiCostTotalsRepository } from "./ai-cost-totals.repository";

/**
 * WHO THIS SPEND BELONGS TO. Absent attribution is legitimate — payer-side calls have no
 * worker, and an inline call has no interview behind it.
 *
 * A SESSION IMPLIES A WORKER, IN THE TYPE. `session_ai_cost_totals.worker_id` is NOT NULL (it
 * is the second cascade path to DSAR erasure), so `accrue` can only write the per-session row
 * when it has BOTH ids. With two independently-optional fields, a future call site that knew
 * only the session id would compile, emit a perfectly valid event, and silently accrue no
 * session total — no throw, no warning, nothing to grep for. Making the pair the only
 * session-carrying shape moves that from "a defect someone reports in a dashboard six weeks
 * later" to "a type error at the call site". The three variants below are the only ones that
 * exist: nothing, a worker, or a worker and their session.
 *
 * IDS ONLY, AND ONLY OPAQUE INTERNAL ONES (§2). These are the same UUIDs `subject_id` and
 * `ai_jobs.input_ref` already carry. Nothing derived from what a worker said, typed, or is
 * called may ever be added to this shape — the whole point of attributing cost by id is that
 * the ledger never has to hold identity to answer "whose spend was this".
 */
export type AiCostAttribution =
  | { readonly workerId?: null; readonly sessionId?: null }
  | { readonly workerId: string; readonly sessionId?: string | null };

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
 * IT NOW ALSO MAINTAINS THE RUNNING TOTALS (migration 0077), on the same transaction as the
 * event but inside a SAVEPOINT. See {@link record} for why the two directions of failure are
 * not symmetric: the event must commit, the derived total may be rebuilt.
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
   * ATOMIC ON SUCCESS, DEGRADING ON FAILURE — AND THE ASYMMETRY IS THE POINT. The accrual runs
   * inside a SAVEPOINT on the event's transaction, so:
   *   - accrual succeeds → both rows commit together, and the total cannot disagree with the
   *     ledger row it was derived from;
   *   - accrual fails → the savepoint rolls back, the `ai.cost_recorded` row still COMMITS, and
   *     the totals trail the spine until a backfill over `events` repairs them.
   * That second line is the only recoverable failure of the two, and the earlier version of this
   * method had it backwards. Without the savepoint, ANY error inside `accrue` aborts the whole
   * transaction in Postgres — a JS `catch` does not heal `25P02`, the eventual `COMMIT` becomes a
   * `ROLLBACK` — so a totals failure DESTROYED the audit-ledger row, and the `catch` below turned
   * that into one `warn` line and a successful request. There is nothing to back-fill FROM once
   * the event is gone: the spine is the source of truth, so the direction of the trade must be
   * "lose the derived number, keep the ledger", never the reverse.
   *
   * IT IS NOT HYPOTHETICAL, AND THAT IS WHY IT IS A SAVEPOINT AND NOT A COMMENT. Three reachable
   * triggers, none of them exotic:
   *   1. DEPLOY ORDER — this code live against a database without 0077 makes the unconditional
   *      `platform_ai_cost_totals` upsert raise `relation does not exist`, i.e. 100% of
   *      `ai.cost_recorded` lost on EVERY surface, silently. (This is also what makes the
   *      migration genuinely "not apply-before-deploy" rather than merely inconvenient.)
   *   2. FK VIOLATION — a queued job can outlive its subject. `AccountDeletionService` hard-
   *      deletes `workers` (cascading `chat_sessions`) while BullMQ jobs for that worker are
   *      still in flight, and both totals FKs are NOT NULL.
   *   3. LOCK CONTENTION — deadlock, lock timeout or statement timeout on the hot
   *      `platform_ai_cost_totals(provider, task_type)` row, which the schema header names as a
   *      known contention point by construction.
   * All three now cost the derived number and nothing else.
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

        // INSIDE A SAVEPOINT, AND CAUGHT SEPARATELY FROM THE EMIT. Everything above this line
        // is the audit ledger and must reach COMMIT; everything below is a derived number that
        // a backfill can rebuild. The savepoint is what lets one fail without the other, and
        // the inner catch is what stops the failure from unwinding past it.
        try {
          await this.totals.withSavepoint(tx, (sp) =>
            this.totals.accrue(
              {
                workerId,
                sessionId,
                // Defaulted to the SAME literal the payload carries, so the totals table and
                // the event agree about an unlabelled call instead of dropping it.
                provider: meta.provider || "unknown",
                taskType,
                costInr: meta.estimated_cost_inr,
                realCall: meta.real_call,
              },
              sp,
            ),
          );
        } catch (err) {
          // The event row survives this. Logged distinctly from the emit failure below,
          // because the two mean opposite things: "the ledger is missing a row" versus "the
          // ledger has the row and the derived total is behind by one call".
          this.logger.warn(
            `ai cost totals accrual failed for call ${meta.ai_call_id} task=${taskType} — ` +
              `the ai.cost_recorded event is COMMITTED and the totals now trail the spine ` +
              `(repairable by backfill): ${String(err)}`,
          );
        }
      });
    } catch (err) {
      this.logger.warn(
        `ai.cost_recorded emit failed for job ${aiJobId ?? "(none — inline surface)"} ` +
          `task=${taskType} (non-fatal): ${String(err)}`,
      );
    }
  }
}
