import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { DraftProfile } from "@badabhai/ai-contracts";
import { EventsService } from "../events/events.service";
import { AiService } from "../ai/ai.service";
import { ChatRepository } from "../chat/chat.repository";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import {
  PROFILE_EXTRACTION_QUEUE,
  type ProfileExtractionJobData,
} from "../queue/queue.constants";

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

      const transcript = await this.buildTranscript(sessionId);
      const result = await this.ai.extractProfile({ worker_ref: workerId, transcript });
      const profile: DraftProfile = result.profile;
      const profileStatus = result.blocked ? "draft" : "extracted";

      const saved = await this.profiles.create({
        workerId,
        profileStatus,
        canonicalTradeId: profile.canonical_trade_id,
        canonicalRoleId: profile.canonical_role_id,
        skills: profile.skills,
        machines: profile.machines,
        experience: profile.experience,
        salaryExpectation: profile.salary_expectation,
        locationPreference: profile.location_preference,
        availability: profile.availability,
        rawProfile: profile,
      });

      await this.aiJobs.markCompleted(aiJobId, { profile_id: saved.id });

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
        correlationId,
        requestId,
      });

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
          correlationId,
          requestId,
        });
      }
      this.logger.warn(`extraction job ${aiJobId} failed (attempt ${job.attemptsMade + 1}): ${reason}`);
      throw err; // rethrow so BullMQ records/retries the failure
    }
  }

  private async buildTranscript(sessionId: string | null): Promise<string> {
    if (!sessionId) return "(no conversation captured)";
    const messages = await this.chat.listMessages(sessionId);
    const text = messages
      .filter((m) => m.bodyText)
      .map((m) => `${m.direction === "inbound" ? "Worker" : "Bada Bhai"}: ${m.bodyText}`)
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
