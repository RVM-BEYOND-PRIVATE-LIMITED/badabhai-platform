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
import { hasExtractedContent, type ProfileContentFields } from "./profile-content";
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
      // Issue #419 — the RICH draft the response has always carried (persisted below).
      // HOISTED out of the `create()` call because the profile_status decision reads it
      // too: the legacy columns are a strict SUBSET of what an extraction produces, so
      // judging content on them alone would demote a real TD94 extraction to "draft".
      const richProfileDraft = result.worker_profile_draft ?? null;
      const profileStatus = this.decideProfileStatus(result.blocked, profile, richProfileDraft);
      // T3: make the degraded case VISIBLE rather than silently successful. The
      // `blocked` leg is already an expected, documented outcome (pseudonymization
      // failing closed) and has always been recorded as "draft" without comment; a
      // NOT-blocked extraction that nonetheless produced nothing is the interesting
      // one — it is what an unreachable ai-service looks like from in here. Opaque job
      // id only, never transcript/PII (§2 no-PII-in-logs).
      if (profileStatus === "draft" && !result.blocked) {
        this.logger.warn(
          `extraction job ${aiJobId} produced NO extracted content; recorded as "draft" ` +
            `(re-extractable) instead of "extracted" — check ai-service reachability`,
        );
      }
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
        richProfileDraft,
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
   * The `profile_status` decision — and the ONE place a FABRICATED extraction is
   * stopped from being recorded as truth (TD81 / T3, the audit's "skill_ids:[]
   * passes silently" gap).
   *
   * THE DEFECT. When the ai-service is unreachable, `AiService.extractProfile`
   * FABRICATES a result — `DraftProfileSchema.parse({})` (null canonical ids, empty
   * skills/machines, null total_years, availability "unknown") carrying
   * `blocked: false` — so the worker's flow keeps moving. This used to read
   * `result.blocked ? "draft" : "extracted"`, consulting ONLY that flag and never the
   * CONTENT, so the fabrication was stamped "extracted": the status that means "this
   * worker is profiled". Paired with `ChatService.autoTriggerExtraction` skipping on
   * any existing profile ROW, that empty row became the worker's PERMANENT profile —
   * no later turn and no re-completed interview ever replaced it.
   *
   * THIS FIX IS ABOUT RECORDING, NOT FAILING. The AI-down path still does not throw
   * and still does not block anyone — the same deliberate posture job-postings holds
   * ("an AI-service outage NEVER blocks the posting"). The profile row is still
   * created, the ai_job is still marked `completed`, `profile.extraction_completed` is
   * still emitted, and the chat turn that triggered this is untouched. Only the STATUS
   * changes: an extraction that produced nothing is recorded as "draft" — the column's
   * schema default, and the very status the fail-closed `blocked` leg has always
   * used — which is the honest value for "we have no profile for this worker yet"
   * and, being not-"extracted", is what lets the session self-heal later.
   *
   * NO EVENT PAYLOAD CHANGES (invariant #8). `ProfileExtractionCompletedPayload`
   * (packages/event-schema/src/payloads.ts) already types `profile_status` as
   * `z.enum(["draft","extracting","extracted","confirmed"])` and "draft" is already
   * emitted on the blocked leg, so this is a different VALUE of a shipped field, not a
   * new or altered field. `field_count` keeps using `countFields` unchanged.
   *
   * WHY CONTENT AND NOT `is_mock` — the candidate mechanism deliberately REJECTED.
   * `is_mock` is a REACHABILITY probe, not a content signal: the ai-service sets it as
   * `is_mock = not meta.real_call` (apps/ai-service/app/main.py:810), so it is true
   * for the AI-down fabrication AND for every perfectly good deterministic extraction
   * while `AI_ENABLE_REAL_CALLS=false` — which is the COMMITTED DEFAULT (CLAUDE.md §2
   * invariant 5) and precisely the posture TD81 records staging as running in. Keying
   * profile_status off it would mean NO worker ever reaches "extracted" outside a
   * real-provider environment, breaking the Phase-1 exit criteria. That is the same
   * trap `profile-content.ts` already documents for `ai_jobs.real_call`, rejected here
   * for identical reasons.
   *
   * WHY `hasExtractedContent` AND NOT `countFields > 0`. `countFields` counts only the
   * canonical/legacy columns, a strict SUBSET of what an extraction produces — the
   * skill labels and the rest live in the rich draft and are counted by nothing. A
   * REAL extraction the gazetteer could not canonicalize (TD94: a plain "CNC
   * operator") scores 0 there while genuinely carrying content, and demoting THAT to
   * "draft" would make a good profile look unprofiled. `hasExtractedContent` is the
   * codebase's existing answer to "did this extraction extract anything?" (issue #420,
   * PRs #430/#438) and is ALREADY the predicate `ProfilesService.extract` dedupes on.
   * Reusing it — over the row projection this processor is about to WRITE — gives that
   * question exactly ONE definition, so the status stamped here and the dedupe/retry
   * decision taken later can never drift apart and disagree about the same row.
   */
  private decideProfileStatus(
    blocked: boolean,
    profile: DraftProfile,
    richProfileDraft: unknown,
  ): "draft" | "extracted" {
    // Unchanged first leg: pseudonymization failed closed upstream, so there is no
    // extraction to judge. Kept ahead of the content check so a blocked result is
    // never re-litigated on content it was never allowed to produce.
    if (blocked) return "draft";

    // The row as `ProfilesRepository`/`WorkersRepository.latestProfile` will hand it
    // back, assembled from the exact values `create()` writes below — so this reads
    // the profile the way every later reader does, not a parallel notion of it.
    const asPersisted: ProfileContentFields = {
      canonicalTradeId: profile.canonical_trade_id,
      canonicalRoleId: profile.canonical_role_id,
      skills: profile.skills,
      machines: profile.machines,
      experience: profile.experience,
      salaryExpectation: profile.salary_expectation,
      locationPreference: profile.location_preference,
      availability: profile.availability,
      richProfileDraft,
    };
    return hasExtractedContent(asPersisted) ? "extracted" : "draft";
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
