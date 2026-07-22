import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { DraftProfile, AICallMetadata, ConversationMessage } from "@badabhai/ai-contracts";
import { SKILL_TAXONOMY_VERSION } from "@badabhai/taxonomy";
import { EventsService } from "../events/events.service";
import { AiService } from "../ai/ai.service";
import { ChatRepository } from "../chat/chat.repository";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository, type AiJobUsageMetadata } from "./ai-jobs.repository";
import { AI_SPEND_CAP_REASONS, type AiSpendCapReason } from "@badabhai/event-schema";
import {
  PROFILE_EXTRACTION_QUEUE,
  type ProfileExtractionJobData,
} from "../queue/queue.constants";

/**
 * TD27 spend-cap / circuit-breaker block codes the AI gateway returns in
 * `ai_metadata.error_code` when it REFUSES a real provider call. Mirrors the
 * `AI_SPEND_CAP_REASONS` enum in @badabhai/event-schema (single source of truth).
 */
const SPEND_CAP_REASONS: ReadonlySet<string> = new Set(AI_SPEND_CAP_REASONS);

/** Narrow an arbitrary `error_code` to a known spend-cap reason, or null. */
function asSpendCapReason(code: string | null | undefined): AiSpendCapReason | null {
  return code != null && SPEND_CAP_REASONS.has(code) ? (code as AiSpendCapReason) : null;
}

/**
 * Runs profile extraction off the request path. The AI service pseudonymizes
 * before any LLM call (and falls back to a safe mock if it is down), so this
 * never sends raw PII anywhere. Emits profile.extraction_completed on success
 * and profile.extraction_failed on terminal failure — keeping async outcomes in
 * the event stream. In-process for Phase 1; splittable to its own worker later.
 */
@Processor(PROFILE_EXTRACTION_QUEUE)
export class ProfileExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(ProfileExtractionProcessor.name);

  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly aiJobs: AiJobsRepository,
    private readonly chat: ChatRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
  ) {
    super();
  }

  async process(job: Job<ProfileExtractionJobData>): Promise<{ profile_id: string }> {
    const { workerId, sessionId, aiJobId, correlationId, requestId } = job.data;

    // Idempotency: if a prior attempt already completed (e.g. BullMQ stalled-job
    // redelivery), don't reprocess or create a duplicate profile — return the
    // profile_id the previous run recorded.
    const existing = await this.aiJobs.findById(aiJobId);
    const existingProfileId = (existing?.outputRef as { profile_id?: string } | null)?.profile_id;
    if (existing?.status === "completed" && existingProfileId) {
      this.logger.log(`extraction job ${aiJobId} already completed; skipping reprocess`);
      return { profile_id: existingProfileId };
    }

    try {
      await this.aiJobs.markRunning(aiJobId);

      // Both shapes of the same conversation, deliberately. `transcript` is the
      // flat both-directions blob the model reads (and the rollback lever — drop
      // `messages` and the AI service behaves exactly as it did before the split).
      // `messages` carries the per-line role so the AI service's deterministic
      // detector can read the WORKER's lines only; on the flat blob it read our
      // own question text as the worker's answers.
      const messages = await this.buildMessages(sessionId);
      const transcript = this.renderTranscript(messages);
      const result = await this.ai.extractProfile({ worker_ref: workerId, transcript, messages });
      const profile: DraftProfile = result.profile;
      const profileStatus = result.blocked ? "draft" : "extracted";
      const aiMeta = result.ai_metadata; // operational usage/cost (null on the mock/AI-down path)

      const saved = await this.profiles.create({
        workerId,
        // Ties the profile to this job so a partial-success retry returns the
        // existing row instead of orphaning a duplicate (TD14).
        aiJobId,
        profileStatus,
        canonicalTradeId: profile.canonical_trade_id,
        canonicalRoleId: profile.canonical_role_id,
        skills: profile.skills,
        // B-6: stamp the taxonomy version in force at this skills WRITE (ADR-0030
        // §c "versioned"). Write-path only — reads never touch it; older rows
        // honestly carry NULL ("written before versioning").
        taxonomyVersion: String(SKILL_TAXONOMY_VERSION),
        machines: profile.machines,
        experience: profile.experience,
        salaryExpectation: profile.salary_expectation,
        locationPreference: profile.location_preference,
        availability: profile.availability,
        rawProfile: profile,
        // Issue #419 — persist the RICH draft the response has always carried. Before
        // this, apps/api read only `result.profile` (the narrow legacy DraftProfile) and
        // silently dropped controllers, education, certifications, the current-vs-expected
        // salary split, availability and current_city/current_state — every answer the
        // interview collected beyond the legacy shape. `?? null` because the field is
        // nullable in the contract (the mock/AI-down path returns none), and NULL is the
        // honest value for "this extraction produced no rich draft".
        richProfileDraft: result.worker_profile_draft ?? null,
      });

      await this.aiJobs.markCompleted(aiJobId, { profile_id: saved.id }, toAiJobUsage(aiMeta));

      await this.events.emit({
        event_name: "profile.extraction_completed",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "profile", subject_id: saved.id },
        payload: {
          worker_id: workerId,
          profile_id: saved.id,
          ai_job_id: aiJobId,
          profile_status: profileStatus,
          field_count: this.countFields(profile),
        },
        // Exactly one completion per job, even under BullMQ stalled-job
        // redelivery that races past the early-return idempotency guard above.
        idempotencyKey: `profile.extraction_completed:${aiJobId}`,
        correlationId,
        requestId,
      });

      // Record AI usage/cost on the dedicated observability event. Guarded: an
      // observability emit must never turn a SUCCESSFUL extraction into a failure.
      await this.recordAiCost(aiMeta, aiJobId, correlationId, requestId);

      // TD27: if the gateway BLOCKED a real call because a spend cap / circuit
      // breaker tripped, surface it on its own observability event (in addition
      // to the cost record above, which is unchanged). Same guarded, fire-and-
      // forget pattern — a cap signal must never fail the extraction.
      await this.recordSpendCap(aiMeta, aiJobId, correlationId, requestId);

      return { profile_id: saved.id };
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 256);
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

      // Only record the terminal failure once (BullMQ retries before this).
      if (isFinalAttempt) {
        await this.aiJobs.markFailed(aiJobId, reason);
        await this.events.emit({
          event_name: "profile.extraction_failed",
          actor: { actor_type: "system" },
          subject: { subject_type: "ai_job", subject_id: aiJobId },
          payload: { worker_id: workerId, session_id: sessionId, ai_job_id: aiJobId, reason },
          // One terminal failure per job (final attempt). Shares the key namespace
          // with the enqueue-failure emit in ProfilesService — mutually exclusive.
          idempotencyKey: `profile.extraction_failed:${aiJobId}`,
          correlationId,
          requestId,
        });
      }
      this.logger.warn(`extraction job ${aiJobId} failed (attempt ${job.attemptsMade + 1}): ${reason}`);
      throw err; // rethrow so BullMQ records/retries the failure
    }
  }

  /**
   * Emit the dedicated `ai.cost_recorded` observability event for a completed
   * job. No-ops on the mock/AI-down path (no metadata = no real call to record),
   * and swallows any emit/validation error so it can never fail the extraction.
   * Carries operational fields only — never prompts, completions, or PII.
   */
  private async recordAiCost(
    meta: AICallMetadata | null,
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
          task_type: "profile_extraction",
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
        // One cost record per job — dedups if a redelivery re-emits after the
        // completion guard is bypassed.
        idempotencyKey: `ai.cost_recorded:${aiJobId}`,
        correlationId,
        requestId,
      });
    } catch (err) {
      this.logger.warn(`ai.cost_recorded emit failed for job ${aiJobId} (non-fatal): ${String(err)}`);
    }
  }

  /**
   * Emit `ai.spend_cap_exceeded` when the AI gateway refused a real call because
   * a TD27 cap / circuit breaker tripped (`ai_metadata.error_code` is one of the
   * five block codes). No-ops on the mock/AI-down path and on any non-cap
   * error_code, and swallows any emit/validation error so it can never fail the
   * extraction. Carries operational fields only — never prompts/completions/PII.
   */
  private async recordSpendCap(
    meta: AICallMetadata | null,
    aiJobId: string,
    correlationId: string,
    requestId: string,
  ): Promise<void> {
    if (!meta) return;
    const reason = asSpendCapReason(meta.error_code);
    if (!reason) return;
    try {
      await this.events.emit({
        event_name: "ai.spend_cap_exceeded",
        actor: { actor_type: "ai_service" },
        subject: { subject_type: "ai_job", subject_id: aiJobId },
        payload: {
          ai_call_id: meta.ai_call_id,
          ai_job_id: aiJobId,
          task_type: "profile_extraction",
          model: meta.model_name || "unknown",
          provider: meta.provider || "unknown",
          reason,
          real_call: meta.real_call,
        },
        // One cap record per job — dedups if a redelivery re-emits after the
        // completion guard is bypassed (mirrors ai.cost_recorded).
        idempotencyKey: `ai.spend_cap_exceeded:${aiJobId}`,
        correlationId,
        requestId,
      });
    } catch (err) {
      this.logger.warn(
        `ai.spend_cap_exceeded emit failed for job ${aiJobId} (non-fatal): ${String(err)}`,
      );
    }
  }

  /**
   * The conversation as role-tagged lines. `inbound` is the worker; everything
   * else is us. Same `bodyText` filter the flat transcript has always used, so
   * the two shapes always describe the same set of lines.
   */
  private async buildMessages(sessionId: string | null): Promise<ConversationMessage[]> {
    if (!sessionId) return [];
    const messages = await this.chat.listMessages(sessionId);
    return messages
      .filter((m) => m.bodyText)
      .map((m) => ({
        role: m.direction === "inbound" ? ("worker" as const) : ("assistant" as const),
        text: m.bodyText as string,
      }));
  }

  /**
   * Renders the role-tagged lines back into the exact flat string this processor
   * has always sent. Byte-identical to the old `buildTranscript`, including the
   * "(no conversation captured)" placeholder — the AI service still gates and
   * prompts on this, so it must not drift.
   */
  private renderTranscript(messages: ConversationMessage[]): string {
    const text = messages
      .map((m) => `${m.role === "worker" ? "Worker" : "Bada Bhai"}: ${m.text}`)
      .join("\n");
    return text || "(no conversation captured)";
  }

  private countFields(p: DraftProfile): number {
    let n = 0;
    if (p.canonical_role_id) n += 1;
    if (p.canonical_trade_id) n += 1;
    n += p.skills.length;
    n += p.machines.length;
    if (p.experience.total_years != null) n += 1;
    if (p.salary_expectation.amount_min != null || p.salary_expectation.amount_max != null) n += 1;
    if (p.location_preference.preferred_cities.length) n += 1;
    if (p.availability.status !== "unknown") n += 1;
    return n;
  }
}

/**
 * Map the AI router's `ai_metadata` to the PII-free operational columns stored on
 * the `ai_jobs` row. Returns `undefined` when there is no metadata (mock/AI-down),
 * leaving the columns null. Only usage/cost scalars are forwarded.
 */
function toAiJobUsage(meta: AICallMetadata | null): AiJobUsageMetadata | undefined {
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
